// Dependency-free error and diagnostic boundary for the SDK migration.
import * as os from 'os';

const publicMessages = new WeakMap();
const operationErrorBrand = new WeakSet();
const operationCauses = new WeakMap();
const registeredSecrets = new Map();

const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';
const TRUNCATED = '[Diagnostic truncated]';
const UNSERIALIZABLE = '[Unserializable diagnostic]';
const MAX_DIAGNOSTIC_DEPTH = 12;
const MAX_DIAGNOSTIC_NODES = 1000;
const MAX_DIAGNOSTIC_STRING_LENGTH = 65_536;
const SECRET_ENVIRONMENT_KEY = /(?:token|secret|api[_-]?key|password|credential|private[_-]?key|authorization|cookie)/i;
const NATIVE_ERROR_STACK_GETTER = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;

function safeOperation(value) {
    return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9 .:/_-]{0,119}$/.test(value)
        ? value
        : 'operation';
}

function safeCode(value) {
    return typeof value === 'string' && /^[A-Z][A-Z0-9_:-]{0,79}$/.test(value)
        ? value
        : undefined;
}

function optionalStatus(value) {
    return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

/** An error whose immutable message is explicitly safe for an MCP caller. */
export class PublicToolError extends Error {
    constructor(safeMessage) {
        const snapshot = String(safeMessage);
        super(snapshot);
        this.name = 'PublicToolError';
        publicMessages.set(this, snapshot);
        Object.freeze(this);
    }
}

export function publicError(safeMessage) {
    return new PublicToolError(safeMessage);
}

export function isPublicError(error) {
    return typeof error === 'object' && error !== null && publicMessages.has(error);
}

/** Return the immutable, construction-time message only for a branded error. */
export function getPublicErrorMessage(error) {
    return isPublicError(error) ? publicMessages.get(error) : undefined;
}

// Temporary migration compatibility. New boundary code should use the public
// names above so arbitrary caught text is never branded by mechanical habit.
export const UserError = PublicToolError;
export const isUserError = isPublicError;

/** An internal error carrying only frozen, validated operational metadata. */
export class OperationError extends Error {
    constructor(operation, options = {}) {
        const operationName = safeOperation(operation);
        super(`The ${operationName} operation failed.`);

        const metadata = {
            name: 'OperationError',
            operation: operationName,
        };
        const code = safeCode(options.code);
        if (code) metadata.code = code;
        const status = optionalStatus(options.status);
        if (status !== undefined) metadata.status = status;

        Object.assign(this, metadata);
        operationErrorBrand.add(this);
        if (options.cause !== undefined) operationCauses.set(this, options.cause);
        Object.freeze(this);
    }
}

export function isOperationError(error) {
    return typeof error === 'object' && error !== null && operationErrorBrand.has(error);
}

export function getOperationCause(error) {
    return isOperationError(error) ? operationCauses.get(error) : undefined;
}

/**
 * Find a cause without asking callers to depend on OperationError's private
 * WeakMap storage.  Ordinary Error#cause and our operation wrapper can be
 * mixed freely, so every boundary that needs to classify an upstream failure
 * sees the original Google response rather than only an outer operation name.
 */
export function findErrorCause(error, predicate) {
    const seen = new WeakSet();
    let current = error;
    for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
        if (seen.has(current)) return undefined;
        seen.add(current);
        try {
            if (predicate(current)) return current;
        } catch {
            return undefined;
        }
        let next;
        try {
            next = isOperationError(current) ? getOperationCause(current) : current.cause;
        } catch {
            return undefined;
        }
        current = next;
    }
    return undefined;
}

export function wrapOperationError(operation, cause, metadata = {}) {
    return new OperationError(operation, {
        code: metadata.code,
        status: metadata.status,
        cause,
    });
}

/**
 * Extract the Google API's own account of a failure from the structured error
 * payload every googleapis client attaches to a rejected request
 * (`error.response.data.error`). That `message` is validated upstream detail —
 * the API describing what was wrong with the request — and is the only part of
 * a caught API error that may cross the public boundary.
 *
 * The thrown object's own `error.message` is deliberately NOT consulted: it is
 * arbitrary internal text (filesystem paths, resolved hosts, request
 * internals) that the redactor cannot recognise as sensitive. A call site that
 * gets `null` back has no validated detail to show and must fall through to
 * `wrapOperationError` rather than reaching for `error.message`.
 *
 * @returns {{ description: string, code: number | undefined } | null}
 */
