// Process-local opaque read capabilities for the stateless MCP runtime.
// HTTP callers must supply a handle explicitly. Only a pinned stdio connection
// may resolve one implicitly, and that connection is never kept alive after its
// transport calls closeConnection().
import { randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import {
    RequestContextError,
    assertNoRawCredentialMaterial,
    clearStdioImplicitHandle,
    clearStdioImplicitHandles,
    getRequestContext,
    getStdioImplicitHandle,
    isCanonicalPrincipalFingerprint,
    isRequestContext,
    isStdioConnectionClosed,
    setStdioImplicitHandle,
} from './requestContext.js';

const MIN_CAPABILITY_BYTES = 32;
const MAX_RANDOM_ATTEMPTS = 16;
const RESOURCE_KINDS = new Set(['docs', 'sheets', 'drive']);
const SCOPES = new Set(['document', 'tab', 'resource']);
const WORKSPACE_KEYS = new Set([
    'workspaceId',
    'ownershipManifest',
    'editablePath',
    'baselineId',
    'dirty',
]);
const HANDLE_INPUT_KEYS = new Set([
    'resourceKind', 'resourceId', 'scope', 'tabId', 'revisionId',
    'structuralFingerprint', 'version', 'workspace', 'ttlMs',
]);
const SUCCESSOR_INPUT_KEYS = new Set([
    'revisionId', 'structuralFingerprint', 'version', 'workspace', 'ttlMs',
]);
const BINDING_KEYS = new Set(['principalFingerprint', 'profile', 'epoch']);

export const MAX_HANDLE_TTL_MS = (24 * 60 * 60 * 1000) - 1;
export const DEFAULT_HANDLE_TTL_MS = 23 * 60 * 60 * 1000;
export const DEFAULT_TERMINAL_TOMBSTONE_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_ACTIVE_HANDLES = 4096;
export const DEFAULT_MAX_TERMINAL_TOMBSTONES = 8192;
export const DEFAULT_MAX_RETAINED_DIRTY_WORKSPACES = 4096;
export const DEFAULT_MAX_PENDING_WORKSPACE_CLEANUPS = 4096;

const SAFE_MESSAGES = Object.freeze({
    READ_HANDLE_REQUIRED: 'A read handle is required for this operation.',
    READ_HANDLE_UNKNOWN: 'The read handle is not recognized.',
    READ_HANDLE_EXPIRED: 'The read handle has expired. Read the resource again.',
    READ_HANDLE_CONSUMED: 'The read handle has already been consumed.',
    READ_HANDLE_INVALID: 'The read handle is no longer valid.',
    READ_HANDLE_RESERVED: 'The read handle already has a mutation in progress.',
    READ_HANDLE_BINDING_MISMATCH: 'The read handle does not match this request or resource.',
    READ_HANDLE_IMPLICIT_NOT_ALLOWED: 'Implicit read handles are available only on a live stdio connection.',
    READ_HANDLE_STORE_SHUTDOWN: 'The read-handle store is shutting down.',
    READ_HANDLE_CAPACITY_EXCEEDED: 'The read-handle store is at capacity.',
    READ_HANDLE_OPERATION_UNKNOWN: 'The mutation operation is not recognized.',
    READ_HANDLE_WORKSPACE_REQUIRED: 'This operation requires a workspace record.',
    READ_HANDLE_WORKSPACE_NOT_FOUND: 'The retained workspace is not recognized.',
    READ_HANDLE_WORKSPACE_RECOVERY_REQUIRED: 'Begin retained-workspace recovery before finalizing it.',
    READ_HANDLE_WORKSPACE_CLEANUP_MISMATCH: 'The workspace cleanup acknowledgement does not match the queued ownership record.',
    REQUEST_CONTEXT_REQUIRED: 'An authenticated request context is required.',
    REQUEST_CONTEXT_INVALID: 'The request context is invalid.',
    REQUEST_CONTEXT_CLOSED: 'The stdio connection is closed.',
});

export class ReadHandleError extends Error {
    constructor(code) {
        super(SAFE_MESSAGES[code] ?? 'The read handle could not be used.');
        this.name = 'ReadHandleError';
        this.code = code;
    }
}

function fail(code) {
    throw new ReadHandleError(code);
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function assertAllowedKeys(value, allowed, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object.`);
    }
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) throw new TypeError(`${label} field "${key}" is not allowed.`);
    }
}

function requirePositiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer.`);
    }
    return value;
}

