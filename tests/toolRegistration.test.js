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
});

// ---------------------------------------------------------------------------
// Tool count verification
// ---------------------------------------------------------------------------
describe('Total tool count', () => {
    it('all categories together register 140+ tools', async () => {
        const server = createMockServer();

        // Load all categories
        const { registerDocsTools } = await import('../dist/tools/docs/index.js');
        const { registerUtilsTools } = await import('../dist/tools/utils/index.js');
        const { registerDriveTools } = await import('../dist/tools/drive/index.js');
        const { registerExtrasTools } = await import('../dist/tools/extras/index.js');
        const { registerSheetsTools } = await import('../dist/tools/sheets/index.js');
        const { registerCalendarTools } = await import('../dist/tools/calendar/index.js');
        const { registerFormsTools } = await import('../dist/tools/forms/index.js');

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
        registerMessages(server);
        registerDrafts(server);
        registerThreads(server);
        registerLabels(server);
        registerSettings(server);

        const tools = server.getTools();
        // README says 153 tools across 9 categories, minus the 4 standalone
        // (help, logout, troubleshoot, feedback). The number may vary slightly.
        expect(tools.size).toBeGreaterThanOrEqual(140);
    });
});