export function getApiErrorDetail(error) {
    let description;
    let rawCode;
    try {
        const payload = error?.response?.data?.error;
        description = payload?.message;
        rawCode = payload?.code;
    } catch {
        // A hostile or exotic error object must not break the error path.
        return null;
    }
    if (typeof description !== 'string' || description.length === 0) return null;
    return { description, code: Number.isInteger(rawCode) ? rawCode : undefined };
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'RESOURCE_EXHAUSTED']);
const QUOTA_EXHAUSTED_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'DAILY_LIMIT_EXCEEDED']);
const AUTH_REASONS = new Set(['authError', 'invalidCredentials', 'UNAUTHENTICATED']);
const PERMISSION_REASONS = new Set(['forbidden', 'domainPolicy', 'PERMISSION_DENIED']);
const NOT_FOUND_REASONS = new Set(['notFound', 'NOT_FOUND']);
const CONFLICT_REASONS = new Set(['conflict', 'ABORTED', 'ALREADY_EXISTS']);
const PRECONDITION_REASONS = new Set(['failedPrecondition', 'conditionNotMet', 'FAILED_PRECONDITION']);
const UNAVAILABLE_REASONS = new Set(['backendError', 'internalError', 'SERVICE_UNAVAILABLE', 'UNAVAILABLE']);

function classifySafeUpstreamFailure({ code, status, retryable, reason, message }) {
    return Object.freeze({ code, status, retryable, reason, message });
}

function upstreamStatus(error) {
    try {
        for (const candidate of [error?.response?.status, error?.response?.data?.error?.code, error?.status, error?.code]) {
            const status = optionalStatus(candidate);
            if (status !== undefined) return status;
        }
    } catch {
        // A hostile error object has no caller-visible API classification.
    }
    return undefined;
}

function upstreamReasons(error) {
    const reasons = new Set();
    try {
        const payload = error?.response?.data?.error;
        if (typeof payload?.status === 'string') reasons.add(payload.status);
        if (typeof payload?.reason === 'string') reasons.add(payload.reason);
        if (Array.isArray(payload?.errors)) {
            for (const detail of payload.errors) {
                if (typeof detail?.reason === 'string') reasons.add(detail.reason);
            }
        }
    } catch {
        // The status alone remains safe to classify when shape access fails.
    }
    return reasons;
}

/**
 * Convert a Google-shaped failure into a closed, safe contract.  This never
 * returns an API message, request URL, stack, or arbitrary Error#message.
 * Callers can therefore give retry guidance without turning diagnostics into
 * a dump of upstream data.
 */
