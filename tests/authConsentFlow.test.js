// Regression tests for issue #115: authenticate() must always request
// re-consent (so Google is asked to mint a refresh token even for a
// returning user) and must never report "Authentication successful!" when
// no refresh token comes back.
//
// This exercises the real interactive OAuth flow in dist/auth.js end to end:
// a real localhost HTTP server is started (as the real flow does) and driven
// with a real HTTP GET to its callback URL, mirroring the browser redirect.
// Only 'google-auth-library' (network calls and the OAuth2 client), 'child_process'
// (browser opener), and 'fs/promises' (credential persistence) are mocked,
// the same boundary legacyAliasAuthRetry.test.js uses for the equivalent
// production auth-retry path.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import http from 'node:http';
import { createHash } from 'node:crypto';

let readFileImpl;
let writeFileCalls;
let unlinkCalls;
let mkdirCalls;
let chmodCalls;

jest.unstable_mockModule('fs/promises', () => ({
    readFile: (...args) => readFileImpl(...args),
    writeFile: (...args) => { writeFileCalls.push(args); return Promise.resolve(); },
    mkdir: (...args) => { mkdirCalls.push(args); return Promise.resolve(); },
    chmod: (...args) => { chmodCalls.push(args); return Promise.resolve(); },
    open: (filePath) => Promise.resolve({
        writeFile: (...args) => { writeFileCalls.push([filePath, ...args]); return Promise.resolve(); },
        sync: () => Promise.resolve(),
        close: () => Promise.resolve(),
    }),
    rename: () => Promise.resolve(),
    unlink: (...args) => { unlinkCalls.push(args); return Promise.resolve(); },
}));

let execFileCalls;
jest.unstable_mockModule('child_process', () => ({
    // The browser opener now goes through shellSafe's runArgv, which uses
    // execFile rather than exec (issue #125). Without this export the whole
    // suite fails to link, and without recording the argv a real browser would
    // open during the test. Signature is execFile(command, args, options, cb).
    execFile: (command, args, options, cb) => {
        execFileCalls.push([command, ...(args ?? [])]);
        if (typeof cb === 'function') cb(null, '', '');
    },
}));

let oauth2Instances;
let getTokenImpl;
let refreshAccessTokenImpl;

class MockOAuth2 {
    constructor(client_id, client_secret, redirectUri) {
        this.client_id = client_id;
        this.client_secret = client_secret;
        this.redirectUri = redirectUri;
        this.credentials = {};
        oauth2Instances.push(this);
    }
    generateAuthUrl(opts) {
        this.lastAuthUrlOpts = opts;
        return 'https://accounts.google.com/o/oauth2/v2/auth?mock=1';
    }
    async getToken(options) {
        // authenticate() now passes { code, codeVerifier } so PKCE reaches the
        // exchange; recorded here so a test can assert the verifier is sent.
        this.lastGetTokenOptions = options;
        return getTokenImpl(options);
    }
    setCredentials(creds) {
        this.credentials = { ...this.credentials, ...creds };
    }
    async refreshAccessToken() {
        return refreshAccessTokenImpl();
    }
}

// auth.js takes OAuth2Client straight from google-auth-library now that the
// umbrella googleapis package is gone (#71), so the OAuth2 stand-in belongs in
// this factory. A module gets exactly one factory, and every name the code
// under test imports from it has to be present or the suite fails to link.
jest.unstable_mockModule('google-auth-library', () => ({
    JWT: class {},
    OAuth2Client: MockOAuth2,
}));

const authModule = await import('../dist/auth.js');
const { logger } = await import('../dist/logger.js');

const ENV_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_MCP_OAUTH_PORT', 'SERVICE_ACCOUNT_PATH'];
let savedEnv;

beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    delete process.env.GOOGLE_MCP_OAUTH_PORT;
    delete process.env.SERVICE_ACCOUNT_PATH;

    oauth2Instances = [];
    writeFileCalls = [];
    unlinkCalls = [];
    mkdirCalls = [];
    chmodCalls = [];
    execFileCalls = [];
    getTokenImpl = async () => { throw new Error('getTokenImpl not configured for this test'); };
    refreshAccessTokenImpl = async () => { throw new Error('refreshAccessTokenImpl not configured for this test'); };
    readFileImpl = async () => {
        const err = new Error('ENOENT: no such file');
        err.code = 'ENOENT';
        throw err;
    };
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
});

