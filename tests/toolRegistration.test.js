// Tests that all tool categories register the expected tools.
// Uses a minimal mock server that records addTool calls instead of a real FastMCP instance.
import { describe, it, expect, beforeAll } from '@jest/globals';

// Minimal mock server that captures tool registrations
function createMockServer() {
    const tools = new Map();
    return {
        addTool(toolDef) {
            if (tools.has(toolDef.name)) {
                throw new Error(`Duplicate tool name: ${toolDef.name}`);
            }
            tools.set(toolDef.name, toolDef);
        },
        getTools() {
            return tools;
        },
    };
}

// ---------------------------------------------------------------------------
// Category-level registration tests
// ---------------------------------------------------------------------------
describe('Tool Registration', () => {
    // --- Docs category ---
    describe('Docs tools', () => {
        let tools;
        beforeAll(async () => {
            const server = createMockServer();
            const { registerDocsTools } = await import('../dist/tools/docs/index.js');
            registerDocsTools(server);
            tools = server.getTools();
        });

        it('registers expected core docs tools', () => {
            const expectedTools = [
                'readDocument',
                'listTabs',
                'renameTab',
                'addTab',
                'appendText',
                'deleteRange',
                'modifyText',
                'findAndReplace',
                'insertTable',
                'insertTableWithData',
                'insertPageBreak',
                'insertImage',
            ];
            for (const name of expectedTools) {
                expect(tools.has(name)).toBe(true);
            }
        });

        it('each tool has name, description, parameters, and execute', () => {
            for (const [name, tool] of tools) {
                expect(typeof tool.name).toBe('string');
                expect(tool.name.length).toBeGreaterThan(0);
                expect(typeof tool.description).toBe('string');
                expect(tool.description.length).toBeGreaterThan(0);
                expect(tool.parameters).toBeDefined();
                expect(typeof tool.execute).toBe('function');
            }
        });

        it('has no duplicate tool names', () => {
            // The mock server itself throws on duplicates, but verify count matches
            const names = [...tools.keys()];
            expect(new Set(names).size).toBe(names.length);
        });
    });

    // --- Drive category ---
    describe('Drive tools', () => {
        let tools;
        beforeAll(async () => {
            const server = createMockServer();
            const { registerDriveTools } = await import('../dist/tools/drive/index.js');
            registerDriveTools(server);
            tools = server.getTools();
        });

        it('registers expected drive tools', () => {
            const expectedTools = [
                'listDriveFiles',
                'getFileInfo',
                'createFolder',
                'deleteFile',
                'moveFile',
                'copyFile',
                'renameFile',
                'downloadFile',
                'uploadFile',
            ];
            for (const name of expectedTools) {
                expect(tools.has(name)).toBe(true);
            }
        });
    });

    // --- Sheets category ---
    describe('Sheets tools', () => {
        let tools;
        beforeAll(async () => {
            const server = createMockServer();
            const { registerSheetsTools } = await import('../dist/tools/sheets/index.js');
            registerSheetsTools(server);
            tools = server.getTools();
        });

        it('registers multiple sheets tools', () => {
            // Just verify a reasonable number of tools are registered
            expect(tools.size).toBeGreaterThanOrEqual(20);
        });

        it('includes key sheets tools', () => {
            const expectedTools = [
                'readSpreadsheet',
                'writeSpreadsheet',
                'createSpreadsheet',
                'getSpreadsheetInfo',
            ];
            for (const name of expectedTools) {
                expect(tools.has(name)).toBe(true);
            }
        });
    });

    // --- Extras tools ---
    describe('Extras tools', () => {
        let tools;
        beforeAll(async () => {
            const server = createMockServer();
            const { registerExtrasTools } = await import('../dist/tools/extras/index.js');
            registerExtrasTools(server);
            tools = server.getTools();
        });

        it('registers expected extras tools', () => {
            expect(tools.has('readFile')).toBe(true);
            expect(tools.has('searchFileContents')).toBe(true);
            expect(tools.has('readDriveFile')).toBe(true);
        });
    });

    // --- Utils (markdown) tools ---
    describe('Utils tools', () => {
        let tools;
        beforeAll(async () => {
            const server = createMockServer();
            const { registerUtilsTools } = await import('../dist/tools/utils/index.js');
            registerUtilsTools(server);
            tools = server.getTools();
        });

        it('registers markdown tools', () => {
            expect(tools.has('replaceDocumentWithMarkdown')).toBe(true);
            expect(tools.has('appendMarkdown')).toBe(true);
        });
    });

    // --- Calendar tools ---
    describe('Calendar tools', () => {
        let tools;
        beforeAll(async () => {
            const server = createMockServer();
            const { registerCalendarTools } = await import('../dist/tools/calendar/index.js');
            registerCalendarTools(server);
            tools = server.getTools();
        });

        it('registers calendar tools', () => {
            expect(tools.size).toBeGreaterThanOrEqual(5);
        });
    });

    // --- Forms tools ---
    describe('Forms tools', () => {
        let tools;
        beforeAll(async () => {
            const server = createMockServer();
            const { registerFormsTools } = await import('../dist/tools/forms/index.js');
            registerFormsTools(server);
            tools = server.getTools();
        });

        it('registers forms tools', () => {
            expect(tools.size).toBeGreaterThanOrEqual(4);
        });
    });

    describe('Maps tools', () => {
        it('registers all first-milestone maps tools', async () => {
            const server = createMockServer();
            const { registerMapsTools } = await import('../dist/tools/maps/index.js');
            registerMapsTools(server);
            expect([...server.getTools().keys()]).toEqual([
                'mapsGeocode', 'mapsReverseGeocode', 'mapsSearchNearby',
                'mapsSearchPlaces', 'mapsPlaceDetails', 'mapsDirections',
            ]);
        });
    });
});

