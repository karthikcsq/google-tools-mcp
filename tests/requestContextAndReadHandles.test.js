import { describe, expect, it } from '@jest/globals';
import {
    closeStdioConnection,
    createHttpRequestContext,
    createStdioConnectionContext,
    fingerprintCredential,
    getRequestContext,
    isCanonicalPrincipalFingerprint,
    runWithRequestContext,
} from '../dist/requestContext.js';
import { createReadHandleStore } from '../dist/readHandles.js';

const HMAC_KEY = Buffer.alloc(32, 0x5a);
const RAW_BEARER = 'Bearer raw-secret-that-must-never-be-retained';

function fingerprint(name = 'principal-A') {
    return fingerprintCredential(`Bearer ${name}`, { hmacKey: HMAC_KEY });
}

function httpContext(overrides = {}) {
    return createHttpRequestContext({
        principalFingerprint: fingerprint('principal-A'),
        profile: 'primary',
        epoch: 1,
        ...overrides,
    });
}

function stdioContext(overrides = {}) {
    return createStdioConnectionContext({
        principalFingerprint: fingerprint('principal-A'),
        profile: 'primary',
        epoch: 1,
        ...overrides,
    });
}

let workspaceSequence = 0;
function workspace(overrides = {}) {
    workspaceSequence += 1;
    return {
        workspaceId: `workspace-${workspaceSequence}`,
        ownershipManifest: `manifest-${workspaceSequence}`,
        editablePath: `private/workspace-${workspaceSequence}.md`,
        baselineId: `baseline-${workspaceSequence}`,
        dirty: false,
        ...overrides,
    };
}

function handleInput(overrides = {}) {
    return {
        resourceKind: 'docs',
        resourceId: 'document-A',
        scope: 'tab',
        tabId: 'tab-A',
        revisionId: 'revision-A',
        structuralFingerprint: 'structure-A',
        version: 7,
        workspace: workspace(),
        ...overrides,
    };
}

function caught(callback) {
    try {
        callback();
    }
    catch (error) {
        return error;
    }
    throw new Error('Expected callback to throw.');
}

function errorCode(callback) {
    return caught(callback).code;
}