// The browser-flow OAuth2 client is the one constructed with a redirectUri
// (the 3rd constructor arg); the saved-credentials client authorize() may
// construct first only ever gets 2 args. Waits for it, then drives its
// local callback server with a real HTTP request, the same way Google's
// redirect would.
//
// By default it echoes back the `state` that authenticate() put on the
// authorization URL, which is what a genuine Google redirect does. Pass an
// explicit `state` (including '') to forge a callback that does not belong to
// this flow. `expectStatus` lets a test assert the HTTP status the callback
// server returned, since a rejected callback answers 400 and deliberately
// leaves the flow running.
async function waitForBrowserFlowClient() {
    const deadline = Date.now() + 2000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const instance = oauth2Instances.find((candidate) => candidate.redirectUri && !candidate.callbackDriven);
        if (instance) return instance;
        if (Date.now() > deadline) throw new Error('Timed out waiting for the browser-flow OAuth2 client');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

async function driveOAuthCallback({ code, error, state, markDriven = true, expectStatus } = {}) {
    const instance = await waitForBrowserFlowClient();
    if (markDriven) instance.callbackDriven = true;
    const url = new URL(instance.redirectUri);
    if (code) url.searchParams.set('code', code);
    if (error) url.searchParams.set('error', error);
    const stateToSend = state === undefined ? instance.lastAuthUrlOpts?.state : state;
    if (stateToSend) url.searchParams.set('state', stateToSend);
    const status = await new Promise((resolve, reject) => {
        http.get(url, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        }).on('error', reject);
    });
    if (expectStatus !== undefined && status !== expectStatus) {
        throw new Error(`Callback returned HTTP ${status}, expected ${expectStatus}`);
    }
    instance.lastCallbackStatus = status;
    return instance;
}

describe('auth.js interactive OAuth consent flow (issue #115)', () => {
    it('requests re-consent on every authenticate() call, including via runAuthFlow (the explicit `google-tools-mcp auth` path)', async () => {
        // index.js's `auth` subcommand calls runAuthFlow() directly with no
        // special-casing, so this covers that CLI path too.
        getTokenImpl = async () => ({ tokens: { access_token: 'AT', refresh_token: 'RT' } });

        const clientPromise = authModule.runAuthFlow();
        const instance = await driveOAuthCallback({ code: 'auth-code-explicit' });
        await clientPromise;

        expect(instance.lastAuthUrlOpts).toMatchObject({ access_type: 'offline', prompt: 'consent' });
        expect(execFileCalls).toHaveLength(1);
        expect(execFileCalls[0].join(' ')).toContain('accounts.google.com');
    });

    it('requests re-consent on the invalid_grant recovery path', async () => {
        // Seed a saved (but now-revoked) token so authorize() takes the
        // refresh -> invalid_grant -> delete -> re-authenticate path.
        readFileImpl = async (filePath) => {
            if (String(filePath).endsWith('token.json')) {
                return JSON.stringify({
                    type: 'authorized_user',
                    client_id: 'test-client-id',
                    client_secret: 'test-client-secret',
                    refresh_token: 'stale-refresh-token',
                    scopes: authModule.SCOPES,
                });
            }
            const err = new Error('ENOENT: no such file');
            err.code = 'ENOENT';
            throw err;
        };
        refreshAccessTokenImpl = async () => {
            throw new Error('invalid_grant: Token has been expired or revoked.');
        };
        getTokenImpl = async () => ({ tokens: { access_token: 'AT2', refresh_token: 'RT2' } });

        const clientPromise = authModule.authorize();
        const instance = await driveOAuthCallback({ code: 'auth-code-recovery' });
        await clientPromise;

        expect(instance.lastAuthUrlOpts).toMatchObject({ prompt: 'consent' });
        // The revoked token.json was deleted before retrying.
        expect(unlinkCalls.length).toBeGreaterThan(0);
    });

    it('throws instead of reporting success when the exchange returns no refresh_token, and does not save credentials', async () => {
        getTokenImpl = async () => ({ tokens: { access_token: 'AT3' } }); // no refresh_token
        const infoSpy = jest.spyOn(logger, 'info');

        const clientPromise = authModule.runAuthFlow();
        // Attach a handler synchronously so Node never sees this as an
        // unhandled rejection while driveOAuthCallback's HTTP round trip is
        // in flight — the real assertion below still awaits the same promise.
        clientPromise.catch(() => {});
        await driveOAuthCallback({ code: 'auth-code-no-refresh' });

        await expect(clientPromise).rejects.toThrow(/refresh token/i);
        expect(writeFileCalls).toHaveLength(0);
        expect(infoSpy.mock.calls.some(([message]) => message === 'Authentication successful!')).toBe(false);

        infoSpy.mockRestore();
    });

    it('saves credentials and succeeds on a normal exchange that returns a refresh token', async () => {
        getTokenImpl = async () => ({ tokens: { access_token: 'AT4', refresh_token: 'RT4' } });
        const infoSpy = jest.spyOn(logger, 'info');

        const clientPromise = authModule.runAuthFlow();
        await driveOAuthCallback({ code: 'auth-code-normal' });
        const client = await clientPromise;

        expect(client).toBeDefined();
        expect(writeFileCalls).toHaveLength(1);
        const savedPayload = JSON.parse(writeFileCalls[0][1]);
        expect(savedPayload.refresh_token).toBe('RT4');
        expect(chmodCalls).toEqual(expect.arrayContaining([
            [expect.stringMatching(/[\\/]google-tools-mcp$/), 0o700],
            [expect.stringMatching(/[\\/]google-tools-mcp[\\/]token\.json$/), 0o600],
        ]));
        expect(infoSpy.mock.calls.some(([message]) => message === 'Authentication successful!')).toBe(true);

        infoSpy.mockRestore();
    });
});