// ---------------------------------------------------------------------------
// Tool count verification
// ---------------------------------------------------------------------------
describe('Total tool count', () => {
    // Register all base (new camelCase + dispatch) tools for the categories the
    // server loads, optionally layering on the legacy snake_case aliases.
    async function registerBase(server) {
        const { registerDocsTools } = await import('../dist/tools/docs/index.js');
        const { registerUtilsTools } = await import('../dist/tools/utils/index.js');
        const { registerDriveTools } = await import('../dist/tools/drive/index.js');
        const { registerExtrasTools } = await import('../dist/tools/extras/index.js');
        const { registerSheetsTools } = await import('../dist/tools/sheets/index.js');
        const { registerCalendarTools } = await import('../dist/tools/calendar/index.js');
        const { registerFormsTools } = await import('../dist/tools/forms/index.js');
        const { registerMapsTools } = await import('../dist/tools/maps/index.js');

        // Gmail modules
        const { register: registerMessages } = await import('../dist/tools/gmail/messages.js');
        const { register: registerDrafts } = await import('../dist/tools/gmail/drafts.js');
        const { register: registerThreads } = await import('../dist/tools/gmail/threads.js');
        const { register: registerLabels } = await import('../dist/tools/gmail/labels.js');
        const { register: registerSettings } = await import('../dist/tools/gmail/settings.js');

        registerDocsTools(server);
        registerUtilsTools(server);
        registerDriveTools(server);
        registerExtrasTools(server);
        registerSheetsTools(server);
        registerCalendarTools(server);
        registerFormsTools(server);
        registerMapsTools(server);
        registerMessages(server);
        registerDrafts(server);
        registerThreads(server);
        registerLabels(server);
        registerSettings(server);
    }

    afterEach(() => {
        delete process.env.GOOGLE_MCP_ENABLE_LEGACY_ALIASES;
    });

    // Exact counts, not loose `>=` assertions (issue #65 review): a loose bound
    // let the default-surface regression (aliases registering by default) stay
    // hidden, since 194 >= 100 and 194 >= 140 both still "pass". Pin the exact
    // number so any future change to the default tool surface is a visible,
    // deliberate diff in this test, not a silent regression.
    //
    // 128 = the 122 pre-Maps consolidated base tools (docs/utils/drive/extras/
    // sheets/calendar/forms/gmail subset) + the 6 camelCase `maps` tools added
    // in PR #66 (mapsGeocode, mapsReverseGeocode, mapsSearchNearby,
    // mapsSearchPlaces, mapsPlaceDetails, mapsDirections). Maps tools have no
    // legacy snake_case aliases (they were never snake_case), so the alias
    // count added below stays 72.
    it('registers exactly 128 tools in the consolidated base surface (docs/utils/drive/extras/sheets/calendar/forms/maps/gmail subset)', async () => {
        const server = createMockServer();
        await registerBase(server);
        expect(server.getTools().size).toBe(128);
    });

    it('with legacy aliases explicitly enabled, adds exactly 72 snake_case aliases (200 total)', async () => {
        process.env.GOOGLE_MCP_ENABLE_LEGACY_ALIASES = 'true';
        const server = createMockServer();
        await registerBase(server);
        const { registerLegacyAliases } = await import('../dist/tools/legacyAliases.js');
        const added = registerLegacyAliases(server, server.getTools());
        expect(added).toBe(72);
        expect(server.getTools().size).toBe(200);
    });

    it('legacy aliases are opt-in: registerLegacyAliases is a no-op when the env var is unset (issue #31/#33 regression guard)', async () => {
        const server = createMockServer();
        await registerBase(server);
        const before = server.getTools().size;
        const { registerLegacyAliases } = await import('../dist/tools/legacyAliases.js');
        const added = registerLegacyAliases(server, server.getTools());
        expect(added).toBe(0);
        expect(server.getTools().size).toBe(before);
    });

    // The subset above omits slides, tasks, and the 4 always-on utility tools
    // (help/logout/troubleshoot/feedback) that the real server also registers.
    // Pin the exact counts through the real `registerAllTools` production path
    // too, so the number a client actually sees by default is covered, not just
    // the test-helper subset. 156 = 150 pre-Maps + the 6 `maps` tools; 228 = 222
    // pre-Maps (with aliases) + the same 6 (maps tools have no aliases).
    it('registerAllTools (real production path) registers exactly 156 tools by default (aliases opt-in, unset)', async () => {
        const server = createMockServer();
        const { registerAllTools } = await import('../dist/tools/index.js');
        await registerAllTools(server);
        expect(server.getTools().size).toBe(156);
    });

    it('registerAllTools (real production path) registers exactly 228 tools with legacy aliases explicitly enabled', async () => {
        process.env.GOOGLE_MCP_ENABLE_LEGACY_ALIASES = 'true';
        const server = createMockServer();
        const { registerAllTools } = await import('../dist/tools/index.js');
        await registerAllTools(server);
        expect(server.getTools().size).toBe(228);
    });
});
