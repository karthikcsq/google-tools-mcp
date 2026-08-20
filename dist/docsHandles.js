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
        async abort() {},
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
            // A successor workspace is required because the predecessor owned
            // one. It starts empty on purpose: we know the post-write revision,
            // but not the post-write content, and seeding it with pre-write
            // content would hand the caller a working copy that silently
            // reverts their own edit. Re-read to refill it.
            const successorWorkspace = await createHandleWorkspace({
                profile: context.profile,
                fileId: documentId,
                tabId,
                revisionId: typeof newRevisionId === 'string' ? newRevisionId : null,
                fingerprint: null,
                content: '',
            });
            const successor = store.completeSuccess(lease.operationId, {
                revisionId: typeof newRevisionId === 'string' ? newRevisionId : null,
                // The structure this handle was issued against no longer exists
                // after our own write, so it is cleared rather than inherited.
                structuralFingerprint: null,
                workspace: successorWorkspace.workspace,
            });
            noteWorkspaceExpiry(successorWorkspace.workspace.workspaceId, successor.expiresAt);
            if (workspaceId) await discardHandleWorkspace(workspaceId);
            setResultHandle(successor.readHandle, successor.expiresAt);
            if (context.transport === 'stdio') {
                store.setImplicit(successor.readHandle, { key: implicitKey(documentId, tabId) });
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
