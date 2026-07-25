// Tests for the Gmail tool consolidation + legacy alias layer (issues #31/#32/#33).
import { jest, describe, it, expect, beforeAll, afterEach } from '@jest/globals';

// --- Record every underlying gmail.users.* call via a proxy client ---
let calls = [];
function recorder() {
    function make(path) {
        return new Proxy(function () {}, {
            get(_t, prop) {
                if (prop === 'then') return undefined; // not a thenable
                return make([...path, String(prop)]);
            },
            apply(_t, _this, args) {
                calls.push({ path: path.join('.'), args: args[0] });
                return { data: { ok: true, path: path.join('.') } };
            },
        });
    }
    return make([]);
}

// Mock the clients module so getGmailClient returns our recording proxy.
jest.unstable_mockModule('../dist/clients.js', () => ({
    getGmailClient: async () => recorder(),
}));

function createMockServer() {
    const tools = new Map();
    return {
        addTool(toolDef) {
            if (tools.has(toolDef.name)) throw new Error(`Duplicate tool name: ${toolDef.name}`);
            tools.set(toolDef.name, toolDef);
        },
        getTools() {
            return tools;
        },
    };
}

let registerSettings, registerLabels, registerLegacyAliases, legacyMod;

beforeAll(async () => {
    ({ register: registerSettings } = await import('../dist/tools/gmail/settings.js'));
    ({ register: registerLabels } = await import('../dist/tools/gmail/labels.js'));
    legacyMod = await import('../dist/tools/legacyAliases.js');
    registerLegacyAliases = legacyMod.registerLegacyAliases;
});

afterEach(() => {
    calls = [];
    delete process.env.GOOGLE_MCP_ENABLE_LEGACY_ALIASES;
});

// Build a server with the consolidated tools + aliases registered. Aliases are
// opt-in by default (issue #31/#33), so tests exercising alias behavior itself
// explicitly enable them here.
function buildServer() {
    process.env.GOOGLE_MCP_ENABLE_LEGACY_ALIASES = 'true';
    const server = createMockServer();
    registerSettings(server);
    registerLabels(server);
    registerLegacyAliases(server, server.getTools());
    return server;
}

describe('Consolidated dispatch tools are registered', () => {
    it('registers manageGmailSettings, manageSmime, manageFilter, manageLabel', () => {
        const server = createMockServer();
        registerSettings(server);
        registerLabels(server);
        const tools = server.getTools();
        expect(tools.has('manageGmailSettings')).toBe(true);
        expect(tools.has('manageSmime')).toBe(true);
        expect(tools.has('manageFilter')).toBe(true);
        expect(tools.has('manageLabel')).toBe(true);
        // Profile/watch renamed to camelCase, still granular
        expect(tools.has('getProfile')).toBe(true);
        expect(tools.has('watchMailbox')).toBe(true);
        expect(tools.has('stopMailWatch')).toBe(true);
    });

    it('no longer registers the old granular settings tools directly', () => {
        const server = createMockServer();
        registerSettings(server);
        registerLabels(server);
        const tools = server.getTools();
        for (const gone of ['get_imap', 'update_imap', 'create_filter', 'create_label', 'list_smime_info', 'get_profile']) {
            expect(tools.has(gone)).toBe(false);
        }
    });
});

