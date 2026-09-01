// dist/clients.js is shared, module-level mutable state, and the v3 HTTP
// runtime is stateless: requests are served concurrently with no session to
// serialize them. ensureAuth() used to be a bare `if (authClient) return;`
// followed by an await, so two requests arriving before the first
// authorization finished both saw null and both ran the whole flow. Cold, that
// is two interactive browser flows racing for the same loopback callback port,
// and one of them now loses outright because authenticate() rejects on
// EADDRINUSE instead of hanging. reauthorize() had the same hole, and worse
// consequences: a revoked refresh token fails every in-flight call at once, so
// each failure started its own rebuild and nulled the shared clients out from
// under the others.
//
// Mocks stop at ../dist/auth.js (the real OAuth flow) and the @googleapis/*
// packages (real network), the same boundary tests/legacyAliasAuthRetry.test.js
// uses, so the real ensureAuth / reauthorize / withAuthRetry code runs.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

let authorizeCallCount = 0;
let authorizeImpl;

jest.unstable_mockModule('../dist/auth.js', () => ({
    authorize: (...args) => authorizeImpl(...args),
    runAuthFlow: async () => {},
    getTokenPath: () => 'C:/fake-config/token.json',
    getConfigDir: () => 'C:/fake-config',
    SCOPES: ['https://www.googleapis.com/auth/drive'],
}));

for (const [specifier, name] of [
    ['@googleapis/docs', 'docs'], ['@googleapis/drive', 'drive'], ['@googleapis/sheets', 'sheets'],
    ['@googleapis/script', 'script'], ['@googleapis/gmail', 'gmail'], ['@googleapis/calendar', 'calendar'],
    ['@googleapis/forms', 'forms'], ['@googleapis/slides', 'slides'], ['@googleapis/tasks', 'tasks'],
]) {
    jest.unstable_mockModule(specifier, () => ({ [name]: () => ({}) }));
}

const clients = await import('../dist/clients.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An authorize() that takes long enough for concurrent callers to pile up behind it. */
function slowAuthorize({ delayMs = 25, fail = false } = {}) {
    return async () => {
        authorizeCallCount++;
        await sleep(delayMs);
        if (fail) throw new Error('network is unreachable');
        return { setCredentials() {}, on() {} };
    };
}

beforeEach(() => {
    clients.resetClients();
    authorizeCallCount = 0;
    authorizeImpl = slowAuthorize();
});

describe('clients.js serializes authorization across concurrent requests', () => {
    it('runs exactly one authorization when several cold requests arrive at once', async () => {
        authorizeImpl = slowAuthorize({ delayMs: 30 });

        // Six different tool families, all cold, all started before any of them
        // finishes. This is what two HTTP requests hitting a fresh server look
        // like -- and each duplicate authorization is a second browser window.
        await Promise.all([
            clients.initializeGoogleClient(),
            clients.initializeGmailClient(),
            clients.initializeCalendarClient(),
            clients.initializeFormsClient(),
            clients.initializeSlidesClient(),
            clients.initializeGoogleClient(),
        ]);

        expect(authorizeCallCount).toBe(1);
        expect(clients.getAuthClientIfReady()).not.toBeNull();
    });

    it('does not authorize again once a client is warm', async () => {
        await clients.initializeGoogleClient();
        expect(authorizeCallCount).toBe(1);

        await Promise.all([clients.initializeGmailClient(), clients.initializeTasksClient?.() ?? Promise.resolve()]);
        await clients.initializeGoogleClient();

        expect(authorizeCallCount).toBe(1);
    });

    it('fails every concurrent caller together, then lets the next request try again', async () => {
        authorizeImpl = slowAuthorize({ fail: true });

        const results = await Promise.allSettled([
            clients.initializeGoogleClient(),
            clients.initializeGmailClient(),
            clients.initializeCalendarClient(),
        ]);

        expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
        for (const r of results) {
            expect(String(r.reason?.message)).toMatch(/Google authentication required/);
        }
        // One shared failure, not three separate ones.
        expect(authorizeCallCount).toBe(1);
        expect(clients.getAuthClientIfReady()).toBeNull();

        // The latch must not cache the rejection: a user who declined the
        // consent screen and retries has to get a genuinely new flow.
        authorizeImpl = slowAuthorize();
        await expect(clients.initializeGoogleClient()).resolves.toBeDefined();
        expect(authorizeCallCount).toBe(2);
    });
});

describe('clients.js serializes re-authorization after invalid_grant', () => {
    it('re-authorizes once when a revoked token fails several in-flight calls at the same time', async () => {
        await clients.initializeGoogleClient();
        expect(authorizeCallCount).toBe(1);

        // Every concurrent call sees the revoked token at once, which is exactly
        // how a revocation presents: not one failure, all of them.
        const attempts = new Map();
        const call = (id) => clients.withAuthRetry(async () => {
            const seen = (attempts.get(id) ?? 0) + 1;
            attempts.set(id, seen);
            if (seen === 1) throw new Error('invalid_grant: Token has been expired or revoked.');
            return `ok-${id}`;
        });

        const settled = await Promise.all([call('a'), call('b'), call('c')]);

        expect(settled).toEqual(['ok-a', 'ok-b', 'ok-c']);
        // One initial authorization plus exactly one re-authorization, not one
        // per failed request.
        expect(authorizeCallCount).toBe(2);
        // Each call retried once, per the documented single-retry contract.
        expect([...attempts.values()]).toEqual([2, 2, 2]);
    });

    it('clears the re-authorization latch so a later revocation authorizes again', async () => {
        await clients.initializeGoogleClient();

        const once = (label) => clients.withAuthRetry((() => {
            let first = true;
            return async () => {
                if (first) { first = false; throw new Error('invalid_grant'); }
                return label;
            };
        })());

        await once('first');
        await once('second');

        // initial + one re-auth per distinct revocation episode
        expect(authorizeCallCount).toBe(3);
    });
});