export function classifyUpstreamError(error) {
    let status;
    const reasons = new Set();
    findErrorCause(error, (candidate) => {
        status ??= upstreamStatus(candidate);
        for (const reason of upstreamReasons(candidate)) reasons.add(reason);
        return false;
    });
    if (status === undefined && reasons.size === 0) return null;

    const hasReason = (known) => [...reasons].some((reason) => known.has(reason));
    if (hasReason(RATE_LIMIT_REASONS) || status === 429) {
        return classifySafeUpstreamFailure({
            code: 'RATE_LIMITED', status: status ?? 429, retryable: true, reason: 'rate-limit',
            message: 'Google API rate limit reached. Retry with exponential backoff.',
        });
    }
    if (hasReason(QUOTA_EXHAUSTED_REASONS)) {
        return classifySafeUpstreamFailure({
            code: 'QUOTA_EXHAUSTED', status: status ?? 403, retryable: false, reason: 'quota-exhausted',
            message: 'Google API quota is exhausted. Wait for the quota reset or adjust the project quota before retrying.',
        });
    }
    if (hasReason(AUTH_REASONS) || status === 401) {
        return classifySafeUpstreamFailure({
            code: 'AUTHENTICATION_REQUIRED', status: status ?? 401, retryable: false, reason: 'authentication-required',
            message: 'Google API authentication is required. Run the auth command, then retry.',
        });
    }
    if (hasReason(PERMISSION_REASONS) || status === 403) {
        return classifySafeUpstreamFailure({
            code: 'PERMISSION_DENIED', status: status ?? 403, retryable: false, reason: 'permission-denied',
            message: 'Google API permission was denied. Verify account access and API policy before retrying.',
        });
    }
    if (hasReason(NOT_FOUND_REASONS) || status === 404) {
        return classifySafeUpstreamFailure({
            code: 'NOT_FOUND', status: status ?? 404, retryable: false, reason: 'not-found',
            message: 'The requested Google resource was not found. Refresh its identifier before retrying.',
        });
    }
    if (hasReason(CONFLICT_REASONS) || status === 409) {
        return classifySafeUpstreamFailure({
            code: 'CONFLICT', status: status ?? 409, retryable: false, reason: 'conflict',
            message: 'Google rejected the request because the resource changed. Read the latest state before retrying.',
        });
    }
    if (hasReason(PRECONDITION_REASONS) || status === 412) {
        return classifySafeUpstreamFailure({
            code: 'PRECONDITION_FAILED', status: status ?? 412, retryable: false, reason: 'precondition-failed',
            message: 'Google rejected a required precondition. Read the latest state before retrying.',
        });
    }
    if (hasReason(UNAVAILABLE_REASONS) || (status !== undefined && status >= 500)) {
        return classifySafeUpstreamFailure({
            code: 'SERVICE_UNAVAILABLE', status: status ?? 503, retryable: true, reason: 'service-unavailable',
            message: 'Google API is temporarily unavailable. Retry this read after a short delay.',
        });
    }
    if (status === 400) {
        return classifySafeUpstreamFailure({
            code: 'INVALID_REQUEST', status, retryable: false, reason: 'invalid-request',
            message: 'Google rejected the request. Check the supplied parameters before retrying.',
        });
    }
    return classifySafeUpstreamFailure({
        code: 'UPSTREAM_FAILURE', status: status ?? 502, retryable: false, reason: 'upstream-failure',
        message: 'Google API could not complete the request. Check diagnostics before retrying.',
    });
}

/** Register a runtime credential that must be removed from all diagnostics. */
export function registerSecret(secret) {
    if (typeof secret !== 'string' || secret.length === 0) return () => {};
    registeredSecrets.set(secret, (registeredSecrets.get(secret) || 0) + 1);
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        unregisterSecret(secret);
    };
}

export function unregisterSecret(secret) {
    const count = registeredSecrets.get(secret);
    if (!count) return false;
    if (count === 1) registeredSecrets.delete(secret);
    else registeredSecrets.set(secret, count - 1);
    return true;
}

export function resetRegisteredSecretsForTests() {
    registeredSecrets.clear();
}