describe('request context and read-handle core', () => {
    it('uses canonical HMAC-SHA256 fingerprints and requires a 32-byte HMAC key override', () => {
        const first = fingerprintCredential('credential-A', { hmacKey: HMAC_KEY });
        const again = fingerprintCredential('credential-A', { hmacKey: HMAC_KEY });
        const other = fingerprintCredential('credential-B', { hmacKey: HMAC_KEY });
        expect(first).toBe(again);
        expect(first).not.toBe(other);
        expect(first).toMatch(/^hmac-sha256:[A-Za-z0-9_-]{43}$/);
        expect(isCanonicalPrincipalFingerprint(first)).toBe(true);
        expect(isCanonicalPrincipalFingerprint('principal-A')).toBe(false);
        expect(() => fingerprintCredential('credential-A', { hmacKey: 'too-short' }))
            .toThrow(/at least 32 bytes/);
        expect(() => createHttpRequestContext({
            principalFingerprint: 'principal-A', profile: 'primary', epoch: 1,
        })).toThrow(/canonical hmac-sha256/);
    });

    it('has no ambient fallback and never permits HTTP implicit state', () => {
        const store = createReadHandleStore();
        const context = httpContext();
        expect(getRequestContext()).toBeUndefined();
        expect(errorCode(() => store.issue(handleInput()))).toBe('REQUEST_CONTEXT_REQUIRED');
        const issued = runWithRequestContext(context, () => store.issue(handleInput()));
        expect(errorCode(() => store.resolveImplicit({ context }))).toBe('READ_HANDLE_IMPLICIT_NOT_ALLOWED');
        expect(errorCode(() => store.setImplicit(issued.readHandle, { context }))).toBe('READ_HANDLE_IMPLICIT_NOT_ALLOWED');
        expect(errorCode(() => store.validate(issued.readHandle))).toBe('REQUEST_CONTEXT_REQUIRED');
    });

    it('isolates stdio implicit state and store-side closeConnection drops its strong reference', () => {
        const store = createReadHandleStore();
        const first = stdioContext();
        const second = stdioContext();
        expect(first.connectionId).not.toBe(second.connectionId);
        const issued = store.issue(handleInput(), { context: first });
        store.setImplicit(issued.readHandle, { context: first, key: 'doc-A' });
        expect(store.getStats().implicitConnections).toBe(1);
        expect(store.resolveImplicit({ context: first, key: 'doc-A' }).resourceId).toBe('document-A');
        expect(errorCode(() => store.resolveImplicit({ context: second, key: 'doc-A' })))
            .toBe('READ_HANDLE_REQUIRED');
        expect(store.closeConnection(first)).toBe(1);
        expect(store.getStats().implicitConnections).toBe(0);
        expect(errorCode(() => store.resolveImplicit({ context: first, key: 'doc-A' })))
            .toBe('READ_HANDLE_REQUIRED');
        expect(closeStdioConnection(first)).toBe(true);
        expect(errorCode(() => store.resolveImplicit({ context: first, key: 'doc-A' })))
            .toBe('REQUEST_CONTEXT_CLOSED');
        closeStdioConnection(second);
    });

    it('binds every request and resource field and permits explicit sharing by the same principal', () => {
        const store = createReadHandleStore();
        const owner = httpContext();
        const sameBearerCaller = httpContext();
        const issued = store.issue(handleInput(), { context: owner });
        expect(store.validate(issued.readHandle, { context: sameBearerCaller }).resourceId).toBe('document-A');

        for (const context of [
            httpContext({ principalFingerprint: fingerprint('principal-B') }),
            httpContext({ profile: 'secondary' }),
            httpContext({ epoch: 2 }),
        ]) {
            expect(errorCode(() => store.validate(issued.readHandle, { context })))
                .toBe('READ_HANDLE_BINDING_MISMATCH');
        }
        for (const expected of [
            { resourceKind: 'drive' },
            { resourceId: 'document-B' },
            { scope: 'document' },
            { tabId: 'tab-B' },
            { revisionId: 'revision-B' },
            { structuralFingerprint: 'structure-B' },
            { version: 8 },
        ]) {
            expect(errorCode(() => store.validate(issued.readHandle, { context: owner, expected })))
                .toBe('READ_HANDLE_BINDING_MISMATCH');
        }
        expect(store.validate(issued.readHandle, { context: owner }).revisionId).toBe('revision-A');
    });

    it('returns a client-safe record while keeping workspace and principal bindings private', () => {
        const store = createReadHandleStore();
        const context = httpContext();
        const input = handleInput();
        const issued = store.issue(input, { context });
        const clientRecord = store.validate(issued.readHandle, { context });
        expect(clientRecord).not.toHaveProperty('principalFingerprint');
        expect(clientRecord).not.toHaveProperty('profile');
        expect(clientRecord).not.toHaveProperty('epoch');
        expect(clientRecord).not.toHaveProperty('workspace');
        expect(JSON.stringify(clientRecord)).not.toContain(input.workspace.editablePath);
        expect(store.getInternalWorkspace(issued.readHandle, { context })).toMatchObject({
            workspaceId: input.workspace.workspaceId,
            ownershipManifest: input.workspace.ownershipManifest,
        });
        const rawContext = httpContext({
            principalFingerprint: fingerprintCredential(RAW_BEARER, { hmacKey: HMAC_KEY }),
        });
        const rawStore = createReadHandleStore();
        const rawIssued = rawStore.issue(handleInput({ workspace: null }), { context: rawContext });
        expect(JSON.stringify({ rawContext, record: rawStore.validate(rawIssued.readHandle, { context: rawContext }) }))
            .not.toContain(RAW_BEARER);
    });

    it('issues unique base64url capabilities with at least 256 bits and rejects weak randomness', () => {
        const store = createReadHandleStore();
        const context = httpContext();
        const handles = Array.from({ length: 32 }, () => (
            store.issue(handleInput({ workspace: null }), { context }).readHandle
        ));
        expect(new Set(handles).size).toBe(handles.length);
        for (const handle of handles) {
            expect(handle).toMatch(/^[A-Za-z0-9_-]+$/);
            expect(Buffer.from(handle, 'base64url')).toHaveLength(32);
        }
        expect(() => createReadHandleStore({ randomBytes: () => Buffer.alloc(31) })
            .issue(handleInput({ workspace: null }), { context })).toThrow(/at least 32 bytes/);
    });

    it('reserves atomically, rejects concurrent leases, aborts before write, and completes with a successor', () => {
        const store = createReadHandleStore();
        const context = httpContext();
        const predecessorInput = handleInput();
        const predecessor = store.issue(predecessorInput, { context });
        const firstLease = store.beginMutation(predecessor.readHandle, { context });
        expect(Buffer.from(firstLease.operationId, 'base64url')).toHaveLength(32);
        const bogusOperation = Buffer.alloc(32, 0x33).toString('base64url');
        const bogusError = caught(() => store.abortBeforeWrite(bogusOperation, { context }));
        expect(bogusError.code).toBe('READ_HANDLE_OPERATION_UNKNOWN');
        expect(bogusError.message).not.toContain(bogusOperation);
        expect(errorCode(() => store.beginMutation(predecessor.readHandle, { context }))).toBe('READ_HANDLE_RESERVED');
        expect(errorCode(() => store.validate(predecessor.readHandle, { context }))).toBe('READ_HANDLE_RESERVED');
        store.abortBeforeWrite(firstLease.operationId, { context });
        expect(store.validate(predecessor.readHandle, { context }).revisionId).toBe('revision-A');

        const lease = store.beginMutation(predecessor.readHandle, { context });
        const successorWorkspace = workspace();
        const successor = store.completeSuccess(lease.operationId, {
            revisionId: 'revision-B',
            structuralFingerprint: 'structure-B',
            version: 8,
            workspace: successorWorkspace,
        }, { context });
        expect(errorCode(() => store.validate(predecessor.readHandle, { context }))).toBe('READ_HANDLE_CONSUMED');
        expect(store.validate(successor.readHandle, { context })).toMatchObject({
            revisionId: 'revision-B', structuralFingerprint: 'structure-B', version: 8,
        });
        expect(store.getInternalWorkspace(successor.readHandle, { context }).workspaceId)
            .toBe(successorWorkspace.workspaceId);
    });

    it('makes a predecessor terminal after a post-write failure and never mints a successor', () => {
        const store = createReadHandleStore();
        const context = httpContext();
        const predecessorInput = handleInput({ workspace: workspace({ dirty: true }) });
        const predecessor = store.issue(predecessorInput, { context });
        const lease = store.beginMutation(predecessor.readHandle, { context });
        store.completeAfterWriteFailure(lease.operationId, { context });
        expect(errorCode(() => store.validate(predecessor.readHandle, { context }))).toBe('READ_HANDLE_INVALID');
        expect(errorCode(() => store.completeAfterWriteFailure(lease.operationId, { context })))
            .toBe('READ_HANDLE_OPERATION_UNKNOWN');
        expect(store.getStats()).toMatchObject({ active: 0, reserved: 0, operations: 0 });
        expect(store.listRetainedDirtyWorkspaces()).toHaveLength(1);
        expect(store.listRetainedDirtyWorkspaces()[0].reason).toBe('post-write-failure');
    });

    it('keeps a failed successor construction reserved until the caller terminalizes the post-write failure', () => {
        const store = createReadHandleStore();
        const context = httpContext();
        const predecessor = store.issue(handleInput(), { context });
        const lease = store.beginMutation(predecessor.readHandle, { context });
        expect(() => store.completeSuccess(lease.operationId, { revisionId: 'revision-B' }, { context }))
            .toThrow(/must provide a new workspace/);
        expect(errorCode(() => store.beginMutation(predecessor.readHandle, { context }))).toBe('READ_HANDLE_RESERVED');
        store.completeAfterWriteFailure(lease.operationId, { context });
        expect(errorCode(() => store.validate(predecessor.readHandle, { context }))).toBe('READ_HANDLE_INVALID');
    });

    it('retains dirty expired workspaces consistently and recovers/finalizes by manifest, not capability', () => {
        let now = 1_000;
        const store = createReadHandleStore({ clock: () => now, defaultTtlMs: 100 });
        const context = httpContext();
        const dirtyWorkspace = workspace({ dirty: true });
        const dirty = store.issue(handleInput({ workspace: dirtyWorkspace }), { context });
        const clean = store.issue(handleInput({ workspace: workspace({ dirty: false }) }), { context });
        now = 1_100;
        const firstCleanup = store.cleanupExpired();
        const secondCleanup = store.cleanupExpired();
        expect(firstCleanup.cleaned).toHaveLength(2);
        expect(firstCleanup.retainedDirty).toEqual(secondCleanup.retainedDirty);
        expect(firstCleanup.retainedDirty).toHaveLength(1);
        expect(errorCode(() => store.validate(dirty.readHandle, { context }))).toBe('READ_HANDLE_EXPIRED');
        expect(errorCode(() => store.validate(clean.readHandle, { context }))).toBe('READ_HANDLE_EXPIRED');
        expect(errorCode(() => store.finalizeRetainedDirtyWorkspace(
            dirtyWorkspace.workspaceId, dirtyWorkspace.ownershipManifest,
        ))).toBe('READ_HANDLE_WORKSPACE_RECOVERY_REQUIRED');
        const recovery = store.recoverRetainedDirtyWorkspace(
            dirtyWorkspace.workspaceId, dirtyWorkspace.ownershipManifest,
        );
        expect(recovery.editablePath).toBe(dirtyWorkspace.editablePath);
        store.finalizeRetainedDirtyWorkspace(dirtyWorkspace.workspaceId, dirtyWorkspace.ownershipManifest);
        expect(store.listRetainedDirtyWorkspaces()).toEqual([]);
    });

    it('bounds tombstones while preserving recent replay codes and bounds active capacity', () => {
        let now = 0;
        const store = createReadHandleStore({
            clock: () => now,
            maxActiveHandles: 4,
            maxRetainedDirtyWorkspaces: 4,
            maxTerminalTombstones: 5,
            terminalTombstoneTtlMs: 10,
        });
        const context = httpContext();
        const consumed = [];
        for (let index = 0; index < 100; index += 1) {
            now = index * 11;
            const issued = store.issue(handleInput({ workspace: null, resourceId: `doc-${index}` }), { context });
            store.consume(issued.readHandle, { context });
            consumed.push(issued.readHandle);
        }
        expect(store.getStats().tombstones).toBe(1);
        const consumedError = caught(() => store.validate(consumed.at(-1), { context }));
        expect(consumedError.code).toBe('READ_HANDLE_CONSUMED');
        expect(consumedError.message).not.toContain(consumed.at(-1));
        expect(errorCode(() => store.validate(consumed[0], { context }))).toBe('READ_HANDLE_UNKNOWN');

        const live = Array.from({ length: 4 }, (_, index) => (
            store.issue(handleInput({ workspace: null, resourceId: `live-${index}` }), { context })
        ));
        expect(live).toHaveLength(4);
        expect(errorCode(() => store.issue(handleInput({ workspace: null }), { context })))
            .toBe('READ_HANDLE_CAPACITY_EXCEEDED');
    });

    it('rejects non-schema workspace data, credential values, duplicate IDs, and metadata over limits', () => {
        const context = httpContext();
        const store = createReadHandleStore();
        expect(() => store.issue(handleInput({ workspace: { ...workspace(), extra: 'nope' } }), { context }))
            .toThrow(/not allowed/);
        expect(() => store.issue(handleInput({ workspace: workspace({ editablePath: RAW_BEARER }) }), { context }))
            .toThrow(/raw credential value/);
        expect(() => store.issue(handleInput({ resourceId: 'x'.repeat(2049), workspace: null }), { context }))
            .toThrow(/2048-byte limit/);

        const duplicate = workspace();
        store.issue(handleInput({ workspace: duplicate }), { context });
        expect(() => store.issue(handleInput({ workspace: duplicate, resourceId: 'document-B' }), { context }))
            .toThrow(/already in use/);

        const tinyBudget = createReadHandleStore({
            maxMetadataNodes: 2,
            maxMetadataTotalBytes: 64,
        });
        expect(() => tinyBudget.issue(handleInput(), { context })).toThrow(/limit/);
    });

    it('supports direct principal/profile/epoch invalidation and a complete binding rotation', () => {
        const oldBinding = {
            principalFingerprint: fingerprint('principal-A'), profile: 'primary', epoch: 1,
        };
        for (const invalidate of [
            (store) => store.invalidatePrincipal(oldBinding.principalFingerprint),
            (store) => store.invalidateProfile(oldBinding.profile),
            (store) => store.invalidateEpoch(oldBinding.epoch),
        ]) {
            const store = createReadHandleStore({ binding: oldBinding });
            const context = httpContext();
            const issued = store.issue(handleInput({ workspace: null }), { context });
            expect(invalidate(store)).toBe(1);
            expect(errorCode(() => store.validate(issued.readHandle, { context }))).toBe('READ_HANDLE_INVALID');
        }

        const store = createReadHandleStore({ binding: oldBinding });
        const oldContext = httpContext();
        const old = store.issue(handleInput({ workspace: null }), { context: oldContext });
        const nextBinding = {
            principalFingerprint: fingerprint('principal-B'), profile: 'secondary', epoch: 2,
        };
        expect(store.invalidateForBindingChange(nextBinding)).toBe(1);
        expect(errorCode(() => store.validate(old.readHandle, { context: oldContext }))).toBe('READ_HANDLE_INVALID');
        expect(errorCode(() => store.issue(handleInput({ workspace: null }), { context: oldContext })))
            .toBe('READ_HANDLE_BINDING_MISMATCH');
        const nextContext = httpContext(nextBinding);
        expect(store.issue(handleInput({ workspace: null }), { context: nextContext }).readHandle).toBeTruthy();
    });

    it('clears active operations on shutdown while retaining dirty recovery records', () => {
        const store = createReadHandleStore();
        const context = httpContext();
        const dirtyWorkspace = workspace({ dirty: true });
        const issued = store.issue(handleInput({ workspace: dirtyWorkspace }), { context });
        store.beginMutation(issued.readHandle, { context });
        const result = store.shutdown();
        expect(result.retainedDirty).toHaveLength(1);
        expect(store.getStats()).toMatchObject({
            active: 0, reserved: 0, operations: 0, retainedDirtyWorkspaces: 1, shutdown: true,
        });
        expect(errorCode(() => store.validate(issued.readHandle, { context }))).toBe('READ_HANDLE_STORE_SHUTDOWN');
        const recovered = store.recoverRetainedDirtyWorkspace(
            dirtyWorkspace.workspaceId, dirtyWorkspace.ownershipManifest,
        );
        expect(recovered.reason).toBe('shutdown');
    });
});
