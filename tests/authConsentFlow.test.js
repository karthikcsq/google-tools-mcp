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
    async getToken(code) {
        return getTokenImpl(code);
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
async function driveOAuthCallback({ code, error } = {}) {
    const deadline = Date.now() + 2000;
    let instance;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        instance = oauth2Instances.find((candidate) => candidate.redirectUri && !candidate.callbackDriven);
        if (instance) break;
        if (Date.now() > deadline) throw new Error('Timed out waiting for the browser-flow OAuth2 client');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    instance.callbackDriven = true;
    const url = new URL(instance.redirectUri);
    if (code) url.searchParams.set('code', code);
    if (error) url.searchParams.set('error', error);
    await new Promise((resolve, reject) => {
        http.get(url, (res) => {
            res.resume();
            res.on('end', resolve);
        }).on('error', reject);
    });
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