function requireBoundedString(value, name, maxBytes = 4096) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${name} must be a non-empty string.`);
    }
    if (Buffer.byteLength(value, 'utf8') > maxBytes) {
        throw new TypeError(`${name} exceeds its ${maxBytes}-byte limit.`);
    }
    assertNoRawCredentialMaterial(value, name);
    return value;
}

function requireOptionalString(value, name, maxBytes = 4096) {
    if (value === undefined || value === null) {
        return null;
    }
    return requireBoundedString(value, name, maxBytes);
}

function requireSafeInternalId(value, name) {
    const id = requireBoundedString(value, name, 128);
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
        throw new TypeError(`${name} may contain only letters, numbers, dot, underscore, and hyphen.`);
    }
    return id;
}

function requireEpoch(value) {
    if ((typeof value !== 'string' || value.length === 0) &&
        (!Number.isSafeInteger(value) || value < 0)) {
        throw new TypeError('epoch must be a non-empty string or a non-negative safe integer.');
    }
    if (typeof value === 'string') {
        requireBoundedString(value, 'epoch', 128);
    }
    return value;
}

function requireTtl(value) {
    requirePositiveInteger(value, 'ttlMs');
    if (value > MAX_HANDLE_TTL_MS) {
        throw new TypeError(`ttlMs must be no greater than ${MAX_HANDLE_TTL_MS}.`);
    }
    return value;
}

function clockNow(clock) {
    const value = clock();
    const milliseconds = value instanceof Date ? value.getTime() : value;
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
        throw new TypeError('clock must return a non-negative safe-integer millisecond timestamp.');
    }
    return milliseconds;
}

function safeStringEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') {
        return false;
    }
    const leftBytes = Buffer.from(left, 'utf8');
    const rightBytes = Buffer.from(right, 'utf8');
    if (leftBytes.length !== rightBytes.length) {
        return false;
    }
    return timingSafeEqual(leftBytes, rightBytes);
}

function safeValueEqual(left, right) {
    if (typeof left === 'string' && typeof right === 'string') {
        return safeStringEqual(left, right);
    }
    return typeof left === typeof right && Object.is(left, right);
}

function normalizeRandomBytes(value) {
    if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) {
        throw new TypeError('randomBytes must return a Buffer or Uint8Array.');
    }
    const bytes = Buffer.from(value);
    if (bytes.length < MIN_CAPABILITY_BYTES) {
        throw new TypeError(`randomBytes must return at least ${MIN_CAPABILITY_BYTES} bytes.`);
    }
    return bytes.length === MIN_CAPABILITY_BYTES ? bytes : bytes.subarray(0, MIN_CAPABILITY_BYTES);
}

function isCapabilitySyntax(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
        return false;
    }
    try {
        const decoded = Buffer.from(value, 'base64url');
        return decoded.length === MIN_CAPABILITY_BYTES && decoded.toString('base64url') === value;
    }
    catch {
        return false;
    }
}

function normalizeBinding(input) {
    assertAllowedKeys(input, BINDING_KEYS, 'handle binding');
    assertNoRawCredentialMaterial(input, 'handle binding');
    if (!isCanonicalPrincipalFingerprint(input.principalFingerprint)) {
        throw new TypeError('principalFingerprint must use canonical hmac-sha256 form.');
    }
    return Object.freeze({
        principalFingerprint: input.principalFingerprint,
        profile: requireBoundedString(input.profile, 'profile', 256),
        epoch: requireEpoch(input.epoch),
    });
}

function normalizeResource(input) {
    assertAllowedKeys(input, HANDLE_INPUT_KEYS, 'read handle input');
    assertNoRawCredentialMaterial(input, 'read handle input');
    const resourceKind = requireBoundedString(input.resourceKind, 'resourceKind', 16);
    if (!RESOURCE_KINDS.has(resourceKind)) {
        throw new TypeError('resourceKind must be docs, sheets, or drive.');
    }
    const resourceId = requireBoundedString(input.resourceId, 'resourceId', 2048);
    const scope = requireBoundedString(input.scope, 'scope', 16);
    if (!SCOPES.has(scope)) {
        throw new TypeError('scope must be document, tab, or resource.');
    }
    const tabId = requireOptionalString(input.tabId, 'tabId', 2048);
    if (scope === 'tab' && !tabId) {
        throw new TypeError('tabId is required when scope is tab.');
    }
    if (scope !== 'tab' && tabId) {
        throw new TypeError('tabId is allowed only when scope is tab.');
    }

    const version = input.version === undefined || input.version === null ? null : input.version;
    if (version !== null && typeof version !== 'string' &&
        (!Number.isSafeInteger(version) || version < 0)) {
        throw new TypeError('version must be a non-empty string or non-negative safe integer when provided.');
    }
    if (typeof version === 'string') {
        requireBoundedString(version, 'version', 2048);
    }

    return Object.freeze({
        resourceKind,
        resourceId,
        scope,
        tabId,
        revisionId: requireOptionalString(input.revisionId, 'revisionId', 2048),
        structuralFingerprint: requireOptionalString(input.structuralFingerprint, 'structuralFingerprint', 4096),
        version,
    });
}

function cloneBoundedMetadata(value, limits, label = 'metadata') {
    assertNoRawCredentialMaterial(value, label, {
        maxDepth: limits.maxMetadataDepth,
        maxNodes: limits.maxMetadataNodes,
        maxStringBytes: limits.maxMetadataStringBytes,
        maxTotalBytes: limits.maxMetadataTotalBytes,
    });
    const holder = { value: null };
    const seen = new WeakSet();
    const stack = [{ source: value, parent: holder, key: 'value', depth: 0, path: label }];

    while (stack.length > 0) {
        const current = stack.pop();
        if (current.freeze) {
            Object.freeze(current.target);
            continue;
        }
        const source = current.source;
        if (source === null || source === undefined || typeof source === 'boolean' || typeof source === 'string') {
            current.parent[current.key] = source ?? null;
            continue;
        }
        if (typeof source === 'number') {
            if (!Number.isFinite(source)) throw new TypeError(`${current.path} must be finite.`);
            current.parent[current.key] = source;
            continue;
        }
        if (!Array.isArray(source) &&
            !(typeof source === 'object' && Object.getPrototypeOf(source) === Object.prototype)) {
            throw new TypeError(`${current.path} must contain JSON-compatible values only.`);
        }
        if (seen.has(source)) throw new TypeError(`${label} must not contain circular references.`);
        seen.add(source);
        const target = Array.isArray(source) ? new Array(source.length) : {};
        current.parent[current.key] = target;
        stack.push({ freeze: true, target });
        const entries = Array.isArray(source)
            ? source.map((item, index) => [index, item])
            : Object.entries(source);
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            const [key, nested] = entries[index];
            stack.push({
                source: nested,
                parent: target,
                key,
                depth: current.depth + 1,
                path: `${current.path}.${key}`,
            });
        }
    }
    return holder.value;
}

function normalizeWorkspace(workspace, limits) {
    if (workspace === undefined || workspace === null) {
        return null;
    }
    if (typeof workspace !== 'object' || Array.isArray(workspace)) {
        throw new TypeError('workspace must be an object.');
    }
    assertNoRawCredentialMaterial(workspace, 'workspace');
    for (const key of Object.keys(workspace)) {
        if (!WORKSPACE_KEYS.has(key)) {
            throw new TypeError(`workspace field "${key}" is not allowed.`);
        }
    }
    const normalized = {
        workspaceId: requireSafeInternalId(workspace.workspaceId, 'workspace.workspaceId'),
        ownershipManifest: requireSafeInternalId(workspace.ownershipManifest, 'workspace.ownershipManifest'),
        editablePath: requireOptionalString(workspace.editablePath, 'workspace.editablePath', limits.maxMetadataStringBytes),
        baselineId: requireOptionalString(workspace.baselineId, 'workspace.baselineId', 512),
        dirty: Boolean(workspace.dirty),
    };
    return cloneBoundedMetadata(normalized, limits, 'workspace');
}

function contextFor(options = {}) {
    const context = hasOwn(options, 'context') ? options.context : getRequestContext();
    if (!context) {
        fail('REQUEST_CONTEXT_REQUIRED');
    }
    if (!isRequestContext(context)) {
        fail('REQUEST_CONTEXT_INVALID');
    }
    try {
        if (context.transport === 'stdio' && isStdioConnectionClosed(context)) {
            fail('REQUEST_CONTEXT_CLOSED');
        }
    }
    catch (error) {
        if (error instanceof ReadHandleError) throw error;
        if (error instanceof RequestContextError) fail('REQUEST_CONTEXT_INVALID');
        throw error;
    }
    return context;
}

function contextBinding(context) {
    return normalizeBinding({
        principalFingerprint: context.principalFingerprint,
        profile: context.profile,
        epoch: context.epoch,
    });
}

function bindingMatches(record, binding) {
    return safeStringEqual(record.principalFingerprint, binding.principalFingerprint) &&
        safeStringEqual(record.profile, binding.profile) &&
        safeValueEqual(record.epoch, binding.epoch);
}

function resourceMatches(record, expected) {
    for (const key of ['resourceKind', 'resourceId', 'scope', 'tabId', 'revisionId', 'structuralFingerprint', 'version']) {
        if (hasOwn(expected, key) && !safeValueEqual(record[key], expected[key] ?? null)) {
            return false;
        }
    }
    return true;
}

// This is the only record shape returned by normal handle operations. It is
// safe to include in a tool result: no principal fingerprint, profile/epoch, or
// private workspace path/manifest appears here.
function makeClientRecord(record) {
    return Object.freeze({
        resourceKind: record.resourceKind,
        resourceId: record.resourceId,
        scope: record.scope,
        tabId: record.tabId,
        revisionId: record.revisionId,
        structuralFingerprint: record.structuralFingerprint,
        version: record.version,
        issuedAt: record.issuedAt,
        expiresAt: record.expiresAt,
    });
}

function normalizeImplicitKey(key = 'default') {
    return requireBoundedString(key, 'implicit handle key', 1024);
}

/** Create one bounded process-local store for one configured binding. */
export function createReadHandleStore({
    clock = () => Date.now(),
    randomBytes = nodeRandomBytes,
    defaultTtlMs = DEFAULT_HANDLE_TTL_MS,
    terminalTombstoneTtlMs = DEFAULT_TERMINAL_TOMBSTONE_TTL_MS,
    maxActiveHandles = DEFAULT_MAX_ACTIVE_HANDLES,
    maxTerminalTombstones = DEFAULT_MAX_TERMINAL_TOMBSTONES,
    maxRetainedDirtyWorkspaces = DEFAULT_MAX_RETAINED_DIRTY_WORKSPACES,
    maxMetadataDepth = 6,
    maxMetadataNodes = 64,
    maxMetadataStringBytes = 4096,
    maxMetadataTotalBytes = 16384,
    binding = null,
} = {}) {
    if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
    if (typeof randomBytes !== 'function') throw new TypeError('randomBytes must be a function.');
    requireTtl(defaultTtlMs);
    requirePositiveInteger(terminalTombstoneTtlMs, 'terminalTombstoneTtlMs');
    requirePositiveInteger(maxActiveHandles, 'maxActiveHandles');
    requirePositiveInteger(maxTerminalTombstones, 'maxTerminalTombstones');
    requirePositiveInteger(maxRetainedDirtyWorkspaces, 'maxRetainedDirtyWorkspaces');
    if (maxRetainedDirtyWorkspaces < maxActiveHandles) {
        throw new TypeError('maxRetainedDirtyWorkspaces must be at least maxActiveHandles.');
    }
    if (maxTerminalTombstones < maxActiveHandles) {
        throw new TypeError('maxTerminalTombstones must be at least maxActiveHandles.');
    }

    const limits = Object.freeze({
        maxMetadataDepth: requirePositiveInteger(maxMetadataDepth, 'maxMetadataDepth'),
        maxMetadataNodes: requirePositiveInteger(maxMetadataNodes, 'maxMetadataNodes'),
        maxMetadataStringBytes: requirePositiveInteger(maxMetadataStringBytes, 'maxMetadataStringBytes'),
        maxMetadataTotalBytes: requirePositiveInteger(maxMetadataTotalBytes, 'maxMetadataTotalBytes'),
    });

    const records = new Map(); // active or reserved only
    const tombstones = new Map();
    const operations = new Map(); // operationId -> capability
    const implicitContexts = new Map(); // stdio context -> Map<key, capability>
    const retainedDirtyWorkspaces = new Map(); // workspaceId -> operator record
    const workspaceIds = new Set();
    let configuredBinding = binding === null ? null : normalizeBinding(binding);
    let shutdown = false;

    function requireOpenStore() {
        if (shutdown) fail('READ_HANDLE_STORE_SHUTDOWN');
    }

    function mintCapability() {
        for (let attempt = 0; attempt < MAX_RANDOM_ATTEMPTS; attempt += 1) {
            const candidate = normalizeRandomBytes(randomBytes(MIN_CAPABILITY_BYTES)).toString('base64url');
            if (!records.has(candidate) && !tombstones.has(candidate) && !operations.has(candidate)) {
                return candidate;
            }
        }
        throw new ReadHandleError('READ_HANDLE_ISSUANCE_FAILED');
    }

    function assertConfiguredBinding(context) {
        const candidate = contextBinding(context);
        if (!configuredBinding) {
            configuredBinding = candidate;
        }
        else if (!bindingMatches(configuredBinding, candidate)) {
            fail('READ_HANDLE_BINDING_MISMATCH');
        }
        return candidate;
    }

    function clearCapabilityFromImplicitContexts(capability) {
        for (const [context, assignments] of implicitContexts) {
            try {
                for (const [key, assigned] of assignments) {
                    if (safeStringEqual(assigned, capability)) {
                        if (safeStringEqual(getStdioImplicitHandle(context, key) ?? '', capability)) {
                            clearStdioImplicitHandle(context, key);
                        }
                        assignments.delete(key);
                    }
                }
                if (assignments.size === 0) implicitContexts.delete(context);
            }
            catch (error) {
                if (error instanceof RequestContextError) {
                    implicitContexts.delete(context);
                    continue;
                }
                throw error;
            }
        }
    }

    function pruneTombstones(now) {
        for (const [capability, tombstone] of tombstones) {
            if (now >= tombstone.expiresAt) tombstones.delete(capability);
        }
    }

    function addTombstone(record, code, now) {
        tombstones.set(record.capability, Object.freeze({
            code,
            expiresAt: now + terminalTombstoneTtlMs,
        }));
        pruneTombstones(now);
    }

    function removeOperation(record) {
        if (record.operationId) operations.delete(record.operationId);
        record.operationId = null;
    }

    function makeOperatorRecord(record, reason, now) {
        return {
            workspaceId: record.workspace.workspaceId,
            ownershipManifest: record.workspace.ownershipManifest,
            editablePath: record.workspace.editablePath,
            baselineId: record.workspace.baselineId,
            dirty: true,
            resourceKind: record.resourceKind,
            resourceId: record.resourceId,
            scope: record.scope,
            tabId: record.tabId,
            retainedAt: now,
            reason,
            recoveryStartedAt: null,
        };
    }

    function retainDirtyWorkspace(record, reason, now) {
        if (!record.workspace?.dirty) return false;
        const id = record.workspace.workspaceId;
        if (!retainedDirtyWorkspaces.has(id)) {
            // records + retained workspaces is capacity-bounded at issuance, so
            // transferring one record cannot overflow this registry.
            if (retainedDirtyWorkspaces.size >= maxRetainedDirtyWorkspaces) {
                fail('READ_HANDLE_CAPACITY_EXCEEDED');
            }
            retainedDirtyWorkspaces.set(id, makeOperatorRecord(record, reason, now));
        }
        return true;
    }

    function terminalize(record, code, now, { retainDirty = true, reason = code } = {}) {
        if (retainDirty) retainDirtyWorkspace(record, reason, now);
        records.delete(record.capability);
        removeOperation(record);
        clearCapabilityFromImplicitContexts(record.capability);
        if (!record.workspace?.dirty || !retainDirty) workspaceIds.delete(record.workspace?.workspaceId);
        addTombstone(record, code, now);
    }

    function listRetainedDirtyWorkspaces() {
        return Object.freeze(Array.from(retainedDirtyWorkspaces.values(), (entry) => (
            cloneBoundedMetadata(entry, limits, 'retained workspace')
        )));
    }

    function cleanupExpiredInternal(now) {
        const cleaned = [];
        for (const record of Array.from(records.values())) {
            if (now < record.expiresAt) continue;
            const retained = Boolean(record.workspace?.dirty);
            terminalize(record, 'READ_HANDLE_EXPIRED', now, {
                retainDirty: true,
                reason: 'expired',
            });
            cleaned.push(Object.freeze({
                resourceKind: record.resourceKind,
                resourceId: record.resourceId,
                workspaceRetained: retained,
            }));
        }
        pruneTombstones(now);
        return cleaned;
    }

    function assertCapacity(now) {
        cleanupExpiredInternal(now);
        if (records.size >= maxActiveHandles ||
            records.size + retainedDirtyWorkspaces.size >= maxRetainedDirtyWorkspaces ||
            tombstones.size + records.size + operations.size >= maxTerminalTombstones) {
            fail('READ_HANDLE_CAPACITY_EXCEEDED');
        }
    }

    function ensureWorkspaceAvailable(workspace, predecessor = null) {
        if (!workspace) return;
        if (predecessor?.workspace && safeStringEqual(workspace.workspaceId, predecessor.workspace.workspaceId)) {
            throw new TypeError('A successor must own a new workspaceId.');
        }
        if (workspaceIds.has(workspace.workspaceId)) {
            throw new TypeError('workspace.workspaceId is already in use.');
        }
    }

    function constructRecord(input, context, now, predecessor = null) {
        const resource = predecessor
            ? {
                resourceKind: predecessor.resourceKind,
                resourceId: predecessor.resourceId,
                scope: predecessor.scope,
                tabId: predecessor.tabId,
                revisionId: input.revisionId === undefined
                    ? predecessor.revisionId
                    : requireOptionalString(input.revisionId, 'revisionId', 2048),
                structuralFingerprint: input.structuralFingerprint === undefined
                    ? predecessor.structuralFingerprint
                    : requireOptionalString(input.structuralFingerprint, 'structuralFingerprint', 4096),
                version: input.version === undefined ? predecessor.version : input.version,
            }
            : normalizeResource(input);
        if (predecessor && resource.version !== null && typeof resource.version !== 'string' &&
            (!Number.isSafeInteger(resource.version) || resource.version < 0)) {
            throw new TypeError('version must be a non-empty string or non-negative safe integer when provided.');
        }
        if (predecessor && typeof resource.version === 'string') {
            requireBoundedString(resource.version, 'version', 2048);
        }

        if (predecessor?.workspace && input.workspace === undefined) {
            throw new TypeError('A successor for a workspace-backed handle must provide a new workspace.');
        }
        const workspace = normalizeWorkspace(input.workspace, limits);
        ensureWorkspaceAvailable(workspace, predecessor);
        const ttlMs = input.ttlMs === undefined ? defaultTtlMs : requireTtl(input.ttlMs);
        const bindingForRecord = predecessor ?? contextBinding(context);
        return {
            capability: mintCapability(),
            state: 'active',
            ...resource,
            principalFingerprint: bindingForRecord.principalFingerprint,
            profile: bindingForRecord.profile,
            epoch: bindingForRecord.epoch,
            issuedAt: now,
            expiresAt: now + ttlMs,
            workspace,
            operationId: null,
        };
    }

    function tombstoneFailure(capability, now) {
        const tombstone = tombstones.get(capability);
        if (tombstone && now < tombstone.expiresAt) fail(tombstone.code);
        fail('READ_HANDLE_UNKNOWN');
    }

    function findRecord(capability, options = {}, { allowReserved = false, allowExpired = false } = {}) {
        requireOpenStore();
        const context = contextFor(options);
        const now = clockNow(clock);
        if (!isCapabilitySyntax(capability)) fail('READ_HANDLE_UNKNOWN');
        const record = records.get(capability);
        if (!record) tombstoneFailure(capability, now);
        if (!safeStringEqual(record.capability, capability)) fail('READ_HANDLE_UNKNOWN');
        if (!allowExpired && now >= record.expiresAt) fail('READ_HANDLE_EXPIRED');
        if (record.state === 'reserved' && !allowReserved) fail('READ_HANDLE_RESERVED');
        const bindingForContext = contextBinding(context);
        if (!bindingMatches(record, bindingForContext)) fail('READ_HANDLE_BINDING_MISMATCH');
        if (options.expected && !resourceMatches(record, options.expected)) {
            fail('READ_HANDLE_BINDING_MISMATCH');
        }
        return { record, context, now };
    }

    function findLease(operationId, options = {}) {
        requireOpenStore();
        const context = contextFor(options);
        const now = clockNow(clock);
        if (!isCapabilitySyntax(operationId)) fail('READ_HANDLE_OPERATION_UNKNOWN');
        const capability = operations.get(operationId);
        if (!capability) fail('READ_HANDLE_OPERATION_UNKNOWN');
        const record = records.get(capability);
        if (!record || record.state !== 'reserved' ||
            !safeStringEqual(record.operationId ?? '', operationId)) {
            fail('READ_HANDLE_OPERATION_UNKNOWN');
        }
        if (!bindingMatches(record, contextBinding(context))) fail('READ_HANDLE_BINDING_MISMATCH');
        if (options.expected && !resourceMatches(record, options.expected)) {
            fail('READ_HANDLE_BINDING_MISMATCH');
        }
        return { record, context, now };
    }

    function issue(input, options = {}) {
        if (!input || typeof input !== 'object') throw new TypeError('read handle input must be an object.');
        assertNoRawCredentialMaterial(input, 'read handle input');
        requireOpenStore();
        const context = contextFor(options);
        assertConfiguredBinding(context);
        const now = clockNow(clock);
        assertCapacity(now);
        const record = constructRecord(input, context, now);
        records.set(record.capability, record);
        if (record.workspace) workspaceIds.add(record.workspace.workspaceId);
        return Object.freeze({ readHandle: record.capability, expiresAt: record.expiresAt });
    }

    function validate(capability, options = {}) {
        return makeClientRecord(findRecord(capability, options).record);
    }

    function getInternalWorkspace(capability, options = {}) {
        const workspace = findRecord(capability, options, { allowReserved: true }).record.workspace;
        return workspace ? cloneBoundedMetadata(workspace, limits, 'workspace') : null;
    }

    function resolveImplicit(options = {}) {
        requireOpenStore();
        const context = contextFor(options);
        if (context.transport !== 'stdio') fail('READ_HANDLE_IMPLICIT_NOT_ALLOWED');
        const key = normalizeImplicitKey(options.key);
        let capability;
        try {
            capability = getStdioImplicitHandle(context, key);
        }
        catch (error) {
            if (error instanceof RequestContextError) fail('REQUEST_CONTEXT_CLOSED');
            throw error;
        }
        if (!capability) fail('READ_HANDLE_REQUIRED');
        return validate(capability, { context, expected: options.expected });
    }

    function setImplicit(capability, options = {}) {
        requireOpenStore();
        const context = contextFor(options);
        if (context.transport !== 'stdio') fail('READ_HANDLE_IMPLICIT_NOT_ALLOWED');
        const key = normalizeImplicitKey(options.key);
        const clientRecord = validate(capability, { context, expected: options.expected });
        setStdioImplicitHandle(context, key, capability);
        let assignments = implicitContexts.get(context);
        if (!assignments) {
            assignments = new Map();
            implicitContexts.set(context, assignments);
        }
        assignments.set(key, capability);
        return clientRecord;
    }

    function clearImplicit(options = {}) {
        requireOpenStore();
        const context = contextFor(options);
        if (context.transport !== 'stdio') fail('READ_HANDLE_IMPLICIT_NOT_ALLOWED');
        const key = normalizeImplicitKey(options.key);
        const result = clearStdioImplicitHandle(context, key);
        const assignments = implicitContexts.get(context);
        assignments?.delete(key);
        if (assignments?.size === 0) implicitContexts.delete(context);
        return result;
    }

    function closeConnection(context) {
        if (!isRequestContext(context) || context.transport !== 'stdio') {
            fail('READ_HANDLE_IMPLICIT_NOT_ALLOWED');
        }
        let cleared = 0;
        try {
            cleared = clearStdioImplicitHandles(context);
        }
        catch (error) {
            if (!(error instanceof RequestContextError) || error.code !== 'REQUEST_CONTEXT_CLOSED') throw error;
        }
        implicitContexts.delete(context);
        return cleared;
    }

    function beginMutation(capability, options = {}) {
        const { record, now } = findRecord(capability, options);
        cleanupExpiredInternal(now);
        // A successful mutation needs room for both the predecessor tombstone
        // and the successor active record. Reserve that terminal slot before a
        // caller performs external I/O so completion cannot fail from capacity.
        if (tombstones.size + records.size + operations.size >= maxTerminalTombstones) {
            fail('READ_HANDLE_CAPACITY_EXCEEDED');
        }
        const operationId = mintCapability();
        record.state = 'reserved';
        record.operationId = operationId;
        operations.set(operationId, record.capability);
        return Object.freeze({ operationId, record: makeClientRecord(record) });
    }

    function abortBeforeWrite(operationId, options = {}) {
        const { record } = findLease(operationId, options);
        operations.delete(operationId);
        record.operationId = null;
        record.state = 'active';
        return makeClientRecord(record);
    }

    function completeSuccess(operationId, successorInput = {}, options = {}) {
        if (!successorInput || typeof successorInput !== 'object') {
            throw new TypeError('successor input must be an object.');
        }
        assertNoRawCredentialMaterial(successorInput, 'successor input');
        for (const immutableKey of [
            'resourceKind', 'resourceId', 'scope', 'tabId',
            'principalFingerprint', 'profile', 'epoch',
        ]) {
            if (hasOwn(successorInput, immutableKey)) {
                throw new TypeError(`${immutableKey} cannot change during mutation completion.`);
            }
        }
        const { record: predecessor, context, now } = findLease(operationId, options);
        const successor = constructRecord(successorInput, context, now, predecessor);
        // No await or externally supplied callback occurs between these writes.
        // The successor is fully built before the predecessor is terminalized.
        records.set(successor.capability, successor);
        if (successor.workspace) workspaceIds.add(successor.workspace.workspaceId);
        terminalize(predecessor, 'READ_HANDLE_CONSUMED', now, {
            retainDirty: false,
            reason: 'mutation-success',
        });
        return Object.freeze({ readHandle: successor.capability, expiresAt: successor.expiresAt });
    }

    function completeAfterWriteFailure(operationId, options = {}) {
        const { record, now } = findLease(operationId, options);
        const clientRecord = makeClientRecord(record);
        terminalize(record, 'READ_HANDLE_INVALID', now, {
            retainDirty: true,
            reason: 'post-write-failure',
        });
        return clientRecord;
    }

    // Backward-compatible helper for callers that have not yet adopted leases.
    // It represents a no-I/O transition, so a construction failure can safely
    // abort the reservation and leave the predecessor active.
    function transitionToSuccessor(capability, successorInput = {}, options = {}) {
        const lease = beginMutation(capability, options);
        try {
            return completeSuccess(lease.operationId, successorInput, options);
        }
        catch (error) {
            try {
                abortBeforeWrite(lease.operationId, options);
            }
            catch {
                // Preserve the original construction error.
            }
            throw error;
        }
    }

    function consume(capability, options = {}) {
        const { record, now } = findRecord(capability, options);
        const clientRecord = makeClientRecord(record);
        terminalize(record, 'READ_HANDLE_CONSUMED', now, { retainDirty: true, reason: 'consumed' });
        return clientRecord;
    }

    function revoke(capability, options = {}) {
        const { record, now } = findRecord(capability, options);
        const clientRecord = makeClientRecord(record);
        terminalize(record, 'READ_HANDLE_INVALID', now, { retainDirty: true, reason: 'revoked' });
        return clientRecord;
    }

    function invalidateWhere(predicate, reason) {
        requireOpenStore();
        const now = clockNow(clock);
        cleanupExpiredInternal(now);
        let invalidated = 0;
        for (const record of Array.from(records.values())) {
            if (predicate(record)) {
                terminalize(record, 'READ_HANDLE_INVALID', now, { retainDirty: true, reason });
                invalidated += 1;
            }
        }
        return invalidated;
    }

    function invalidateEpoch(epoch) {
        requireEpoch(epoch);
        return invalidateWhere((record) => safeValueEqual(record.epoch, epoch), 'epoch');
    }

    function invalidateProfile(profile) {
        requireBoundedString(profile, 'profile', 256);
        return invalidateWhere((record) => safeStringEqual(record.profile, profile), 'profile');
    }

    function invalidatePrincipal(principalFingerprint) {
        if (!isCanonicalPrincipalFingerprint(principalFingerprint)) {
            throw new TypeError('principalFingerprint must use canonical hmac-sha256 form.');
        }
        return invalidateWhere(
            (record) => safeStringEqual(record.principalFingerprint, principalFingerprint),
            'principal',
        );
    }

    function invalidateForBindingChange(bindingInput) {
        const nextBinding = normalizeBinding(bindingInput);
        const invalidated = invalidateWhere((record) => !bindingMatches(record, nextBinding), 'binding-change');
        configuredBinding = nextBinding;
        return invalidated;
    }

    function markWorkspaceDirty(capability, dirty, options = {}) {
        const { record } = findRecord(capability, options, { allowReserved: true });
        if (!record.workspace) fail('READ_HANDLE_WORKSPACE_REQUIRED');
        record.workspace = Object.freeze({ ...record.workspace, dirty: Boolean(dirty) });
        return makeClientRecord(record);
    }

    function cleanupExpired() {
        requireOpenStore();
        const now = clockNow(clock);
        const cleaned = cleanupExpiredInternal(now);
        return Object.freeze({
            cleaned: Object.freeze(cleaned),
            retainedDirty: listRetainedDirtyWorkspaces(),
        });
    }

    function requireRetainedWorkspace(workspaceId, ownershipManifest) {
        const id = requireSafeInternalId(workspaceId, 'workspaceId');
        const manifest = requireSafeInternalId(ownershipManifest, 'ownershipManifest');
        const entry = retainedDirtyWorkspaces.get(id);
        if (!entry || !safeStringEqual(entry.ownershipManifest, manifest)) {
            fail('READ_HANDLE_WORKSPACE_NOT_FOUND');
        }
        return entry;
    }

    function recoverRetainedDirtyWorkspace(workspaceId, ownershipManifest) {
        const entry = requireRetainedWorkspace(workspaceId, ownershipManifest);
        if (entry.recoveryStartedAt === null) entry.recoveryStartedAt = clockNow(clock);
        return cloneBoundedMetadata(entry, limits, 'retained workspace');
    }

    function finalizeRetainedDirtyWorkspace(workspaceId, ownershipManifest) {
        const entry = requireRetainedWorkspace(workspaceId, ownershipManifest);
        if (entry.recoveryStartedAt === null) fail('READ_HANDLE_WORKSPACE_RECOVERY_REQUIRED');
        const result = cloneBoundedMetadata(entry, limits, 'retained workspace');
        retainedDirtyWorkspaces.delete(entry.workspaceId);
        workspaceIds.delete(entry.workspaceId);
        return result;
    }

    function shutdownStore() {
        if (shutdown) return Object.freeze({ retainedDirty: listRetainedDirtyWorkspaces() });
        const now = clockNow(clock);
        for (const record of Array.from(records.values())) {
            if (record.workspace?.dirty) retainDirtyWorkspace(record, 'shutdown', now);
            records.delete(record.capability);
            removeOperation(record);
        }
        for (const context of Array.from(implicitContexts.keys())) closeConnection(context);
        tombstones.clear();
        shutdown = true;
        return Object.freeze({ retainedDirty: listRetainedDirtyWorkspaces() });
    }

    function getStats() {
        let active = 0;
        let reserved = 0;
        for (const record of records.values()) {
            if (record.state === 'reserved') reserved += 1;
            else active += 1;
        }
        return Object.freeze({
            active,
            reserved,
            operations: operations.size,
            tombstones: tombstones.size,
            implicitConnections: implicitContexts.size,
            retainedDirtyWorkspaces: retainedDirtyWorkspaces.size,
            shutdown,
        });
    }

    return Object.freeze({
        issue,
        validate,
        getInternalWorkspace,
        resolveImplicit,
        setImplicit,
        clearImplicit,
        closeConnection,
        beginMutation,
        abortBeforeWrite,
        completeSuccess,
        completeAfterWriteFailure,
        transitionToSuccessor,
        consume,
        revoke,
        invalidateEpoch,
        invalidateProfile,
        invalidatePrincipal,
        invalidateForBindingChange,
        markWorkspaceDirty,
        cleanupExpired,
        listRetainedDirtyWorkspaces,
        recoverRetainedDirtyWorkspace,
        finalizeRetainedDirtyWorkspace,
        shutdown: shutdownStore,
        getStats,
    });
}