// The loopback redirect server used to accept any request carrying a `code`.
// During the five-minute window, a page the user happens to visit could point
// their browser at http://localhost:<port>/?code=<attacker's code>; the
// exchange succeeded and this server persisted the ATTACKER's refresh token,
// so every later tool call ran against someone else's Google account.
describe('auth.js binds the OAuth callback to the request that started it', () => {
    it('puts a unique, non-guessable state and an S256 PKCE challenge on the authorization URL', async () => {
        getTokenImpl = async () => ({ tokens: { access_token: 'AT', refresh_token: 'RT' } });

        const first = authModule.runAuthFlow();
        const a = await driveOAuthCallback({ code: 'code-a' });
        await first;

        const second = authModule.runAuthFlow();
        const b = await driveOAuthCallback({ code: 'code-b' });
        await second;

        for (const opts of [a.lastAuthUrlOpts, b.lastAuthUrlOpts]) {
            expect(typeof opts.state).toBe('string');
            expect(opts.state.length).toBeGreaterThanOrEqual(32);
            expect(opts.code_challenge_method).toBe('S256');
            expect(typeof opts.code_challenge).toBe('string');
        }
        // A state reused between flows would be guessable from a single observation.
        expect(a.lastAuthUrlOpts.state).not.toBe(b.lastAuthUrlOpts.state);
        expect(a.lastAuthUrlOpts.code_challenge).not.toBe(b.lastAuthUrlOpts.code_challenge);
    });

    it('sends the PKCE code_verifier on the token exchange, and it matches the challenge it advertised', async () => {
        getTokenImpl = async () => ({ tokens: { access_token: 'AT', refresh_token: 'RT' } });

        const clientPromise = authModule.runAuthFlow();
        const instance = await driveOAuthCallback({ code: 'code-pkce' });
        await clientPromise;

        expect(instance.lastGetTokenOptions).toMatchObject({ code: 'code-pkce' });
        const verifier = instance.lastGetTokenOptions.codeVerifier;
        expect(typeof verifier).toBe('string');
        // S256: challenge === base64url(sha256(verifier)). A verifier that does
        // not derive the advertised challenge protects nothing.
        expect(createHash('sha256').update(verifier).digest('base64url'))
            .toBe(instance.lastAuthUrlOpts.code_challenge);
    });

    it('ignores a forged callback that carries a code but the wrong state, and still accepts the real redirect afterwards', async () => {
        getTokenImpl = async () => ({ tokens: { access_token: 'AT', refresh_token: 'RT' } });
        const warnSpy = jest.spyOn(logger, 'warn');

        const clientPromise = authModule.runAuthFlow();

        // The attack: right code shape, state that never belonged to this flow.
        // markDriven:false keeps the flow open so the next call can be the real one.
        await driveOAuthCallback({
            code: 'attacker-authorization-code', state: 'not-the-state-we-issued',
            markDriven: false, expectStatus: 400,
        });

        // The flow must still be waiting, not resolved with the attacker's code.
        const instance = await waitForBrowserFlowClient();
        expect(instance.lastGetTokenOptions).toBeUndefined();

        // The genuine redirect still completes normally.
        await driveOAuthCallback({ code: 'the-real-code', expectStatus: 200 });
        await clientPromise;

        expect(instance.lastGetTokenOptions.code).toBe('the-real-code');
        expect(warnSpy.mock.calls.some(([m]) => /state did not match/i.test(String(m)))).toBe(true);
        warnSpy.mockRestore();
    });

    it('ignores a forged callback carrying no state at all rather than failing the flow', async () => {
        getTokenImpl = async () => ({ tokens: { access_token: 'AT', refresh_token: 'RT' } });

        const clientPromise = authModule.runAuthFlow();
        const instance = await waitForBrowserFlowClient();

        await driveOAuthCallback({ code: 'no-state-code', state: '', markDriven: false, expectStatus: 400 });
        await driveOAuthCallback({ code: 'the-real-code', expectStatus: 200 });
        await clientPromise;

        expect(instance.lastGetTokenOptions.code).toBe('the-real-code');
    });

    it('ignores a forged `error` callback, so nobody who can reach the port can cancel a sign-in in progress', async () => {
        getTokenImpl = async () => ({ tokens: { access_token: 'AT', refresh_token: 'RT' } });

        const clientPromise = authModule.runAuthFlow();
        await driveOAuthCallback({ error: 'access_denied', state: 'wrong', markDriven: false, expectStatus: 400 });
        await driveOAuthCallback({ code: 'survived', expectStatus: 200 });

        await expect(clientPromise).resolves.toBeDefined();
    });
});

