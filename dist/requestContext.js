// Request-scoped identity and connection state for the stateless MCP runtime.
//
// There is deliberately no ambient fallback context.  A tool call either runs
// under an authenticated HTTP request or a pinned stdio connection, or it has
// no request identity at all.  The old session module treated "no context" as
// one shared namespace; doing that here would let one HTTP request borrow
// another request's read state.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes as nodeRandomBytes } from 'node:crypto';

const requestContextStorage = new AsyncLocalStorage();
const contextStates = new WeakMap();
const activeConnectionIds = new Set();

const MIN_CONNECTION_ID_BYTES = 16;
const MAX_RANDOM_ATTEMPTS = 16;
const PRINCIPAL_FINGERPRINT_PREFIX = 'hmac-sha256:';
const PRINCIPAL_FINGERPRINT_PATTERN = /^hmac-sha256:[A-Za-z0-9_-]{43}$/;

// This key exists only for the lifetime of this process.  It makes the
// credential fingerprint unsuitable for offline guessing even if a diagnostic
// record containing a fingerprint is exposed.  Callers that need a stable
// fingerprint across separately constructed middleware instances may pass an
// explicit process-scoped HMAC key instead.
const processFingerprintKey = nodeRandomBytes(32);

export class RequestContextError extends Error {
    constructor(code) {
        super(code);
        this.name = 'RequestContextError';
        this.code = code;
    }
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function assertAllowedKeys(value, allowed, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object.`);
    }
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw new TypeError(`${label} field "${key}" is not allowed.`);
        }
    }
}

function requireNonEmptyString(value, name) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${name} must be a non-empty string.`);
    }
    return value;
}

function requireEpoch(value) {
    if ((typeof value !== 'string' || value.length === 0) &&
        (!Number.isSafeInteger(value) || value < 0)) {
        throw new TypeError('epoch must be a non-empty string or a non-negative safe integer.');
    }
    return value;
}

function toSecureBuffer(value, minBytes, name) {
    if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) {
        throw new TypeError(`${name} must return a Buffer or Uint8Array.`);
    }
    const bytes = Buffer.from(value);
    if (bytes.length < minBytes) {
        throw new TypeError(`${name} returned fewer than ${minBytes} random bytes.`);
    }
    return bytes;
}

function randomBase64Url(randomBytes, byteLength, name) {
    return toSecureBuffer(randomBytes(byteLength), byteLength, name).toString('base64url');
}

function normalizeSensitiveKey(key) {
    return String(key).replace(/[-_]/g, '').toLowerCase();
}

const RAW_CREDENTIAL_KEYS = new Set([
    'authorization',
    'bearer',
    'token',
    'accesstoken',
    'idtoken',
    'refreshtoken',
    'credential',
    'rawcredential',
]);

function looksLikeRawCredential(value) {
    if (typeof value !== 'string') {
        return false;
    }
    const trimmed = value.trim();
    return /^Bearer\s+\S+$/i.test(trimmed) ||
        /^ya29\.[A-Za-z0-9._-]+$/.test(trimmed) ||
        /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed) ||
        /(?:authorization|access_token|refresh_token)\s*[:=]\s*\S+/i.test(trimmed);
}

/**
 * Reject raw credential-shaped fields from data that may be retained in a
 * request context or handle record. Fingerprints are intentionally not on the
 * deny-list: callers must supply a fingerprint, never the bearer itself.
 */
export function assertNoRawCredentialMaterial(value, label = 'input', {
    maxDepth = 8,
    maxNodes = 256,
    maxStringBytes = 4096,
    maxTotalBytes = 65536,
} = {}) {
    const stack = [{ value, path: label, depth: 0 }];
    const seen = new WeakSet();
    let nodes = 0;
    let totalBytes = 0;

    while (stack.length > 0) {
        const current = stack.pop();
        nodes += 1;
        if (nodes > maxNodes) throw new TypeError(`${label} exceeds its node limit.`);
        if (current.depth > maxDepth) throw new TypeError(`${label} exceeds its depth limit.`);
        if (looksLikeRawCredential(current.value)) {
            throw new TypeError(`${current.path} must not contain a raw credential value.`);
        }
        if (typeof current.value === 'string') {
            const bytes = Buffer.byteLength(current.value, 'utf8');
            if (bytes > maxStringBytes) throw new TypeError(`${current.path} exceeds its string limit.`);
            totalBytes += bytes;
            if (totalBytes > maxTotalBytes) throw new TypeError(`${label} exceeds its total byte limit.`);
            continue;
        }
        if (!current.value || typeof current.value !== 'object') continue;
        if (seen.has(current.value)) throw new TypeError(`${label} must not contain circular references.`);
        seen.add(current.value);
        for (const [key, nested] of Object.entries(current.value)) {
            if (RAW_CREDENTIAL_KEYS.has(normalizeSensitiveKey(key))) {
                throw new TypeError(`${current.path} must not contain raw credential field "${key}".`);
            }
            totalBytes += Buffer.byteLength(key, 'utf8');
            if (totalBytes > maxTotalBytes) throw new TypeError(`${label} exceeds its total byte limit.`);
            stack.push({ value: nested, path: `${current.path}.${key}`, depth: current.depth + 1 });
        }
    }
}

