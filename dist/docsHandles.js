// Docs-specific integration between the tools and the read-handle capability.
//
// This module is the single decision point for "which guard is in force":
//
//   * No ambient request context (every direct unit test that calls a tool's
//     execute() itself, and internal callers outside a transport) -> the
//     historical readTracker guard runs exactly as before. Nothing in this
//     module changes that path.
//   * An ambient request context (the runtime, dist/mcpServer.js) -> the
//     explicit `readHandle` capability is the guard. readTracker's no-context
//     namespace is deliberately NOT consulted there: it is shared by every
//     caller that has no context, which is precisely the cross-request state
//     the 2026-07-28 migration removes.
//
// See docs/plans/mcp-2026-07-28-migration.md §2 and §3.
import { z } from 'zod';
import { publicError } from './errors.js';
import { ReadHandleError } from './readHandles.js';
import { getRequestContext } from './requestContext.js';
import { getLastReadRevisionId, requireRereadBeforeMutation, trackMutation } from './readTracker.js';
import { textSearchFields } from './googleDocsApiHelpers.js';
import { logger } from './logger.js';
import {
    cleanupHandleWorkspaces,
    computeStructuralFingerprint,
    createHandleWorkspace,
    discardHandleWorkspace,
    getReadHandleStore,
    getWorkspaceProjection,
    isHandleRuntimeActive,
    isWorkspaceDirtyOnDisk,
    noteWorkspaceExpiry,
    setResultHandle,
    setResultWarning,
    setWorkspaceProjection,
    syncRuntimeBinding,
} from './handleRuntime.js';
import {
    CHANGE_STATUS,
    REJECTION_TIER,
    captureDocsProjection,
    classifyDocumentChange,
    classifyTargetAgainstChange,
    describeRejection,
    renderProjectionDiff,
} from './docsChangePrecision.js';

const HANDLE_REQUIRED_MESSAGE =
    'This edit requires a readHandle. Call readDocument for this document (and tab) first, ' +
    'then pass the readHandle value it returned. A revision id alone cannot authorize a write.';

/**
 * The `readHandle` input every guarded Docs mutation declares.
 *
 * Optional at the schema level on purpose: the stdio transport and direct
 * internal callers both have valid flows that never supply one, and making it
 * schema-required would reject those requests at parse time. Requiredness is a
 * runtime property of the HTTP path, enforced in `beginDocsMutation`.
 */
export const ReadHandleParameter = z
    .string()
    .optional()
    .describe('Capability returned by a previous readDocument call for this document (and tab). ' +
        'Required over HTTP on the 2026-07-28 runtime: it authorizes the write and pins it to the ' +
        'revision that read saw. Omit it on stdio to use that connection\'s most recent read.');

/** Per-document/tab implicit slot, so two stdio reads never clobber each other. */
function implicitKey(documentId, tabId) {
    return `docs:${documentId}:${tabId ?? ''}`;
}

function expectationFor(documentId, tabId) {
    return {
        resourceKind: 'docs',
        resourceId: documentId,
        scope: tabId ? 'tab' : 'document',
        tabId: tabId ?? null,
    };
}

// ReadHandleError messages come from a curated SAFE_MESSAGES table in
// readHandles.js, so they are already caller-safe; re-throw them through the
// public-error boundary rather than letting the facade redact them to a generic
// failure the caller cannot act on.
function asPublic(error) {
    if (error instanceof ReadHandleError) return publicError(error.message);
    return error;
}

// Every discardHandleWorkspace() call inside complete() below runs strictly
// AFTER the Google write has already committed (and, for the predecessor,
// after the store has already terminalized its handle). A cleanup failure at
// that point is never allowed to read as "the write failed" -- it is logged
// server-side (redacted by the logger) and reported to the caller as a
// non-fatal warning instead of being left to propagate. The workspace is
// deliberately left registered in ownedWorkspaces when this happens (nothing
// upstream of the throw removes it), so a later cleanup/shutdown pass can
// still find and retry it -- see dist/handleRuntime.js discardHandleWorkspace.
async function safeDiscardWorkspace(workspaceId, { context: label }) {
    try {
        await discardHandleWorkspace(workspaceId);
        return true;
    } catch (error) {
        logger.warn(
            `[docsHandles] failed to discard handle workspace after a committed write (${label}); ` +
            'it remains registered for a later cleanup pass to retry:',
            error?.message || error,
        );
        return false;
    }
}