describe('Legacy alias dispatch equivalence (issue #33)', () => {
    it('get_imap alias hits the same underlying API call as manageGmailSettings resource=imap action=get', async () => {
        const server = buildServer();
        const tools = server.getTools();

        await tools.get('manageGmailSettings').execute({ resource: 'imap', action: 'get' });
        const viaNew = calls.pop();

        await tools.get('get_imap').execute({});
        const viaAlias = calls.pop();

        expect(viaAlias.path).toBe('users.settings.getImap');
        expect(viaAlias.path).toBe(viaNew.path);
        expect(viaAlias.args).toEqual({ userId: 'me' });
        expect(viaAlias.args).toEqual(viaNew.args);
    });

    it('update_imap alias forwards its params as the requestBody to updateImap', async () => {
        const server = buildServer();
        const body = { enabled: true, expungeBehavior: 'archive', maxFolderSize: 1000 };
        await server.getTools().get('update_imap').execute(body);
        const call = calls.pop();
        expect(call.path).toBe('users.settings.updateImap');
        expect(call.args).toEqual({ userId: 'me', requestBody: body });
    });

    it('create_label alias dispatches to labels.create with the original requestBody', async () => {
        const server = buildServer();
        await server.getTools().get('create_label').execute({ name: 'Work' });
        const call = calls.pop();
        expect(call.path).toBe('users.labels.create');
        expect(call.args).toEqual({ userId: 'me', requestBody: { name: 'Work' } });
    });

    it('create_filter alias maps its action object to the filter requestBody.action', async () => {
        const server = buildServer();
        await server.getTools().get('create_filter').execute({
            criteria: { from: 'a@b.com' },
            action: { addLabelIds: ['L1'] },
        });
        const call = calls.pop();
        expect(call.path).toBe('users.settings.filters.create');
        expect(call.args).toEqual({ userId: 'me', requestBody: { criteria: { from: 'a@b.com' }, action: { addLabelIds: ['L1'] } } });
    });

    it('alias descriptions start with the deprecation marker', () => {
        const tools = buildServer().getTools();
        expect(tools.get('list_labels').description.startsWith('[Deprecated alias of manageLabel]')).toBe(true);
        expect(tools.get('get_imap').description.startsWith('[Deprecated alias of manageGmailSettings]')).toBe(true);
    });
});

describe('GOOGLE_MCP_ENABLE_LEGACY_ALIASES (issue #31/#33: aliases must be opt-in, not opt-out)', () => {
    it('does NOT register aliases by default (var unset) — the whole point of #31/#33 is a smaller default surface', () => {
        const server = createMockServer();
        registerSettings(server);
        registerLabels(server);
        const before = server.getTools().size;
        const added = registerLegacyAliases(server, server.getTools());
        expect(added).toBe(0);
        expect(server.getTools().size).toBe(before);
        expect(server.getTools().has('get_imap')).toBe(false);
    });

    it('registers aliases only when explicitly enabled', () => {
        process.env.GOOGLE_MCP_ENABLE_LEGACY_ALIASES = 'true';
        const server = createMockServer();
        registerSettings(server);
        registerLabels(server);
        const added = registerLegacyAliases(server, server.getTools());
        expect(added).toBeGreaterThan(0);
        expect(server.getTools().has('get_imap')).toBe(true);
    });
});

describe('manageGmailSettings resource/action validation (issue #31)', () => {
    it('rejects an invalid resource/action combo with a helpful UserError', async () => {
        const server = createMockServer();
        registerSettings(server);
        const mgs = server.getTools().get('manageGmailSettings');
        await expect(mgs.execute({ resource: 'imap', action: 'create' })).rejects.toThrow(/Invalid resource\/action combination/);
        // Error lists valid combinations
        let msg = '';
        try {
            await mgs.execute({ resource: 'language', action: 'delete' });
        } catch (e) {
            msg = e.message;
        }
        expect(msg).toContain('Valid combinations');
        expect(msg).toContain('imap: get, update');
        expect(msg).toContain('sendAs:');
    });

    it('accepts a valid combo and dispatches to the API', async () => {
        const server = createMockServer();
        registerSettings(server);
        await server.getTools().get('manageGmailSettings').execute({ resource: 'vacation', action: 'get' });
        expect(calls.pop().path).toBe('users.settings.getVacation');
    });

    it('rejects actions missing their required payload identifier', async () => {
        const server = createMockServer();
        registerSettings(server);
        const mgs = server.getTools().get('manageGmailSettings');
        await expect(mgs.execute({ resource: 'sendAs', action: 'verify' })).rejects.toThrow(/payload validation failed.*sendAsEmail: Required/);
        await expect(mgs.execute({ resource: 'delegate', action: 'create', payload: {} })).rejects.toThrow(/delegateEmail/);
        await expect(mgs.execute({ resource: 'imap', action: 'update' })).rejects.toThrow(/payload validation failed.*enabled: Required/);
        expect(calls).toHaveLength(0);
    });

    it('rejects an update whose payload is non-empty but missing a required body field', async () => {
        const server = createMockServer();
        registerSettings(server);
        const mgs = server.getTools().get('manageGmailSettings');
        // maxFolderSize alone is not enough — the original update_imap schema required `enabled`.
        await expect(mgs.execute({ resource: 'imap', action: 'update', payload: { maxFolderSize: 500 } }))
            .rejects.toThrow(/payload validation failed.*enabled: Required/);
        // autoForwarding update requires all three of enabled, emailAddress, disposition.
        await expect(mgs.execute({ resource: 'autoForwarding', action: 'update', payload: { enabled: true } }))
            .rejects.toThrow(/emailAddress: Required.*disposition: Required/);
        expect(calls).toHaveLength(0);
    });

    it('accepts an update that disables a boolean setting (enabled=false is a valid value)', async () => {
        const server = createMockServer();
        registerSettings(server);
        await server.getTools().get('manageGmailSettings')
            .execute({ resource: 'imap', action: 'update', payload: { enabled: false } });
        const call = calls.pop();
        expect(call.path).toBe('users.settings.updateImap');
        expect(call.args).toEqual({ userId: 'me', requestBody: { enabled: false } });
    });
});

