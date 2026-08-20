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
import { logger } from './logger.js';
import {
    cleanupHandleWorkspaces,
    computeStructuralFingerprint,
    createHandleWorkspace,
    discardHandleWorkspace,
    getReadHandleStore,
    isHandleRuntimeActive,
    isWorkspaceDirtyOnDisk,
    noteWorkspaceExpiry,
    setResultHandle,
    setResultWarning,
    syncRuntimeBinding,
} from './handleRuntime.js';

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
    setResultHandle(issued.readHandle, issued.expiresAt);
    if (context.transport === 'stdio') {
        // Connection-pinned implicit state. HTTP deliberately gets none.
        store.setImplicit(issued.readHandle, { key: implicitKey(documentId, tabId) });
    }
    return {
        readHandle: issued.readHandle,
        expiresAt: issued.expiresAt,
        editablePath: created.editablePath,
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
        async requireReread(reason) { requireRereadBeforeMutation(documentId, reason); },
    });
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
 * @returns {Promise<{active:boolean, revisionId:string|null, writeControl:object|undefined,
 *   complete(newRevisionId?:string):Promise<void>, fail():Promise<void>}>}
 */
export async function beginDocsMutation(documentId, {
    tabId = null, readHandle = null, expectedRevisionId = null, legacyGuard = null,
} = {}) {
    if (!isHandleRuntimeActive()) {
        if (legacyGuard) await legacyGuard();
        return legacyLease(documentId);
    }

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
    return makeLease({
        active: true,
        revisionId: record.revisionId,
        // The WriteControl value always comes from the validated record, never
        // from caller input (plan §2).
        writeControlFor() {
            return record.revisionId ? { requiredRevisionId: record.revisionId } : undefined;
        },
        readHandleRecord: record,
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