/**
 * Mint a read handle for a successful Docs read. No-op (returns null) off the
 * v2 runtime.
 *
 * @param {object} input
 * @param {string} input.documentId
 * @param {string|null} [input.tabId]
 * @param {string|null} [input.revisionId] Docs `revisionId` from this read.
 * @param {object} input.contentSource Document/fragment to fingerprint.
 * @param {string} input.content Exact bytes to seed the editable workspace with.
 * @returns {Promise<null|{readHandle:string, expiresAt:number, editablePath:string, structuralFingerprint:string}>}
 */
export async function mintDocsReadHandle({ documentId, tabId = null, revisionId = null, contentSource, content }) {
    if (!isHandleRuntimeActive()) return null;
    const context = getRequestContext();
    const store = getReadHandleStore();
    syncRuntimeBinding(context);
    // Bounded, timer-free expiry pass. Doing it on mint keeps the runtime free
    // of background intervals (which would otherwise hold the process open).
    await cleanupHandleWorkspaces();

    const structuralFingerprint = computeStructuralFingerprint(contentSource, { tabId });
    const created = await createHandleWorkspace({
        profile: context.profile,
        fileId: documentId,
        tabId,
        revisionId,
        fingerprint: structuralFingerprint,
        content,
    });
    let issued;
    try {
        issued = store.issue({
            ...expectationFor(documentId, tabId),
            revisionId: revisionId ?? null,
            structuralFingerprint,
            workspace: created.workspace,
        });
    } catch (error) {
        await discardHandleWorkspace(created.workspace.workspaceId);
        throw asPublic(error);
    }
    noteWorkspaceExpiry(created.workspace.workspaceId, issued.expiresAt);
    // The range-precision layer (#108) can only classify a later change against
    // what this read actually saw, so the read's text/structure projection is
    // captured here, at the one point where the document JSON is in hand. A
    // read whose field mask carried no indices (format='text') produces an
    // unavailable projection, which the classifier treats as "cannot classify"
    // rather than "nothing there".
    try {
        setWorkspaceProjection(
            created.workspace.workspaceId,
            captureDocsProjection(contentSource, { tabId }),
        );
    } catch { /* a projection is an optimization for later precision, never a read failure */ }
    setResultHandle(issued.readHandle, issued.expiresAt);
    if (context.transport === 'stdio') {
        // Connection-pinned implicit state. HTTP deliberately gets none.
        store.setImplicit(issued.readHandle, { key: implicitKey(documentId, tabId) });
    }
    return {
        readHandle: issued.readHandle,
        expiresAt: issued.expiresAt,
        editablePath: created.editablePath,
        backedUp: created.backedUp,
        backupPath: created.backupPath,
        structuralFingerprint,
    };
}

/**
 * Shared lease surface. `write` is the seam every guarded Docs mutation uses:
 * it hands the caller the WriteControl the guard authorized, then settles the
 * lease from the outcome. On the v2 path a failed write retains the handle's
 * dirty workspace instead of reclaiming it; on the legacy path it is the exact
 * `trackMutation` call the tool made before.
 */
function makeLease(lease) {
    // Assigned rather than spread so the legacy lease's lazy `revisionId` getter
    // still reads the tracker at access time, exactly as the tools did inline.
    lease.write = async function write(perform, extractRevision = () => undefined) {
        const writeControl = lease.writeControlFor();
        let response;
        try {
            response = await perform(writeControl);
        }
        catch (error) {
            await lease.fail();
            throw error;
        }
        await lease.complete(extractRevision(response));
        return response;
    };
    return lease;
}

