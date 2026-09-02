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

    it('does not let a flow abandoned by logout release the latch of the flow that replaced it', async () => {
        // Flow 1 starts (slow: the user is looking at a consent screen), then
        // logout drops the latch, then a new request starts flow 2. When flow 1
        // finally settles, its cleanup must leave flow 2's latch alone --
        // otherwise a third request would see no latch and open a third
        // browser window behind the one the user is already in.
        //
        // Flow 1 ends in failure (the consent tab was closed and the flow timed
        // out), which is the case where the old `.finally(() => { authInFlight
        // = null })` was observable: nothing had set authClient, so the third
        // request saw no client AND no latch, and started flow 3.
        let failFirst;
        const firstGate = new Promise((_resolve, reject) => { failFirst = reject; });
        authorizeImpl = async () => { authorizeCallCount++; await firstGate; };
        const first = clients.initializeGoogleClient().catch((error) => error);
        await sleep(5);

        clients.resetClients();

        let releaseSecond;
        const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
        authorizeImpl = async () => { authorizeCallCount++; await secondGate; return { setCredentials() {}, on() {} }; };
        const second = clients.initializeGmailClient();
        await sleep(5);
        expect(authorizeCallCount).toBe(2);

        // Flow 1 settles (fails) while flow 2 is still in progress.
        failFirst(new Error('Timed out waiting for OAuth callback'));
        expect(String((await first)?.message)).toMatch(/Google authentication required/);

        // A third cold request must join flow 2, not start a flow 3.
        const third = clients.initializeCalendarClient();
        await sleep(5);
        expect(authorizeCallCount).toBe(2);

        releaseSecond();
        await Promise.all([second, third]);
        expect(authorizeCallCount).toBe(2);
    });

    it('never installs the client of a flow that was abandoned by logout, whichever flow finishes last', async () => {
        // The latch fix above stops the abandoned flow from clearing the new
        // flow's latch. It did nothing about the abandoned flow's RESULT:
        // `authClient = await authorize()` installed the pre-logout credentials
        // unconditionally, so a logout during a slow consent screen could be
        // silently undone by that screen completing, and if it completed after
        // the fresh flow it overwrote the fresh client with the old one.
        const oldClient = { label: 'pre-logout', setCredentials() {}, on() {} };
        const newClient = { label: 'post-logout', setCredentials() {}, on() {} };

        // Order A: the abandoned flow finishes AFTER the fresh one.
        let releaseFirst;
        authorizeImpl = async () => { authorizeCallCount++; await new Promise((r) => { releaseFirst = r; }); return oldClient; };
        const first = clients.initializeGoogleClient().catch((error) => error);
        await sleep(5);
        clients.resetClients();
        authorizeImpl = async () => { authorizeCallCount++; return newClient; };
        await clients.initializeGmailClient();
        expect(clients.getAuthClientIfReady()).toBe(newClient);

        releaseFirst();
        expect(String((await first)?.message)).toMatch(/Logged out while authorization was in progress/);
        expect(clients.getAuthClientIfReady()).toBe(newClient);
        expect(authorizeCallCount).toBe(2);

        // Order B: the abandoned flow finishes BEFORE the fresh one. Nothing
        // may be installed in between: a request in that window must wait for
        // the fresh flow, not run on the credentials the user just discarded.
        clients.resetClients();
        authorizeCallCount = 0;
        authorizeImpl = async () => { authorizeCallCount++; await new Promise((r) => { releaseFirst = r; }); return oldClient; };
        const firstB = clients.initializeGoogleClient().catch((error) => error);
        await sleep(5);
        clients.resetClients();
        let releaseSecond;
        authorizeImpl = async () => { authorizeCallCount++; await new Promise((r) => { releaseSecond = r; }); return newClient; };
        const secondB = clients.initializeGmailClient();
        await sleep(5);

        releaseFirst();
        expect(String((await firstB)?.message)).toMatch(/Logged out while authorization was in progress/);
        expect(clients.getAuthClientIfReady()).toBeNull();

        releaseSecond();
        await secondB;
        expect(clients.getAuthClientIfReady()).toBe(newClient);
        expect(authorizeCallCount).toBe(2);
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

    it('makes a cold request that arrives mid re-authorization join it instead of opening a second flow', async () => {
        // performReauthorize nulls authClient and every API client, then waits
        // on a browser flow. ensureAuth only knew about its own latch, so a
        // request for a client that had never been built (the first Gmail call
        // of the session, say) landing in that window saw no authClient and no
        // authInFlight and started a second interactive flow against the same
        // callback port the re-authorization was already listening on.
        await clients.initializeGoogleClient();
        expect(authorizeCallCount).toBe(1);

        let releaseReauth;
        authorizeImpl = async () => {
            authorizeCallCount++;
            await new Promise((r) => { releaseReauth = r; });
            return { setCredentials() {}, on() {} };
        };
        let attempts = 0;
        const revoked = clients.withAuthRetry(async () => {
            attempts++;
            if (attempts === 1) throw new Error('invalid_grant: Token has been expired or revoked.');
            return 'ok';
        });
        await sleep(5);
        expect(authorizeCallCount).toBe(2);

        // Cold Gmail request while the re-authorization is waiting on the browser.
        const cold = clients.initializeGmailClient();
        await sleep(5);
        expect(authorizeCallCount).toBe(2);

        releaseReauth();
        await expect(revoked).resolves.toBe('ok');
        await expect(cold).resolves.toBeDefined();
        expect(authorizeCallCount).toBe(2);
        expect(clients.getAuthClientIfReady()).not.toBeNull();
    });

    it('does not let a re-authorization abandoned by logout install its client', async () => {
        await clients.initializeGoogleClient();
        const staleClient = { label: 'stale', setCredentials() {}, on() {} };
        let releaseReauth;
        authorizeImpl = async () => { authorizeCallCount++; await new Promise((r) => { releaseReauth = r; }); return staleClient; };
        const revoked = clients.withAuthRetry(async () => { throw new Error('invalid_grant'); }).catch((error) => error);
        await sleep(5);

        clients.resetClients();
        releaseReauth();
        expect(String((await revoked)?.message)).toMatch(/Logged out while re-authorization was in progress/);
        expect(clients.getAuthClientIfReady()).toBeNull();
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
