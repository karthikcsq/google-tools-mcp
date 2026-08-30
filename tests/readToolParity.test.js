// Issue #96: parity test. readDocument and readDriveFile both convert Google
// Docs JSON to markdown through docsJsonToMarkdown, but only readDriveFile
// forwarded the plainMarkdown flag before this fix. This test drives one
// shared Docs-JSON fixture through both tools' full conversion paths at the
// same flag value and compares the extracted markdown content byte-for-byte,
// so the two tools can never silently diverge on this option again.
import { describe, expect, it, jest, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import { getWorkspacePath } from '../dist/workspace.js';

const documentsGet = jest.fn();

jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => ({ documents: { get: documentsGet } }),
    getDriveClient: async () => ({
        files: {
            get: async ({ fileId }) => ({
                data: {
                    id: fileId,
                    name: 'Parity fixture',
                    mimeType: 'application/vnd.google-apps.document',
                    modifiedTime: null,
                },
            }),
        },
    }),
    getSheetsClient: async () => ({}),
}));

const { register: registerReadDocument } = await import('../dist/tools/docs/readGoogleDoc.js');
const { register: registerReadDriveFile } = await import('../dist/tools/extras/readDriveFile.js');

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

// A doc with an explicit foreground color run, so rich markdown differs
// visibly from plain markdown for both tools.
function fixtureDoc() {
    return {
        body: {
            content: [
                {
                    paragraph: {
                        elements: [
                            {
                                textRun: {
                                    content: 'Colored text\n',
                                    textStyle: { foregroundColor: { color: { rgbColor: { red: 1, green: 0, blue: 0 } } } },
                                },
                            },
                        ],
                    },
                },
            ],
        },
    };
}

// readDocument returns "markdown\n\n📄 Local file: ..." advice text appended;
// readDriveFile returns a JSON envelope with a `content` field
// (readDriveFile.js:151-156). Extract just the markdown content from each so
// the comparison is apples-to-apples instead of comparing incompatible
// response envelopes.
function extractReadDocumentMarkdown(result) {
    const marker = '\n\n📄 Local file:';
    const idx = result.indexOf(marker);
    return idx === -1 ? result : result.slice(0, idx);
}

function extractReadDriveFileMarkdown(result) {
    return JSON.parse(result).content;
}

const cleanupPaths = [];
afterEach(async () => {
    for (const p of cleanupPaths.splice(0)) {
        await fs.rm(p, { force: true }).catch(() => {});
    }
});

describe('readDocument / readDriveFile markdown parity (#96)', () => {
    it('produce byte-identical markdown content by default (plainMarkdown absent)', async () => {
        const docServer = createServer();
        registerReadDocument(docServer);
        const documentId = `parity-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        cleanupPaths.push(getWorkspacePath(documentId));
        documentsGet.mockResolvedValueOnce({ data: fixtureDoc() });
        const docResult = await docServer.getTool('readDocument').execute(
            { documentId, format: 'markdown', diffFromLastRead: false },
            { log }
        );

        const driveServer = createServer();
        registerReadDriveFile(driveServer);
        documentsGet.mockResolvedValueOnce({ data: fixtureDoc() });
        const driveResult = await driveServer.getTool('readDriveFile').execute(
            { fileId: documentId, format: 'markdown' },
            { log }
        );

        expect(extractReadDocumentMarkdown(docResult)).toBe(extractReadDriveFileMarkdown(driveResult));
        expect(extractReadDocumentMarkdown(docResult)).toContain('<span style=');
    });

    it('produce byte-identical markdown content with plainMarkdown: true', async () => {
        const docServer = createServer();
        registerReadDocument(docServer);
        const documentId = `parity-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        cleanupPaths.push(getWorkspacePath(documentId));
        documentsGet.mockResolvedValueOnce({ data: fixtureDoc() });
        const docResult = await docServer.getTool('readDocument').execute(
            { documentId, format: 'markdown', diffFromLastRead: false, plainMarkdown: true },
            { log }
        );

        const driveServer = createServer();
        registerReadDriveFile(driveServer);
        documentsGet.mockResolvedValueOnce({ data: fixtureDoc() });
        const driveResult = await driveServer.getTool('readDriveFile').execute(
            { fileId: documentId, format: 'markdown', plainMarkdown: true },
            { log }
        );

        const docMarkdown = extractReadDocumentMarkdown(docResult);
        const driveMarkdown = extractReadDriveFileMarkdown(driveResult);
        expect(docMarkdown).toBe(driveMarkdown);
        expect(docMarkdown).not.toContain('<span style=');
        expect(docMarkdown).toContain('Colored text');
    });
});