function normalizeKey(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSecretKey(key) {
    const normalized = normalizeKey(key);
    if (normalized === 'key') return true;
    return normalized.includes('authorization')
        || normalized.includes('cookie')
        || normalized.includes('token')
        || normalized.includes('secret')
        || normalized.includes('apikey')
        || normalized.includes('privatekey')
        || normalized.includes('password')
        || normalized.includes('passphrase')
        || normalized.includes('credential');
}

function configuredSecrets() {
    try {
        return Object.entries(process.env)
            .filter(([key, value]) => SECRET_ENVIRONMENT_KEY.test(key) && typeof value === 'string' && value.length > 0)
            .map(([, value]) => value);
    } catch {
        return [];
    }
}

function collectSecrets(extraSecrets) {
    const values = [...configuredSecrets(), ...registeredSecrets.keys()];
    try {
        if (Array.isArray(extraSecrets)) {
            for (const secret of extraSecrets) {
                if (typeof secret === 'string' && secret.length > 0) values.push(secret);
            }
        }
    } catch {
        // A hostile options proxy must not break logging.
    }
    return [...new Set(values)].sort((left, right) => right.length - left.length);
}

function redactString(value, secrets) {
    // Redact the FULL string before truncating, with no intermediate
    // fixed-offset clamp of any kind. Any slice applied before the redaction
    // passes run — no matter how large — cuts at a predictable offset, and a
    // secret whose bytes straddle that cut keeps its surviving prefix in the
    // output: the exact-match `split(secret)` below can no longer find the
    // *complete* registered secret once it has been cut, and an unlabeled
    // fragment won't match the labeled-pattern regexes either. That is true
    // whether the clamp is 65,536 chars or 1,048,576 — a fixed offset is a
    // fixed offset. The only way to guarantee a secret can't be split is to
    // let every redaction pass see every character of the input at least
    // once before anything is cut.
    //
    // Cost: the regexes and the per-secret split/join loop below are O(length)
    // (and O(length * secret count) for the loop), so a pathological
    // multi-megabyte diagnostic string means more work than the old
    // truncate-first order. This function only runs on the error/diagnostic
    // path (bounded per call by MAX_DIAGNOSTIC_NODES), never on the request
    // hot path, so a bounded number of full linear passes over a large string
    // is an acceptable, deterministic cost for a guarantee that holds
    // regardless of where a secret happens to land.
    let result = value;
    result = result.replace(/([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|oauth[_-]?token|session[_-]?token|token|client[_-]?secret|api[_-]?key|google[_-]?api[_-]?key|key|password|credential)=)[^&#\s"']*/gi, `$1${REDACTED}`);
    result = result.replace(/((?:authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|oauth[_-]?token|session[_-]?token|token[_-]?value|token|client[_-]?secret|api[_-]?key|google[_-]?api[_-]?key|private[_-]?key|password|credential|cookie|set[_-]?cookie)\s*[=:]\s*["']?)(?:Bearer\s+)?[^\s,;"'}\]]+/gi, `$1${REDACTED}`);
    result = result.replace(/\bBearer\s+[^\s,;"'}\]]+/gi, `Bearer ${REDACTED}`);
    for (const secret of secrets) result = result.split(secret).join(REDACTED);

    const home = os.homedir();
    if (home) {
        const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(`^${escaped}(?=$|[\\\\/])`, 'i'), '~')
            .replace(new RegExp(`([\\s"'=(/:])${escaped}(?=$|[\\\\/])`, 'gi'), '$1~');
    }

    if (result.length > MAX_DIAGNOSTIC_STRING_LENGTH) {
        result = `${result.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH)}${TRUNCATED}`;
    }
    return result;
}

function safeOwnKeys(value) {
    try {
        return Object.keys(value);
    } catch {
        return null;
    }
}

function readProperty(object, key) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || !('value' in descriptor)) return { ok: false, value: '[Accessor omitted]' };
        return { ok: true, value: descriptor.value };
    } catch {
        return { ok: false, value: '[Unserializable property]' };
    }
}

function safeTypeCheck(check) {
    try {
        return check();
    } catch {
        return false;
    }
}

function visit(value, context, depth) {
    context.nodes += 1;
    if (context.nodes > MAX_DIAGNOSTIC_NODES || depth > MAX_DIAGNOSTIC_DEPTH) return TRUNCATED;

    if (typeof value === 'string') return redactString(value, context.secrets);
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'undefined') return undefined;
    // bigint, symbol, and function values are stringified for the diagnostic —
    // a Symbol's description or a function's source can embed a registered
    // secret (e.g. `Symbol(secret)` or a closure whose source literally
    // contains it), so every stringification here goes through the same
    // redactString() pass a plain string value gets, not a bare String(value).
    if (typeof value === 'bigint') return redactString(String(value), context.secrets);
    if (typeof value === 'symbol' || typeof value === 'function') return redactString(String(value), context.secrets);

    // `seen` holds the ancestors of the node being visited, not every node
    // ever visited: only a reference back to an ancestor is a cycle. Marking
    // every visited object permanently turned any SHARED reference into
    // "[Circular]", and `doctor --json` shares one `launch.args` array between
    // every client's recommended entry, so the second client's recommended
    // args printed as the string "[Circular]". The node budget above still
    // bounds a heavily shared graph.
    if (context.seen.has(value)) return CIRCULAR;
    context.seen.add(value);
    try {
        return visitObject(value, context, depth);
    } finally {
        context.seen.delete(value);
    }
}

function visitObject(value, context, depth) {
    if (safeTypeCheck(() => value instanceof URL)) {
        try {
            return redactString(value.href, context.secrets);
        } catch {
            return UNSERIALIZABLE;
        }
    }
    if (safeTypeCheck(() => value instanceof Error)) return serializeError(value, context, depth);

    let isArray = false;
    try {
        isArray = Array.isArray(value);
    } catch {
        return UNSERIALIZABLE;
    }
    if (isArray) {
        const result = [];
        let length;
        try {
            length = Math.min(value.length, MAX_DIAGNOSTIC_NODES - context.nodes);
        } catch {
            return UNSERIALIZABLE;
        }
        for (let index = 0; index < length; index += 1) {
            const property = readProperty(value, String(index));
            result.push(property.ok ? visit(property.value, context, depth + 1) : property.value);
        }
        if (length < value.length) result.push(TRUNCATED);
        return result;
    }

    return serializeObject(value, context, depth);
}

function serializeObject(value, context, depth) {
    const keys = safeOwnKeys(value);
    if (!keys) return UNSERIALIZABLE;
    const result = Object.create(null);
    for (const key of keys) {
        if (context.nodes >= MAX_DIAGNOSTIC_NODES) {
            Object.defineProperty(result, 'truncated', { value: TRUNCATED, enumerable: true });
            break;
        }
        context.nodes += 1;
        const property = readProperty(value, key);
        const safeValue = isSecretKey(key)
            ? REDACTED
            : property.ok
                ? visit(property.value, context, depth + 1)
                : property.value;
        // The key name itself is also attacker-influenceable data (an object
        // literally keyed by a secret value) and is never passed through
        // redactString elsewhere in this function, so redact it too before
        // using it as the emitted property name.
        const safeKey = redactString(key, context.secrets);
        Object.defineProperty(result, safeKey, { value: safeValue, enumerable: true, configurable: true });
    }
    return result;
}

function serializeError(error, context, depth) {
    const result = Object.create(null);
    const name = readProperty(error, 'name');
    const message = readProperty(error, 'message');
    const stack = readErrorStack(error);
    Object.defineProperty(result, 'name', {
        value: redactString(String(name.ok ? name.value : 'Error'), context.secrets), enumerable: true,
    });
    Object.defineProperty(result, 'message', {
        value: redactString(String(message.ok ? message.value : ''), context.secrets), enumerable: true,
    });
    if (stack.ok && typeof stack.value === 'string') {
        Object.defineProperty(result, 'stack', {
            value: redactString(stack.value, context.secrets), enumerable: true,
        });
    }

    const keys = safeOwnKeys(error);
    if (!keys) return UNSERIALIZABLE;
    for (const key of keys) {
        if (key === 'name' || key === 'message' || key === 'stack') continue;
        if (context.nodes >= MAX_DIAGNOSTIC_NODES) {
            Object.defineProperty(result, 'truncated', { value: TRUNCATED, enumerable: true });
            break;
        }
        context.nodes += 1;
        const property = readProperty(error, key);
        const safeValue = isSecretKey(key)
            ? REDACTED
            : property.ok
                ? visit(property.value, context, depth + 1)
                : property.value;
        const safeKey = redactString(key, context.secrets);
        Object.defineProperty(result, safeKey, { value: safeValue, enumerable: true, configurable: true });
    }

    const cause = readProperty(error, 'cause');
    if (cause.ok && !Object.hasOwn(result, 'cause')) {
        Object.defineProperty(result, 'cause', {
            value: visit(cause.value, context, depth + 1), enumerable: true,
        });
    }
    return result;
}

function readErrorStack(error) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(error, 'stack');
        if (!descriptor) return { ok: false, value: undefined };
        if ('value' in descriptor) return { ok: true, value: descriptor.value };
        if (descriptor.get && descriptor.get === NATIVE_ERROR_STACK_GETTER) {
            return { ok: true, value: descriptor.get.call(error) };
        }
        return { ok: false, value: '[Accessor omitted]' };
    } catch {
        return { ok: false, value: '[Unserializable property]' };
    }
}

/** Return a bounded, non-mutating, null-prototype diagnostic that never throws. */
export function redactDiagnostic(value, options = {}) {
    try {
        let extraSecrets = [];
        try {
            extraSecrets = options?.secrets;
        } catch {
            extraSecrets = [];
        }
        return visit(value, {
            secrets: collectSecrets(extraSecrets),
            seen: new WeakSet(),
            nodes: 0,
        }, 0);
    } catch {
        return UNSERIALIZABLE;
    }
}

export const REDACTED_DIAGNOSTIC_VALUE = REDACTED;