describe('Per-action required fields on the other dispatch tools', () => {
    it('manageSmime enforces id and insert credentials', async () => {
        const server = createMockServer();
        registerSettings(server);
        const smime = server.getTools().get('manageSmime');
        await expect(smime.execute({ action: 'get', sendAsEmail: 'a@b.com' })).rejects.toThrow(/requires id/);
        await expect(smime.execute({ action: 'insert', sendAsEmail: 'a@b.com' })).rejects.toThrow(/encryptedKeyPassword and pkcs12/);
        expect(calls).toHaveLength(0);
    });

    it('manageFilter and manageLabel enforce create/get/delete requirements', async () => {
        const server = createMockServer();
        registerSettings(server);
        registerLabels(server);
        const tools = server.getTools();
        await expect(tools.get('manageFilter').execute({ action: 'create' })).rejects.toThrow(/criteria and filterAction/);
        await expect(tools.get('manageFilter').execute({ action: 'delete' })).rejects.toThrow(/requires id/);
        await expect(tools.get('manageLabel').execute({ action: 'create' })).rejects.toThrow(/requires name/);
        await expect(tools.get('manageLabel').execute({ action: 'get' })).rejects.toThrow(/requires id/);
        expect(calls).toHaveLength(0);
    });
});

describe('API-call fidelity for non-trivial reshapes', () => {
    it('sendAs patch strips sendAsEmail into the path param and keeps the rest as body', async () => {
        const server = createMockServer();
        registerSettings(server);
        await server.getTools().get('manageGmailSettings').execute({
            resource: 'sendAs',
            action: 'patch',
            payload: { sendAsEmail: 'alias@b.com', displayName: 'Alias', signature: '<b>sig</b>' },
        });
        const call = calls.pop();
        expect(call.path).toBe('users.settings.sendAs.patch');
        expect(call.args).toEqual({
            userId: 'me',
            sendAsEmail: 'alias@b.com',
            requestBody: { displayName: 'Alias', signature: '<b>sig</b>' },
        });
    });

    it('smime insert sends sendAsEmail both as path param and inside the requestBody', async () => {
        const server = createMockServer();
        registerSettings(server);
        await server.getTools().get('manageSmime').execute({
            action: 'insert',
            sendAsEmail: 'alias@b.com',
            encryptedKeyPassword: 'pw',
            pkcs12: 'base64data',
        });
        const call = calls.pop();
        expect(call.path).toBe('users.settings.sendAs.smimeInfo.insert');
        expect(call.args).toEqual({
            userId: 'me',
            sendAsEmail: 'alias@b.com',
            requestBody: { sendAsEmail: 'alias@b.com', encryptedKeyPassword: 'pw', pkcs12: 'base64data' },
        });
    });
});

