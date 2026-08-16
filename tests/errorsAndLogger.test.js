import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
    OperationError,
    PublicToolError,
    UserError,
    getPublicErrorMessage,
    getOperationCause,
    isOperationError,
    isPublicError,
    isUserError,
    publicError,
    redactDiagnostic,
    registerSecret,
    resetRegisteredSecretsForTests,
    unregisterSecret,
    wrapOperationError,
} from '../dist/errors.js';
import { logger, refreshLogLevel } from '../dist/logger.js';

const secretValues = [
    'configured-client-secret-value',
    'nested-access-token-value',
    'nested-refresh-token-value',
    'gaxios-api-key-value',
];

const originalLogLevel = process.env.LOG_LEVEL;
const originalClientSecret = process.env.GOOGLE_CLIENT_SECRET;

afterEach(() => {
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
    if (originalClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = originalClientSecret;
    resetRegisteredSecretsForTests();
    refreshLogLevel();
    jest.restoreAllMocks();
});

function expectNoSecrets(value) {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    for (const secret of secretValues) expect(serialized).not.toContain(secret);
    return serialized;
}

describe('local error boundary', () => {
    it('preserves intentional public errors and rejects name/message forgeries', () => {
        const userError = new UserError('Choose a valid document ID.');
        const forgedByName = Object.assign(new Error('Choose a valid document ID.'), { name: 'UserError' });
        const forgedByPrototype = Object.create(UserError.prototype);

        expect(userError).toBeInstanceOf(Error);
        expect(userError.message).toBe('Choose a valid document ID.');
        expect(isUserError(userError)).toBe(true);
        expect(isUserError(forgedByName)).toBe(false);
        expect(isUserError(forgedByPrototype)).toBe(false);
    });

    it('adapts only the immutable construction-time public message', async () => {
        async function adaptToolExecution(execute) {
            try {
                return { content: [{ type: 'text', text: await execute() }] };
            } catch (error) {
                return isPublicError(error)
                    ? { isError: true, content: [{ type: 'text', text: getPublicErrorMessage(error) }] }
                    : { isError: true, content: [{ type: 'text', text: 'The tool failed internally.' }] };
            }
        }

        const intentional = publicError('The document ID is invalid.');
        expect(intentional).toBeInstanceOf(PublicToolError);
        expect(Object.isFrozen(intentional)).toBe(true);
        expect(() => { intentional.message = 'leaked caught text'; }).toThrow(TypeError);
        expect(() => Object.defineProperty(intentional, 'message', { value: 'forged' })).toThrow(TypeError);

        const publicResult = await adaptToolExecution(async () => { throw intentional; });
        const forgedResult = await adaptToolExecution(async () => {
            throw Object.assign(new Error('raw upstream detail'), { name: 'PublicToolError' });
        });
        expect(publicResult.content[0].text).toBe('The document ID is invalid.');
        expect(forgedResult.content[0].text).toBe('The tool failed internally.');
        expect(getPublicErrorMessage(new Error('forged'))).toBeUndefined();
    });

    it('keeps raw operation causes private while retaining safe metadata', () => {
        const cause = new Error(`upstream denied Bearer ${secretValues[1]}`);
        const wrapped = wrapOperationError('read Google document', cause, {
            code: 'UPSTREAM_UNAVAILABLE',
            status: 503,
        });

        expect(wrapped).toBeInstanceOf(OperationError);
        expect(isOperationError(wrapped)).toBe(true);
        expect(wrapped.operation).toBe('read Google document');
        expect(wrapped.code).toBe('UPSTREAM_UNAVAILABLE');
        expect(wrapped.status).toBe(503);
        expect(wrapped.message).toBe('The read Google document operation failed.');
        expect('cause' in wrapped).toBe(false);
        expect(getOperationCause(wrapped)).toBe(cause);
        expect(Object.isFrozen(wrapped)).toBe(true);
        expectNoSecrets(redactDiagnostic(wrapped));
    });
});

describe('diagnostic redaction', () => {
    it('redacts nested gaxios-shaped credentials, configured secret values, and error chains without mutating them', () => {
        process.env.GOOGLE_CLIENT_SECRET = secretValues[0];
        const source = new Error(
            `GET https://example.test/v1/documents?key=${secretValues[3]}&access_token=${secretValues[1]} failed with ${secretValues[0]}`
        );
        source.stack = `Error: Bearer ${secretValues[1]}\n at test (client_secret=${secretValues[0]})`;
        source.cause = Object.assign(new Error(`refresh_token=${secretValues[2]}`), {
            response: {
                data: {
                    error: {
                        status: 'PERMISSION_DENIED',
                        message: `Authorization: Bearer ${secretValues[1]}`,
                    },
                },
            },
        });
        source.config = {
            headers: { Authorization: `Bearer ${secretValues[1]}` },
            params: { key: secretValues[3] },
            clientSecret: secretValues[0],
            requestId: 'diagnostic-id-preserved',
        };

        const redacted = redactDiagnostic(source);
        const output = expectNoSecrets(redacted);

        expect(output).toContain('PERMISSION_DENIED');
        expect(output).toContain('diagnostic-id-preserved');
        expect(source.config.headers.Authorization).toBe(`Bearer ${secretValues[1]}`);
        expect(source.config.params.key).toBe(secretValues[3]);
        expect(source.cause.response.data.error.message).toContain(secretValues[1]);
    });

    it('serializes circular errors and objects without leaking their stack or causes', () => {
        const error = new Error(`token=${secretValues[1]}`);
        error.stack = `Error: token=${secretValues[1]}`;
        error.cause = { refresh_token: secretValues[2] };
        const circular = { error, api_key: secretValues[3] };
        circular.self = circular;

        const redacted = redactDiagnostic(circular, { secrets: [secretValues[1], secretValues[2], secretValues[3]] });
        expect(() => JSON.stringify(redacted)).not.toThrow();
        const output = expectNoSecrets(redacted);
        expect(output).toContain('[Circular]');
        expect(redacted.error.stack).toContain('[REDACTED]');
        expect(redacted.error.cause.refresh_token).toBe('[REDACTED]');
    });

    it.each([
        'authorization',
        'proxyAuthorization',
        'cookie',
        'setCookie',
        'accessToken',
        'refreshToken',
        'oauthToken',
        'sessionToken',
        'tokenValue',
        'clientSecret',
        'apiKey',
        'googleApiKey',
        'privateKey',
    ])('normalizes and redacts the secret-bearing key %s', (key) => {
        const secret = `value-for-${key}`;
        const redacted = redactDiagnostic({ [key]: secret, safeStatus: 'preserved' });
        expect(Object.getPrototypeOf(redacted)).toBeNull();
        expect(redacted[key]).toBe('[REDACTED]');
        expect(redacted.safeStatus).toBe('preserved');
        expect(JSON.stringify(redacted)).not.toContain(secret);
    });

    it('uses null-prototype output and treats __proto__ as data without prototype mutation', () => {
        const source = Object.create(null);
        Object.defineProperty(source, '__proto__', {
            value: { Authorization: 'prototype-secret' },
            enumerable: true,
        });
        const redacted = redactDiagnostic(source);
        expect(Object.getPrototypeOf(redacted)).toBeNull();
        expect(Object.hasOwn(redacted, '__proto__')).toBe(true);
        expect(redacted.__proto__.Authorization).toBe('[REDACTED]');
    });

    it('redacts percent-encoded and nonstandard bearer values through the safe delimiter', () => {
        const bearer = 'abc%2Fdef+ghi==~!@#$%^&*()';
        const redacted = redactDiagnostic(`Authorization: Bearer ${bearer}; request failed`);
        expect(redacted).toBe('Authorization: [REDACTED]; request failed');
        expect(redacted).not.toContain(bearer);
    });

    it('fails closed for hostile proxies and accessors without invoking getters', () => {
        let getterCalls = 0;
        const getterObject = {};
        Object.defineProperty(getterObject, 'details', {
            enumerable: true,
            get() {
                getterCalls += 1;
                throw new Error('getter must not run');
            },
        });
        const ownKeysProxy = new Proxy({}, { ownKeys() { throw new Error('blocked'); } });
        const descriptorProxy = new Proxy({ value: 'secret' }, {
            getOwnPropertyDescriptor() { throw new Error('blocked'); },
        });
        const revoked = Proxy.revocable({}, {});
        revoked.revoke();

        expect(() => redactDiagnostic(getterObject)).not.toThrow();
        expect(redactDiagnostic(getterObject).details).toBe('[Accessor omitted]');
        expect(getterCalls).toBe(0);
        expect(redactDiagnostic(ownKeysProxy)).toBe('[Unserializable diagnostic]');
        expect(redactDiagnostic(descriptorProxy)).toBe('[Unserializable diagnostic]');
        expect(() => redactDiagnostic(revoked.proxy)).not.toThrow();
        expect(redactDiagnostic(revoked.proxy)).toBe('[Unserializable diagnostic]');
    });

    it('bounds diagnostic depth and node count', () => {
        const deep = {};
        let cursor = deep;
        for (let index = 0; index < 20; index += 1) {
            cursor.next = {};
            cursor = cursor.next;
        }
        const wide = Array.from({ length: 1100 }, (_, index) => ({ index }));
        expect(JSON.stringify(redactDiagnostic(deep))).toContain('[Diagnostic truncated]');
        expect(JSON.stringify(redactDiagnostic(wide))).toContain('[Diagnostic truncated]');
    });
});

describe('logger redaction', () => {
    it('redacts every stderr argument while retaining its selected log level', () => {
        process.env.LOG_LEVEL = 'debug';
        process.env.GOOGLE_CLIENT_SECRET = secretValues[0];
        refreshLogLevel();
        const stderr = jest.spyOn(console, 'error').mockImplementation(() => {});
        const error = new Error(`Authorization: Bearer ${secretValues[1]}`);
        error.stack = `Error: client_secret=${secretValues[0]}\nBearer ${secretValues[1]}`;
        error.cause = { api_key: secretValues[3] };

        logger.debug('debug keeps its level', { refresh_token: secretValues[2] });
        logger.error(error, { headers: { authorization: `Bearer ${secretValues[1]}` } });

        expect(stderr).toHaveBeenCalledTimes(2);
        const output = stderr.mock.calls.flat().join('\n');
        expectNoSecrets(output);
        expect(output).toContain('[DEBUG]');
        expect(output).toContain('[ERROR]');
        expect(output).toContain('[REDACTED]');
    });

    it('automatically redacts registered runtime secrets until their scoped registrations end', () => {
        const runtimeSecret = 'runtime-minted-access-value';
        const releaseFirst = registerSecret(runtimeSecret);
        const releaseSecond = registerSecret(runtimeSecret);
        const stderr = jest.spyOn(console, 'error').mockImplementation(() => {});

        logger.info(`first ${runtimeSecret}`);
        releaseFirst();
        logger.info(`second ${runtimeSecret}`);
        expect(stderr.mock.calls.flat().join('\n')).not.toContain(runtimeSecret);

        releaseSecond();
        expect(redactDiagnostic(runtimeSecret)).toBe(runtimeSecret);
        expect(unregisterSecret(runtimeSecret)).toBe(false);
    });

    it('redacts the optional file sink as well as stderr without writing protocol stdout', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-log-'));
        const logPath = join(directory, 'server.log');
        const loggerUrl = pathToFileURL(resolve('dist/logger.js')).href;
        const childMessage = `https://example.test/?key=${secretValues[3]} Authorization: Bearer ${secretValues[1]} ${secretValues[0]}`;
        const script = [
            `import { logger } from ${JSON.stringify(loggerUrl)};`,
            `logger.error(new Error(${JSON.stringify(childMessage)}));`,
        ].join('\n');

        try {
            const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
                cwd: resolve('.'),
                encoding: 'utf8',
                env: {
                    ...process.env,
                    GOOGLE_MCP_LOG_FILE: logPath,
                    GOOGLE_CLIENT_SECRET: secretValues[0],
                    LOG_LEVEL: 'debug',
                },
            });
            expect(child.status).toBe(0);
            expect(child.stdout).toBe('');
            expectNoSecrets(child.stderr);
            expectNoSecrets(await readFile(logPath, 'utf8'));
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('handles asynchronous file-stream errors without crashing or writing stdout', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-log-error-'));
        const loggerUrl = pathToFileURL(resolve('dist/logger.js')).href;
        const script = [
            `import { logger } from ${JSON.stringify(loggerUrl)};`,
            `logger.error('before stream error');`,
            `await new Promise((resolve) => setTimeout(resolve, 25));`,
            `logger.error('after stream error');`,
        ].join('\n');

        try {
            const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
                cwd: resolve('.'),
                encoding: 'utf8',
                env: { ...process.env, GOOGLE_MCP_LOG_FILE: directory },
            });
            expect(child.status).toBe(0);
            expect(child.stdout).toBe('');
            expect(child.stderr).toContain('before stream error');
            expect(child.stderr).toContain('after stream error');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
