import { describe, expect, it, jest } from '@jest/globals';

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

describe('readDocument tab markdown', () => {
    it('uses tab-scoped list definitions when rendering ordered lists', async () => {
        documentsGet.mockResolvedValueOnce({
            data: {
                tabs: [
                    {
                        tabProperties: { tabId: 'tab-1', title: 'Plan' },
                        documentTab: {
                            body: {
                                content: [
                                    {
                                        paragraph: {
                                            bullet: { listId: 'ordered-list', nestingLevel: 0 },
                                            elements: [{ textRun: { content: 'First step\n' } }],
                                        },
                                    },
                                ],
                            },
                            lists: {
                                'ordered-list': {
                                    listProperties: {
                                        nestingLevels: [{ glyphType: 'DECIMAL' }],
                                    },
                                },
                            },
                        },
                    },
                ],
            },
        });

        const server = createServer();
        register(server);

        const result = await server.getTool('readDocument').execute(
            {
                documentId: 'doc-1',
                format: 'markdown',
                tabId: 'tab-1',
                diffFromLastRead: false,
            },
            { log }
        );

        expect(result).toContain('1. First step');
        expect(result).not.toContain('- First step');
    });
});
