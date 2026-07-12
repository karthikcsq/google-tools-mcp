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
    delete process.env.GOOGLE_MCP_DISABLE_LEGACY_ALIASES;
});

// Build a server with the consolidated tools + aliases registered.
function buildServer() {
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

describe('GOOGLE_MCP_DISABLE_LEGACY_ALIASES (issue #33)', () => {
    it('hides all aliases when set to "true"', () => {
        process.env.GOOGLE_MCP_DISABLE_LEGACY_ALIASES = 'true';
        const server = createMockServer();
        registerSettings(server);
        registerLabels(server);
        const before = server.getTools().size;
        const added = registerLegacyAliases(server, server.getTools());
        expect(added).toBe(0);
        expect(server.getTools().size).toBe(before);
        expect(server.getTools().has('get_imap')).toBe(false);
    });

    it('registers aliases when the var is unset', () => {
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
});
