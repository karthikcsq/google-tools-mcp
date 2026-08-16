// Dependency-free error and diagnostic boundary for the SDK migration.

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

export function wrapOperationError(operation, cause, metadata = {}) {
    return new OperationError(operation, {
        code: metadata.code,
        status: metadata.status,
        cause,
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
    let result = value.length > MAX_DIAGNOSTIC_STRING_LENGTH
        ? `${value.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH)}${TRUNCATED}`
        : value;
    result = result.replace(/([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|oauth[_-]?token|session[_-]?token|token|client[_-]?secret|api[_-]?key|google[_-]?api[_-]?key|key|password|credential)=)[^&#\s"']*/gi, `$1${REDACTED}`);
    result = result.replace(/((?:authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|oauth[_-]?token|session[_-]?token|token[_-]?value|token|client[_-]?secret|api[_-]?key|google[_-]?api[_-]?key|private[_-]?key|password|credential|cookie|set[_-]?cookie)\s*[=:]\s*["']?)(?:Bearer\s+)?[^\s,;"'}\]]+/gi, `$1${REDACTED}`);
    result = result.replace(/\bBearer\s+[^\s,;"'}\]]+/gi, `Bearer ${REDACTED}`);
    for (const secret of secrets) result = result.split(secret).join(REDACTED);
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
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'symbol' || typeof value === 'function') return String(value);

    if (context.seen.has(value)) return CIRCULAR;
    context.seen.add(value);

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
        Object.defineProperty(result, key, { value: safeValue, enumerable: true, configurable: true });
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
        Object.defineProperty(result, key, { value: safeValue, enumerable: true, configurable: true });
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