/**
 * Derive a non-reversible, process-scoped identity from an authenticated
 * credential. The raw credential is consumed synchronously and is never put in
 * a context or returned value.
 */
export function fingerprintCredential(credential, { hmacKey = processFingerprintKey } = {}) {
    requireNonEmptyString(credential, 'credential');
    if (!(typeof hmacKey === 'string' || Buffer.isBuffer(hmacKey) || hmacKey instanceof Uint8Array)) {
        throw new TypeError('hmacKey must be a string, Buffer, or Uint8Array.');
    }
    const keyBytes = typeof hmacKey === 'string' ? Buffer.from(hmacKey, 'utf8') : Buffer.from(hmacKey);
    if (keyBytes.length < 32) {
        throw new TypeError('hmacKey must contain at least 32 bytes.');
    }
    const digest = createHmac('sha256', keyBytes).update(credential, 'utf8').digest('base64url');
    return `${PRINCIPAL_FINGERPRINT_PREFIX}${digest}`;
}

export function isCanonicalPrincipalFingerprint(value) {
    if (typeof value !== 'string' || !PRINCIPAL_FINGERPRINT_PATTERN.test(value)) {
        return false;
    }
    const digest = value.slice(PRINCIPAL_FINGERPRINT_PREFIX.length);
    try {
        const decoded = Buffer.from(digest, 'base64url');
        return decoded.length === 32 && decoded.toString('base64url') === digest;
    }
    catch {
        return false;
    }
}

function requireCanonicalPrincipalFingerprint(value) {
    if (!isCanonicalPrincipalFingerprint(value)) {
        throw new TypeError('principalFingerprint must use canonical hmac-sha256:<base64url-32-byte-digest> form.');
    }
    return value;
}

function createContext({ transport, principalFingerprint, profile, epoch, connectionId = null }) {
    assertNoRawCredentialMaterial({ principalFingerprint, profile, epoch }, 'request context');
    requireCanonicalPrincipalFingerprint(principalFingerprint);
    requireNonEmptyString(profile, 'profile');
    requireEpoch(epoch);

    const context = Object.freeze({
        transport,
        principalFingerprint,
        profile,
        epoch,
        connectionId,
    });

    contextStates.set(context, {
        closed: false,
        implicitHandles: transport === 'stdio' ? new Map() : null,
    });
    return context;
}

/** Create a request context for one authenticated HTTP call. */
export function createHttpRequestContext(input) {
    assertAllowedKeys(input, new Set(['principalFingerprint', 'profile', 'epoch']), 'HTTP request context');
    const { principalFingerprint, profile, epoch } = input;
    return createContext({
        transport: 'http',
        principalFingerprint,
        profile,
        epoch,
    });
}

/**
 * Create a context pinned to one stdio connection. The random connection ID is
 * an internal isolation key, not a client credential. Its implicit-handle map
 * is held in a WeakMap and cannot be serialized from the public context object.
 */