function legacyLease(documentId) {
    return makeLease({
        active: false,
        get revisionId() { return getLastReadRevisionId(documentId); },
        writeControlFor() {
            const revisionId = getLastReadRevisionId(documentId);
            return revisionId ? { requiredRevisionId: revisionId } : undefined;
        },
        async complete(newRevisionId) { trackMutation(documentId, newRevisionId); },
        async fail() {},
        async abort() {},
        async requireReread(reason) { requireRereadBeforeMutation(documentId, reason); },
        // Range precision is a v2-only capability, and deliberately so: on the
        // legacy path the document-scoped `readTracker` guard has ALREADY run
        // (it is the `legacyGuard` callback above) and it has no per-request
        // read record to compare a range against. Re-implementing classification
        // on top of the shared no-context tracker would mean deciding "did this
        // change touch your range" from state another caller may have written.
        // So the legacy lease passes targets straight through, unchanged and
        // un-re-resolved, exactly as these tools behaved before #108.
        async guardTargets({ targets = [] } = {}) {
            return {
                changed: false,
                classified: false,
                revisionId: getLastReadRevisionId(documentId),
                snapshot: null,
                targets: normalizeTargets(targets),
            };
        },
    });
}

/**
 * The two fetches `guardTargets` can make on behalf of a tool that does not
 * already hold a snapshot, in one place so all four Docs writers ask Google for
 * the same thing.
 *
 * `fetchSnapshot` deliberately uses `textSearchFields`: it is the mask
 * `findTextRangeInDoc` needs for re-resolution AND the mask the change
 * classifier needs for its text/structure projection, so one fetch serves both.
 *
 * @param {object} docs Docs API client.
 * @param {string} documentId
 * @param {string|null} tabId
 */
export function docsSnapshotFetchers(docs, documentId, tabId) {
    return {
        fetchRevisionId: async () => {
            const probe = await docs.documents.get({ documentId, fields: 'revisionId' });
            return probe?.data?.revisionId ?? null;
        },
        fetchSnapshot: async () => {
            const snapshot = await docs.documents.get({
                documentId,
                includeTabsContent: !!tabId,
                fields: `revisionId,${textSearchFields(tabId)}`,
            });
            return { document: snapshot?.data, revisionId: snapshot?.data?.revisionId ?? null };
        },
    };
}

/** Coerce one target or a list of them into the internal array form. */
function normalizeTargets(targets) {
    const list = Array.isArray(targets) ? targets : (targets ? [targets] : []);
    return list.map((target, position) => ({
        kind: target.kind === 'semantic' ? 'semantic' : 'explicit',
        startIndex: target.startIndex,
        endIndex: target.endIndex,
        label: target.label ?? null,
        describe: target.describe ?? null,
        position,
    }));
}

/**
 * Open a guarded Docs mutation.
 *
 * Legacy runtime: runs `legacyGuard` (the tool's existing `guardMutation` call,
 * where it had one) and hands back the tracked revision, unchanged.
 *
 * v2 runtime: requires a validated capability. HTTP must supply `readHandle`
 * explicitly; a stdio connection may fall back to its own pinned implicit state.
 * The `WriteControl.requiredRevisionId` always comes from the validated record,
 * never from caller input — `expectedRevisionId` is only a compare-and-write
 * assertion that must agree with the record.
 *
 * ### Range precision (#108)
 *
 * The lease additionally exposes `guardTargets(...)`, the seam that turns the
 * document-scoped guard above into a range-scoped one. A tool that knows which
 * range it is about to edit calls it with that range and a snapshot of the
 * document as it is NOW; the guard classifies whether the change between the
 * read and now could have affected that range, and either
 *
 *   * permits it and RE-ARMS this lease from the same snapshot (the returned
 *     targets carry re-resolved indices and `writeControlFor()` starts
 *     returning the snapshot's revision, so the write can never go out against
 *     the stale handle revision), or
 *   * rejects it with an explanation naming what changed, where confidence
 *     ended, and which read workflow recovers.
 *
 * `targetRange`/`reresolve`/`fetchSnapshot` here are the same call made for
 * you, for a tool whose target is fully known before it fetches anything.
 *
 * @returns {Promise<{active:boolean, revisionId:string|null, writeControl:object|undefined,
 *   guardTargets(options:object):Promise<object>,
 *   complete(newRevisionId?:string):Promise<void>, fail():Promise<void>}>}
 */
