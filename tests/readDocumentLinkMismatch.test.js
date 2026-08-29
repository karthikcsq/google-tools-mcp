// Issue #117: readDocument's markdown output must surface a link whose
// display text disagrees with its actual target (a re-autolinked email, or a
// boundary that slid mid-word), since every other readable surface agrees
// with the wrong answer. This is the integration counterpart to
// tests/linkMismatchDetection.test.js (which tests the detector in
// isolation) — this file checks readDocument actually renders the block.
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

describe('readDocument LINK MISMATCH warning (#117)', () => {
    it('flags a mailto whose target disagrees with the visible email (issue case 1)', async () => {
        const documentId = `link-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        documentsGet.mockResolvedValueOnce(docWithBody([
            {
                paragraph: {
                    elements: [{
                        textRun: {
                            content: 'tyler@rolltackventures.com\n',
                            textStyle: { link: { url: 'mailto:tyler@rolltrackventures.com' } },
                        },
                    }],
                },
            },
        ]));

        const server = createServer();
        register(server);
        cleanupPaths.push(getWorkspacePath(documentId));

        const result = await server.getTool('readDocument').execute(
            { documentId, format: 'markdown', diffFromLastRead: false },
            { log }
        );

        expect(result).toContain('⚠️ LINK MISMATCH');
        expect(result).toContain('"tyler@rolltackventures.com" → mailto:tyler@rolltrackventures.com');
        expect(result).toContain('modifyText with style.linkUrl');
    });

    it('flags an autolink boundary break and names the preceding token (issue case 2)', async () => {
        const documentId = `link-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        documentsGet.mockResolvedValueOnce(docWithBody([
            {
                paragraph: {
                    elements: [
                        { textRun: { content: 'Fortitude Fund Fred.' } },
                        {
                            textRun: {
                                content: 'nash@yahoo.com\n',
                                textStyle: { link: { url: 'mailto:nash@yahoo.com' } },
                            },
                        },
                    ],
                },
            },
        ]));

        const server = createServer();
        register(server);
        cleanupPaths.push(getWorkspacePath(documentId));

        const result = await server.getTool('readDocument').execute(
            { documentId, format: 'markdown', diffFromLastRead: false },
            { log }
        );

        expect(result).toContain('⚠️ LINK MISMATCH');
        expect(result).toContain('preceded by "Fred." — possible autolink boundary break');
    });

    it('says nothing about links when every link matches its display text', async () => {
        const documentId = `link-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        documentsGet.mockResolvedValueOnce(docWithBody([
            {
                paragraph: {
                    elements: [{
                        textRun: {
                            content: 'tyler@rolltackventures.com\n',
                            textStyle: { link: { url: 'mailto:tyler@rolltackventures.com' } },
                        },
                    }],
                },
            },
        ]));

        const server = createServer();
        register(server);
        cleanupPaths.push(getWorkspacePath(documentId));

        const result = await server.getTool('readDocument').execute(
            { documentId, format: 'markdown', diffFromLastRead: false },
            { log }
        );

        expect(result).not.toContain('LINK MISMATCH');
    });

    it('says nothing for an ordinary prose link, regardless of target', async () => {
        const documentId = `link-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        documentsGet.mockResolvedValueOnce(docWithBody([
            {
                paragraph: {
                    elements: [{
                        textRun: {
                            content: 'click here\n',
                            textStyle: { link: { url: 'https://example.com/totally-different' } },
                        },
                    }],
                },
            },
        ]));

        const server = createServer();
        register(server);
        cleanupPaths.push(getWorkspacePath(documentId));

        const result = await server.getTool('readDocument').execute(
            { documentId, format: 'markdown', diffFromLastRead: false },
            { log }
        );

        expect(result).not.toContain('LINK MISMATCH');
    });
});
