// Regression test for issue #65 finding 3: registering a legacy alias through
// the real `registerAllTools` production path must not double-wrap the
// auth-retry logic. Before the fix, `wrapServerWithAuthRetry` mutated each
// target tool's `execute` in place *before* the legacy-alias layer captured
// it, so an alias forwarded to an already-retry-wrapped target and then got
// wrapped again itself when it was registered. On a persistent invalid_grant
// that invoked the real Gmail handler up to 4x and re-authorized up to 3x
// instead of the documented single retry.
//
// This test exercises the actual `registerAllTools` registration path (not a
// hand-rolled mock server), with only `../dist/auth.js` (real OAuth flow) and
// `googleapis` (real network calls) mocked out, so the real
// `wrapServerWithAuthRetry` / `withAuthRetry` / `registerLegacyAliases` code
// all run for real.
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

let authorizeCallCount = 0;
let authorizeImpl = async () => {
    authorizeCallCount++;
    return { setCredentials() {}, on() {} };
};

let getImapImpl = async () => {
    throw new Error('getImapImpl not configured for this test');
};

jest.unstable_mockModule('../dist/auth.js', () => ({
    authorize: (...args) => authorizeImpl(...args),
    runAuthFlow: async () => {},
    getTokenPath: () => 'C:/fake-config/token.json',
    getConfigDir: () => 'C:/fake-config',
    SCOPES: ['https://www.googleapis.com/auth/gmail.settings.basic'],
}));

// One factory per @googleapis/* package now that the umbrella is gone (#71).
// dist/auth.js is fully mocked above, so nothing in this graph reaches
// google-auth-library and the old google.auth.OAuth2 stub has no caller left.
jest.unstable_mockModule('@googleapis/gmail', () => ({
    gmail: () => ({ users: { settings: { getImap: (...args) => getImapImpl(...args) } } }),
}));
jest.unstable_mockModule('@googleapis/drive', () => ({ drive: () => ({}) }));
jest.unstable_mockModule('@googleapis/docs', () => ({ docs: () => ({}) }));
jest.unstable_mockModule('@googleapis/sheets', () => ({ sheets: () => ({}) }));
jest.unstable_mockModule('@googleapis/calendar', () => ({ calendar: () => ({}) }));
jest.unstable_mockModule('@googleapis/forms', () => ({ forms: () => ({}) }));
jest.unstable_mockModule('@googleapis/slides', () => ({ slides: () => ({}) }));
jest.unstable_mockModule('@googleapis/tasks', () => ({ tasks: () => ({}) }));
jest.unstable_mockModule('@googleapis/script', () => ({ script: () => ({}) }));

function invalidGrantError() {
    const err = new Error('invalid_grant: Token has been expired or revoked.');
    return err;
}

function mockServer() {
    const tools = new Map();
    return {
        addTool(t) {
            if (tools.has(t.name)) throw new Error(`dup ${t.name}`);
            tools.set(t.name, t);
        },
        getTools() {
            return tools;
        },
    };
}

let registerAllTools, resetClients;

beforeEach(async () => {
    authorizeCallCount = 0;
    ({ registerAllTools } = await import('../dist/tools/index.js'));
    ({ resetClients } = await import('../dist/clients.js'));
    resetClients();
    process.env.GOOGLE_MCP_ENABLE_LEGACY_ALIASES = 'true';
});

afterEach(() => {
    delete process.env.GOOGLE_MCP_ENABLE_LEGACY_ALIASES;
    resetClients?.();
});

describe('Legacy alias auth-retry wrapping (issue #65 finding 3)', () => {
    it('a persistent invalid_grant retries exactly once through get_imap, not up to 4x', async () => {
        let realHandlerCalls = 0;
        getImapImpl = async () => {
            realHandlerCalls++;
            throw invalidGrantError();
        };

        const server = mockServer();
        await registerAllTools(server);
        const getImapAlias = server.getTools().get('get_imap');
        expect(getImapAlias).toBeDefined();

        await expect(getImapAlias.execute({}, {})).rejects.toThrow(/invalid_grant/);

        // Documented single-retry behavior: the real handler runs once, fails
        // with invalid_grant, withAuthRetry re-authorizes once and retries once
        // more. authorizeCallCount is 2, not 1: the first is ensureAuth()'s
        // initial authorization (authClient starts null), the second is the
        // one-time reauthorize() triggered by the invalid_grant. Under the
        // double-wrap bug this would be 3 authorize() calls and 4 handler calls.
        expect(realHandlerCalls).toBe(2);
        expect(authorizeCallCount).toBe(2);
    });

    it('a transient invalid_grant that clears on retry succeeds via the alias and hits the real handler exactly twice', async () => {
        let realHandlerCalls = 0;
        getImapImpl = async () => {
            realHandlerCalls++;
            if (realHandlerCalls === 1) throw invalidGrantError();
            return { data: { imapEnabled: true } };
        };

        const server = mockServer();
        await registerAllTools(server);
        const getImapAlias = server.getTools().get('get_imap');

        const result = await getImapAlias.execute({}, {});
        expect(JSON.parse(result)).toEqual({ imapEnabled: true });
        expect(realHandlerCalls).toBe(2);
        expect(authorizeCallCount).toBe(2);
    });

    it('the underlying manageGmailSettings target itself still gets exactly one retry layer (sanity check)', async () => {
        let realHandlerCalls = 0;
        getImapImpl = async () => {
            realHandlerCalls++;
            throw invalidGrantError();
        };

        const server = mockServer();
        await registerAllTools(server);
        const target = server.getTools().get('manageGmailSettings');

        await expect(target.execute({ resource: 'imap', action: 'get' }, {})).rejects.toThrow(/invalid_grant/);
        expect(realHandlerCalls).toBe(2);
        expect(authorizeCallCount).toBe(2);
    });
});