// ---------------------------------------------------------------------------
// manageGmailSettings payload TYPE/ENUM validation (regression: z.record(z.any())
// previously accepted any shape, so malformed values like a string boolean or an
// invalid enum reached the Gmail API instead of being rejected up front).
// ---------------------------------------------------------------------------
describe('manageGmailSettings rejects mistyped/invalid-enum payload values', () => {
    it('execute() rejects a string where a boolean is required', async () => {
        const server = createMockServer();
        registerSettings(server);
        const mgs = server.getTools().get('manageGmailSettings');
        await expect(
            mgs.execute({ resource: 'imap', action: 'update', payload: { enabled: 'false' } })
        ).rejects.toThrow(/enabled: Expected boolean, received string/);
        expect(calls).toHaveLength(0);
    });

    it('execute() rejects an invalid enum value for disposition', async () => {
        const server = createMockServer();
        registerSettings(server);
        const mgs = server.getTools().get('manageGmailSettings');
        await expect(
            mgs.execute({
                resource: 'autoForwarding',
                action: 'update',
                payload: { enabled: true, emailAddress: 'a@b.com', disposition: 'shredIt' },
            })
        ).rejects.toThrow(/disposition.*Invalid enum value/);
        expect(calls).toHaveLength(0);
    });

    it('execute() rejects a non-number maxFolderSize', async () => {
        const server = createMockServer();
        registerSettings(server);
        const mgs = server.getTools().get('manageGmailSettings');
        await expect(
            mgs.execute({ resource: 'imap', action: 'update', payload: { enabled: true, maxFolderSize: 'lots' } })
        ).rejects.toThrow(/maxFolderSize: Expected number, received string/);
        expect(calls).toHaveLength(0);
    });

    // The regression specifically bypassed validation at the *schema* boundary,
    // not just inside execute(): calling `parameters.parse(...)` (what fastmcp
    // itself does with the arguments before ever reaching execute) must also
    // reject bad resource/action combos and bad payload shapes on its own.
    it('parameters.parse() rejects an invalid resource/action combo directly', () => {
        const server = createMockServer();
        registerSettings(server);
        const mgs = server.getTools().get('manageGmailSettings');
        expect(() => mgs.parameters.parse({ resource: 'imap', action: 'create' })).toThrow(/Invalid resource\/action combination/);
    });

    it('parameters.parse() rejects an unknown resource/action enum value', () => {
        const server = createMockServer();
        registerSettings(server);
        const mgs = server.getTools().get('manageGmailSettings');
        expect(() => mgs.parameters.parse({ resource: 'bogus', action: 'get' })).toThrow();
        expect(() => mgs.parameters.parse({ resource: 'imap', action: 'nuke' })).toThrow();
    });

    it('parameters.parse() rejects a mistyped payload field before execute() is ever called', () => {
        const server = createMockServer();
        registerSettings(server);
        const mgs = server.getTools().get('manageGmailSettings');
        expect(() =>
            mgs.parameters.parse({ resource: 'imap', action: 'update', payload: { enabled: 'false' } })
        ).toThrow(/payload[\s\S]*enabled/);
    });

    it('parameters.parse() rejects an invalid enum value inside payload', () => {
        const server = createMockServer();
        registerSettings(server);
        const mgs = server.getTools().get('manageGmailSettings');
        expect(() =>
            mgs.parameters.parse({
                resource: 'pop',
                action: 'update',
                payload: { accessWindow: 'everything', disposition: 'archive' },
            })
        ).toThrow(/payload[\s\S]*accessWindow/);
    });

    it('parameters.parse() accepts a valid, fully-typed payload', () => {
        const server = createMockServer();
        registerSettings(server);
        const mgs = server.getTools().get('manageGmailSettings');
        const parsed = mgs.parameters.parse({
            resource: 'imap',
            action: 'update',
            payload: { enabled: true, expungeBehavior: 'archive', maxFolderSize: 1000 },
        });
        expect(parsed.payload).toEqual({ enabled: true, expungeBehavior: 'archive', maxFolderSize: 1000 });
    });
});