export function createStdioConnectionContext(input = {}) {
    assertAllowedKeys(
        input,
        new Set(['principalFingerprint', 'profile', 'epoch', 'randomBytes']),
        'stdio request context',
    );
    const { principalFingerprint, profile, epoch, randomBytes = nodeRandomBytes } = input;
    if (typeof randomBytes !== 'function') {
        throw new TypeError('randomBytes must be a function.');
    }

    let connectionId;
    for (let attempt = 0; attempt < MAX_RANDOM_ATTEMPTS; attempt += 1) {
        const candidate = randomBase64Url(randomBytes, MIN_CONNECTION_ID_BYTES, 'randomBytes');
        if (!activeConnectionIds.has(candidate)) {
            connectionId = candidate;
            activeConnectionIds.add(connectionId);
            break;
        }
    }
    if (!connectionId) {
        throw new RequestContextError('REQUEST_CONTEXT_CONNECTION_ID_COLLISION');
    }

    try {
        return createContext({
            transport: 'stdio',
            principalFingerprint,
            profile,
            epoch,
            connectionId,
        });
    }
    catch (error) {
        activeConnectionIds.delete(connectionId);
        throw error;
    }
}

export function isRequestContext(value) {
    return Boolean(value && typeof value === 'object' && contextStates.has(value));
}

function stateFor(context) {
    const state = contextStates.get(context);
    if (!state) {
        throw new RequestContextError('REQUEST_CONTEXT_INVALID');
    }
    return state;
}

/**
 * Run a callback with a specific request context. This is the only supported
 * source for ambient context; `getRequestContext()` returns undefined outside
 * this callback instead of manufacturing a shared default.
 */
export function runWithRequestContext(context, fn) {
    if (!isRequestContext(context)) {
        throw new RequestContextError('REQUEST_CONTEXT_INVALID');
    }
    if (typeof fn !== 'function') {
        throw new TypeError('fn must be a function.');
    }
    if (stateFor(context).closed) {
        throw new RequestContextError('REQUEST_CONTEXT_CLOSED');
    }
    return requestContextStorage.run(context, fn);
}

/** Return the current request context, or undefined when there is none. */
export function getRequestContext() {
    return requestContextStorage.getStore();
}

/** Return the current request context or fail closed. */
export function requireRequestContext() {
    const context = getRequestContext();
    if (!context) {
        throw new RequestContextError('REQUEST_CONTEXT_REQUIRED');
    }
    if (!isRequestContext(context)) {
        throw new RequestContextError('REQUEST_CONTEXT_INVALID');
    }
    if (stateFor(context).closed) {
        throw new RequestContextError('REQUEST_CONTEXT_CLOSED');
    }
    return context;
}

export function isStdioConnectionClosed(context) {
    return stateFor(context).closed;
}

function requireOpenStdioContext(context) {
    if (!isRequestContext(context) || context.transport !== 'stdio') {
        throw new RequestContextError('REQUEST_CONTEXT_STDIO_REQUIRED');
    }
    const state = stateFor(context);
    if (state.closed) {
        throw new RequestContextError('REQUEST_CONTEXT_CLOSED');
    }
    return state;
}

function normalizeImplicitKey(key) {
    if (typeof key !== 'string' || key.length === 0) {
        throw new TypeError('implicit handle key must be a non-empty string.');
    }
    return key;
}

/** Internal seam for the handle store. HTTP contexts are always rejected. */
export function getStdioImplicitHandle(context, key = 'default') {
    return requireOpenStdioContext(context).implicitHandles.get(normalizeImplicitKey(key));
}

/** Internal seam for the handle store. HTTP contexts are always rejected. */
export function setStdioImplicitHandle(context, key = 'default', handle) {
    requireNonEmptyString(handle, 'handle');
    requireOpenStdioContext(context).implicitHandles.set(normalizeImplicitKey(key), handle);
}

/** Internal seam for the handle store. HTTP contexts are always rejected. */
export function clearStdioImplicitHandle(context, key = 'default') {
    return requireOpenStdioContext(context).implicitHandles.delete(normalizeImplicitKey(key));
}

/** Remove every implicit handle from a stdio connection. */
export function clearStdioImplicitHandles(context) {
    const state = requireOpenStdioContext(context);
    const count = state.implicitHandles.size;
    state.implicitHandles.clear();
    return count;
}

/**
 * Close a stdio connection and drop all of its implicit-handle state. It is
 * intentionally idempotent so transport close/error paths can both call it.
 */
export function closeStdioConnection(context) {
    if (!isRequestContext(context) || context.transport !== 'stdio') {
        throw new RequestContextError('REQUEST_CONTEXT_STDIO_REQUIRED');
    }
    const state = stateFor(context);
    if (state.closed) {
        return false;
    }
    state.implicitHandles.clear();
    state.closed = true;
    activeConnectionIds.delete(context.connectionId);
    return true;
}