// dist/clients.js has always known how to render a `port_in_use` remedy for
// EADDRINUSE, but authenticate() awaited a resolve-only listen Promise, so the
// error was never delivered to a caller: the flow hung for the life of the
// process and index.js's uncaughtException handler just logged it.
describe('auth.js reports a busy OAuth callback port instead of hanging', () => {
    let blocker;

    afterEach(async () => {
        if (blocker) await new Promise((resolve) => blocker.close(resolve));
        blocker = null;
    });

    it('rejects with actionable EADDRINUSE guidance when GOOGLE_MCP_OAUTH_PORT is occupied', async () => {
        blocker = http.createServer((_req, res) => res.end());
        const port = await new Promise((resolve) => {
            blocker.listen(0, 'localhost', () => resolve(blocker.address().port));
        });
        process.env.GOOGLE_MCP_OAUTH_PORT = String(port);

        await expect(authModule.runAuthFlow()).rejects.toMatchObject({
            code: 'EADDRINUSE',
            message: expect.stringContaining('GOOGLE_MCP_OAUTH_PORT'),
        });
        // No browser was opened for a flow that could never accept a redirect.
        expect(execFileCalls).toHaveLength(0);
    });

    it('surfaces the port_in_use remedy through the clients.js failure classifier', async () => {
        // The remedy text lives in dist/clients.js keyed on error.code, so the
        // rethrown conflict has to keep that code for the guidance to appear.
        blocker = http.createServer((_req, res) => res.end());
        const port = await new Promise((resolve) => {
            blocker.listen(0, 'localhost', () => resolve(blocker.address().port));
        });
        process.env.GOOGLE_MCP_OAUTH_PORT = String(port);

        const caught = await authModule.runAuthFlow().catch((error) => error);
        expect(caught.code).toBe('EADDRINUSE');
    });
});