export async function beginDocsMutation(documentId, {
    tabId = null, readHandle = null, expectedRevisionId = null, legacyGuard = null,
    targetRange = null, reresolve = null, fetchSnapshot = null, fetchRevisionId = null,
} = {}) {
    if (!isHandleRuntimeActive()) {
        if (legacyGuard) await legacyGuard();
        return legacyLease(documentId);
    }
    const lease = await openV2Lease(documentId, { tabId, readHandle, expectedRevisionId });
    if (targetRange) {
        try {
            await lease.guardTargets({ targets: targetRange, reresolve, fetchSnapshot, fetchRevisionId });
        } catch (error) {
            // guardTargets already released the reservation on a classified
            // rejection; this covers the snapshot fetch itself failing, where
            // the handle is still untouched and must survive for the retry.
            await lease.abort();
            throw error;
        }
    }
    return lease;
}

async function openV2Lease(documentId, { tabId, readHandle, expectedRevisionId }) {

    const context = getRequestContext();
    const store = getReadHandleStore();
    syncRuntimeBinding(context);
    const expected = expectationFor(documentId, tabId);

    let capability;
    try {
        if (typeof readHandle === 'string' && readHandle.length > 0) {
            capability = readHandle;
        } else if (context.transport === 'stdio') {
            capability = store.resolveImplicitCapability({ key: implicitKey(documentId, tabId), expected }).readHandle;
        } else {
            throw publicError(HANDLE_REQUIRED_MESSAGE);
        }
    } catch (error) {
        if (error instanceof ReadHandleError && error.code === 'READ_HANDLE_REQUIRED') {
            throw publicError(HANDLE_REQUIRED_MESSAGE);
        }
        throw asPublic(error);
    }

    let lease;
    try {
        lease = store.beginMutation(capability, { expected });
    } catch (error) {
        throw asPublic(error);
    }

    const record = lease.record;
    if (expectedRevisionId != null && expectedRevisionId !== record.revisionId) {
        try { store.abortBeforeWrite(lease.operationId); } catch { /* keep the original failure */ }
        throw publicError(
            `expectedRevisionId "${expectedRevisionId}" does not match the revision this read handle was issued ` +
            `for. Read the document again and retry against its current revision.`,
        );
    }

    // Record whether the caller edited the editable copy before the write. If
    // the write then fails, readHandles.js retains that dirty file for recovery
    // instead of reclaiming it.
    let workspaceId = null;
    try {
        workspaceId = store.getInternalWorkspace(capability)?.workspaceId ?? null;
        if (workspaceId && await isWorkspaceDirtyOnDisk(workspaceId)) {
            store.markWorkspaceDirty(capability, true);
        }
    } catch { /* workspace bookkeeping must never block a validated write */ }

    let settled = false;
    // The revision this lease authorizes. It starts as the validated record's
    // and only ever moves through `guardTargets`, which advances it to a
    // snapshot it has just proven cannot affect the caller's target — the
    // "atomic re-arm" of plan §Implementation step 1.
    let effectiveRevisionId = record.revisionId ?? null;
    return makeLease({
        active: true,
        // A live getter, not a copy: `replaceRangeWithMarkdown` reads
        // `lease.revisionId` to seed its WriteControl chain, and a re-armed
        // lease must hand it the re-armed revision.
        get revisionId() { return effectiveRevisionId; },
        // The WriteControl value always comes from the validated record or from
        // a snapshot this guard itself fetched and classified — never from
        // caller input (plan §2).
        writeControlFor() {
            return effectiveRevisionId ? { requiredRevisionId: effectiveRevisionId } : undefined;
        },
        readHandleRecord: record,

        /**
         * Range-precise conflict check plus atomic re-arm (#108).
         *
         * @param {object} options
         * @param {object|object[]} options.targets `{startIndex, endIndex?, kind, describe?}`.
         *   `kind: 'semantic'` means the target came from a text/heading anchor
         *   and can be resolved again; anything else is an explicit index.
         * @param {object} [options.snapshot] `{document, revisionId}` the caller
         *   already fetched. Passing the caller's own snapshot (rather than
         *   making the guard fetch a second one) is what keeps "what the guard
         *   classified" and "what the caller resolved against" the same bytes.
         * @param {function} [options.fetchSnapshot] Used when no snapshot is supplied.
         * @param {function} [options.reresolve] `(snapshot) => target|target[]|null`,
         *   positionally aligned with `targets`. Required for semantic targets
         *   on a changed document; returning null means "no unique match".
         * @returns {Promise<{changed:boolean, classified:boolean, revisionId:string|null,
         *   snapshot:object|null, targets:object[]}>}
         */
        async guardTargets({
            targets = [], snapshot = null, fetchSnapshot = null, fetchRevisionId = null, reresolve = null,
        } = {}) {
            const normalized = normalizeTargets(targets);
            const priorRevisionId = record.revisionId ?? null;
            const unchangedResult = (current) => ({
                changed: false,
                classified: false,
                revisionId: effectiveRevisionId,
                snapshot: current ?? null,
                targets: normalized,
            });
            // Nothing to be precise about: the write stays protected by the
            // document-scoped WriteControl exactly as it was before #108.
            if (normalized.length === 0) return unchangedResult(snapshot);

            // Revision equality is the cheap proof that nothing happened — a
            // Docs revision advances on every change — so a caller with no
            // snapshot in hand can offer a `revisionId`-only probe and skip
            // fetching the document at all on the overwhelmingly common path.
            if (!snapshot && typeof fetchRevisionId === 'function') {
                const probed = await fetchRevisionId();
                if (priorRevisionId && probed && probed === priorRevisionId) return unchangedResult(null);
            }
            const current = snapshot ?? (typeof fetchSnapshot === 'function' ? await fetchSnapshot() : null);
            if (!current || !current.document) {
                // A programming error in a caller, not a caller-facing failure:
                // it never reaches the transport as a public message.
                throw new Error('guardTargets requires a snapshot ({document, revisionId}) or a fetchSnapshot callback.');
            }
            const currentRevisionId = current.revisionId ?? null;
            if (priorRevisionId && currentRevisionId && priorRevisionId === currentRevisionId) {
                return unchangedResult(current);
            }

            const after = captureDocsProjection(current.document, { tabId });
            const before = getWorkspaceProjection(workspaceId);
            const change = classifyDocumentChange(before, after, { revisionMoved: true });

            // Re-resolution runs BEFORE any verdict and against this exact
            // snapshot, so a permitted target is never authorized on one
            // document state and written against another.
            let reresolved = null;
            if (typeof reresolve === 'function' && normalized.some((target) => target.kind === 'semantic')) {
                reresolved = await reresolve(current);
            }
            const withResolution = normalized.map((target, position) => {
                if (target.kind !== 'semantic') return target;
                const candidate = Array.isArray(reresolved) ? reresolved[position] : (position === 0 ? reresolved : null);
                const usable = candidate && Number.isInteger(candidate.startIndex) ? candidate : null;
                return { ...target, resolved: usable };
            });

            const diff = renderProjectionDiff(before, after, `document ${documentId}`);
            for (const target of withResolution) {
                const verdict = target.kind === 'semantic' && !target.resolved
                    && change.status !== CHANGE_STATUS.UNCHANGED
                    ? { permitted: false, tier: REJECTION_TIER.AMBIGUOUS }
                    : classifyTargetAgainstChange(target, change);
                if (verdict.permitted) continue;
                // Nothing was written, and the handle is not to blame — release
                // the reservation so it is not left stuck `reserved`.
                await this.abort();
                throw publicError(describeRejection({
                    tier: verdict.tier,
                    change,
                    target,
                    diff,
                    revisionFrom: priorRevisionId,
                    revisionTo: currentRevisionId,
                }));
            }

            // --- atomic re-arm -----------------------------------------------
            // Every target above is proven unaffected by this exact snapshot,
            // and every semantic one now carries indices resolved against it.
            // Advancing the authorized revision here, synchronously, in the same
            // step, is what makes those two facts inseparable: from this point
            // `writeControlFor()` returns the snapshot's revision, so the batch
            // cannot go out pinned to the stale handle revision, and
            // `complete()` still mints the successor from the revision the write
            // itself returns.
            if (currentRevisionId) effectiveRevisionId = currentRevisionId;
            return {
                changed: true,
                classified: true,
                revisionId: effectiveRevisionId,
                snapshot: current,
                targets: withResolution.map((target) => (target.resolved
                    ? { ...target, startIndex: target.resolved.startIndex, endIndex: target.resolved.endIndex }
                    : target)),
            };
        },

        async complete(newRevisionId) {
            if (settled) return;
            settled = true;
            const resolvedRevisionId = typeof newRevisionId === 'string' ? newRevisionId : null;
            // A successor workspace is required because the predecessor owned
            // one. It starts empty on purpose: we know the post-write revision,
            // but not the post-write content, and seeding it with pre-write
            // content would hand the caller a working copy that silently
            // reverts their own edit. Re-read to refill it.
            //
            // By the time complete() runs, the Google write has ALREADY
            // committed -- this call only exists to mint the next local
            // handle. So a failure here (disk full, permissions, temp I/O)
            // must never surface as "the write failed": it is caught rather
            // than left to propagate, and the predecessor is still
            // terminalized immediately below regardless. A committed write
            // consumes its handle unconditionally; whether a successor
            // workspace could be rebuilt is a separate, non-fatal concern.
            let successorWorkspace = null;
            try {
                successorWorkspace = await createHandleWorkspace({
                    profile: context.profile,
                    fileId: documentId,
                    tabId,
                    revisionId: resolvedRevisionId,
                    fingerprint: null,
                    content: '',
                });
            } catch { /* handled below: terminalize first, warn instead of throwing */ }

            // completeSuccess is the transition that terminalizes the
            // predecessor as consumed (vs. reserved/invalid) and (usually)
            // registers a successor, so it always runs here -- with a real
            // successor workspace when we have one, or an explicit
            // `workspace: null` when we don't. It can itself still throw
            // (any internal invariant -- capacity, a colliding id, a store
            // bug); that throw is caught below rather than letting it leave
            // the predecessor stuck `reserved`, since by this point the
            // Google write has ALREADY committed.
            let successor;
            try {
                successor = store.completeSuccess(lease.operationId, {
                    revisionId: resolvedRevisionId,
                    // The structure this handle was issued against no longer
                    // exists after our own write, so it is cleared rather
                    // than inherited.
                    structuralFingerprint: null,
                    workspace: successorWorkspace ? successorWorkspace.workspace : null,
                });
            } catch {
                // completeSuccess only mutates the store (registering a
                // successor, terminalizing the predecessor) after every
                // validation step above it succeeds, so a throw here means
                // the predecessor is still sitting `reserved` and, if
                // createHandleWorkspace built one, the successor workspace
                // was never handed to the store at all. The write already
                // committed regardless, so the predecessor must still end up
                // terminal: fall back to the store's other terminal
                // transition (best effort -- the write already committed
                // either way, so a failure here does not change what we tell
                // the caller).
                try { store.completeAfterWriteFailure(lease.operationId); }
                catch { /* best effort: the write already committed regardless */ }
                // Neither workspace will ever be discovered by anything else
                // from here: the successor was never registered with the
                // store, so it has no expiresAt and cleanupHandleWorkspaces's
                // expiry check can never match it (plan §3's cleanup only
                // ever consults ownedWorkspaces + expiresAt, never a glob);
                // and completeAfterWriteFailure's dirty-retention machinery
                // exists to protect a workspace whose content might still
                // need recovering after a genuine write failure, which does
                // not apply here since the write already landed. Reap both
                // explicitly instead of leaving either as a permanent orphan.
                if (successorWorkspace) {
                    await safeDiscardWorkspace(successorWorkspace.workspace.workspaceId, { context: 'never-registered successor' });
                }
                if (workspaceId) await safeDiscardWorkspace(workspaceId, { context: 'predecessor, after completeSuccess failure' });
                setResultWarning(
                    'Document write committed successfully, but the local read-handle bookkeeping could not ' +
                    'be finalized. Re-read the document before further edits.',
                );
                return;
            }
            let predecessorDiscarded = true;
            if (workspaceId) {
                predecessorDiscarded = await safeDiscardWorkspace(workspaceId, { context: 'predecessor, after successful completeSuccess' });
            }
            if (!predecessorDiscarded) {
                setResultWarning(
                    'Document write committed successfully, but a stale local workspace could not be removed ' +
                    'and will be retried by cleanup.',
                );
            }

            if (successorWorkspace) {
                noteWorkspaceExpiry(successorWorkspace.workspace.workspaceId, successor.expiresAt);
                setResultHandle(successor.readHandle, successor.expiresAt);
                if (context.transport === 'stdio') {
                    try {
                        store.setImplicit(successor.readHandle, { key: implicitKey(documentId, tabId) });
                    } catch (error) {
                        // The successor handle was already registered by
                        // completeSuccess and already handed back via
                        // setResultHandle above -- only this connection's
                        // stdio convenience slot (used when a later call omits
                        // readHandle) failed to update. Non-fatal: warn so the
                        // caller knows to pass the handle explicitly next time
                        // instead of silently resolving the stale predecessor.
                        logger.warn(
                            '[docsHandles] failed to update the stdio implicit read-handle slot after a ' +
                            'committed write:',
                            error?.message || error,
                        );
                        setResultWarning(
                            'Document write committed successfully and issued a new read handle, but this ' +
                            'connection\'s implicit handle could not be updated; pass readHandle explicitly ' +
                            'on the next edit.',
                        );
                    }
                }
            } else {
                // completeSuccess still had to mint a successor record to keep
                // the store's invariant (every successful mutation produces
                // exactly one), but a workspace-less handle has no editable
                // copy behind it and would be misleading to hand back as if it
                // were usable, so it is revoked immediately instead of
                // surfaced. The stdio implicit slot is deliberately left
                // pointing at the now-tombstoned predecessor capability: the
                // next call that resolves it implicitly gets the honest
                // "already consumed" error rather than silently reusing a
                // handle with nothing behind it.
                try { store.revoke(successor.readHandle); } catch { /* best effort */ }
                setResultWarning(
                    'Document write committed successfully, but no successor read handle could be issued ' +
                    '(the local workspace could not be created). Re-read the document before further edits.',
                );
            }
        },
        async fail() {
            if (settled) return;
            settled = true;
            try { store.completeAfterWriteFailure(lease.operationId); }
            catch { /* the caller is already throwing the real failure */ }
        },
        // Release the reservation WITHOUT consuming the handle, for a tool that
        // decides not to write after taking the lease: a dryRun, or a range that
        // fails validation before any request reaches Google. Without this the
        // record would stay `reserved` and the caller's next attempt — the
        // corrected one — would be rejected as an in-flight mutation even though
        // the document was never touched.
        async abort() {
            if (settled) return;
            settled = true;
            try { store.abortBeforeWrite(lease.operationId); }
            catch { /* the caller is already returning or throwing */ }
        },
        // A write whose resulting revision we cannot observe (the Apps Script
        // image path) leaves this handle unable to guard anything: terminalize
        // it so the next mutation must present a fresh read, which is the
        // capability equivalent of readTracker's requireRereadBeforeMutation.
        async requireReread() {
            if (settled) return;
            settled = true;
            try { store.completeAfterWriteFailure(lease.operationId); }
            catch { /* best effort */ }
        },
    });
}
