// Integration tests for readDocument's local-workspace auto-save and
// fidelity-warning behavior (dist/tools/docs/readGoogleDoc.js).
import { describe, expect, it, jest, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import { getWorkspacePath } from '../dist/workspace.js';

const documentsGet = jest.fn();

jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => ({ documents: { get: documentsGet } }),
    getDriveClient: async () => ({
        files: { get: async () => ({ data: { modifiedTime: null } }) },
    }),
}));

const { register } = await import('../dist/tools/docs/readGoogleDoc.js');

function createServer() {
    const tools = new Map();
    return {
        addTool(tool) {
            tools.set(tool.name, tool);
        },
        getTool(name) {
            return tools.get(name);
        },
    };
}

const log = { info() {}, error() {}, warn() {}, debug() {} };

function docWithBody(content) {
    return { data: { body: { content } } };
}

const cleanupPaths = [];
afterEach(async () => {
    for (const p of cleanupPaths.splice(0)) {
        await fs.rm(p, { force: true }).catch(() => {});
    }
});

describe('readDocument local workspace + fidelity warnings', () => {
    it('saves the markdown to a local workspace file and advises pushing it back', async () => {
        const documentId = `ws-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        documentsGet.mockResolvedValueOnce(
            docWithBody([{ paragraph: { elements: [{ textRun: { content: 'Hello world\n' } }] } }])
        );

        const server = createServer();
        register(server);
        const localPath = getWorkspacePath(documentId);
        cleanupPaths.push(localPath);

        const result = await server.getTool('readDocument').execute(
            { documentId, format: 'markdown', diffFromLastRead: false },
            { log }
        );

        expect(result).toContain('Hello world');
        expect(result).toContain('📄 Local file:');
        expect(result).toContain(localPath.replace(/\\/g, '/'));
        expect(result).not.toContain('FORMATTING LOSS WARNING');

        const onDisk = await fs.readFile(localPath, 'utf-8');
        expect(onDisk).toBe('Hello world');
    });

    it('appends a fidelity warning when the document body contains an image', async () => {
        const documentId = `ws-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        documentsGet.mockResolvedValueOnce(
            docWithBody([
                {
                    paragraph: {
                        elements: [
                            { textRun: { content: 'before ' } },
                            { inlineObjectElement: { inlineObjectId: 'io1' } },
                            { textRun: { content: ' after\n' } },
                        ],
                    },
                },
            ])
        );

        const server = createServer();
        register(server);
        cleanupPaths.push(getWorkspacePath(documentId));

        const result = await server.getTool('readDocument').execute(
            { documentId, format: 'markdown', diffFromLastRead: false },
            { log }
        );

        expect(result).toContain('⚠️ FORMATTING LOSS WARNING');
        expect(result).toContain('1 image(s) — will be removed');
        expect(result).toContain('replaceDocumentWithMarkdown');
    });

    it('does not warn about custom colors or alignment (they round-trip via rich markdown)', async () => {
        const documentId = `ws-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        documentsGet.mockResolvedValueOnce(
            docWithBody([
                {
                    paragraph: {
                        paragraphStyle: { alignment: 'CENTER' },
                        elements: [
                            {
                                textRun: {
                                    content: 'red centered\n',
                                    textStyle: { foregroundColor: { color: { rgbColor: { red: 1, green: 0, blue: 0 } } } },
                                },
                            },
                        ],
                    },
                },
            ])
        );

        const server = createServer();
        register(server);
        cleanupPaths.push(getWorkspacePath(documentId));

        const result = await server.getTool('readDocument').execute(
            { documentId, format: 'markdown', diffFromLastRead: false },
            { log }
        );

        expect(result).not.toContain('FORMATTING LOSS WARNING');
    });

    it('keeps two tabs of the same document in separate workspace files', async () => {
        const documentId = `ws-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const makeTabsDoc = (tabId, text) => ({
            data: {
                tabs: [
                    {
                        tabProperties: { tabId, title: tabId },
                        documentTab: {
                            body: { content: [{ paragraph: { elements: [{ textRun: { content: `${text}\n` } }] } }] },
                        },
                    },
                ],
            },
        });

        const server = createServer();
        register(server);
        cleanupPaths.push(getWorkspacePath(documentId, 'tab-1'), getWorkspacePath(documentId, 'tab-2'));

        documentsGet.mockResolvedValueOnce(makeTabsDoc('tab-1', 'Tab one content'));
        const result1 = await server.getTool('readDocument').execute(
            { documentId, format: 'markdown', tabId: 'tab-1', diffFromLastRead: false },
            { log }
        );

        documentsGet.mockResolvedValueOnce(makeTabsDoc('tab-2', 'Tab two content'));
        const result2 = await server.getTool('readDocument').execute(
            { documentId, format: 'markdown', tabId: 'tab-2', diffFromLastRead: false },
            { log }
        );

        expect(result1).toContain(getWorkspacePath(documentId, 'tab-1').replace(/\\/g, '/'));
        expect(result2).toContain(getWorkspacePath(documentId, 'tab-2').replace(/\\/g, '/'));
        expect(await fs.readFile(getWorkspacePath(documentId, 'tab-1'), 'utf-8')).toBe('Tab one content');
        expect(await fs.readFile(getWorkspacePath(documentId, 'tab-2'), 'utf-8')).toBe('Tab two content');
    });
});
