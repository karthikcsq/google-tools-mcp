// Pins the user-facing "Successfully ..." success line that both
// appendMarkdown and replaceDocumentWithMarkdown return, and the warning-count
// note appended to it when insertMarkdown reports dropped content.
//
// commit 5e88458 ("surface warning count in the markdown tools' success
// line") accidentally dropped the word "Successfully" from BOTH tools'
// messages while adding the warning note. That regression was only caught in
// replaceDocumentWithMarkdown.js because PR #69's workspace-mirror test
// happened to assert the full string; appendMarkdown.js's identical
// regression had no test and shipped unnoticed. This file guards both tools
// the same way so neither string can drift again silently.
import { describe, expect, it, jest, beforeEach, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const documentsGet = jest.fn();
const documentsBatchUpdate = jest.fn();
const insertMarkdownMock = jest.fn();

jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => ({
        documents: { get: documentsGet, batchUpdate: documentsBatchUpdate },
    }),
    getDriveClient: async () => ({
        files: { get: async () => ({ data: { modifiedTime: null } }) },
    }),
}));

jest.unstable_mockModule('../dist/markdown-transformer/index.js', () => ({
    docsJsonToMarkdown: () => '',
    checkMarkdownFidelity: () => [],
    insertMarkdown: insertMarkdownMock,
    formatInsertResult: () => 'mock insert summary',
}));

const { register: registerAppend } = await import('../dist/tools/utils/appendMarkdownToGoogleDoc.js');
const { register: registerReplace } = await import('../dist/tools/utils/replaceDocumentWithMarkdown.js');
const { trackRead } = await import('../dist/readTracker.js');

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

// Body shape reused for the documents.get calls both tools make. The exact
// indices don't matter -- only that the surrounding batchUpdate/get calls
// succeed so execution reaches insertMarkdown.
const genericBody = {
    data: { body: { content: [{ startIndex: 1, endIndex: 5, paragraph: {} }] } },
};

function newDocumentId(label) {
    return `doc-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// replaceDocumentWithMarkdown mirrors pushed content into the local workspace
// (dist/workspace.js) after a successful insert. Sandbox that in a throwaway
// directory rather than the real per-user production workspace, matching
// tests/replaceDocumentWithMarkdown.test.js.
let sandboxDir;
let previousEnvValue;

beforeAll(async () => {
    previousEnvValue = process.env.GOOGLE_MCP_WORKSPACE_DIR;
    sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtm-success-msg-test-'));
    process.env.GOOGLE_MCP_WORKSPACE_DIR = sandboxDir;
});

afterAll(async () => {
    if (previousEnvValue === undefined) {
        delete process.env.GOOGLE_MCP_WORKSPACE_DIR;
    } else {
        process.env.GOOGLE_MCP_WORKSPACE_DIR = previousEnvValue;
    }
    await fs.rm(sandboxDir, { recursive: true, force: true });
});

beforeEach(() => {
    documentsGet.mockReset().mockResolvedValue(genericBody);
    documentsBatchUpdate.mockReset().mockResolvedValue({ data: {} });
});

describe('appendMarkdown success message', () => {
    it('starts with "Successfully appended" and omits a warning note when there are no warnings', async () => {
        insertMarkdownMock.mockReset().mockResolvedValue({
            totalElapsedMs: 1,
            parseElapsedMs: 1,
            warnings: [],
        });

        const documentId = newDocumentId('append-clean');
        trackRead(documentId, null);
        const server = createServer();
        registerAppend(server);

        const result = await server.getTool('appendMarkdown').execute(
            { documentId, markdown: 'Some content' },
            { log }
        );

        expect(result).toContain('Successfully appended 12 characters of markdown.');
        expect(result).not.toContain('warning');
    });

    it('keeps the "Successfully appended" prefix and adds the warning-count note when content was dropped', async () => {
        insertMarkdownMock.mockReset().mockResolvedValue({
            totalElapsedMs: 1,
            parseElapsedMs: 1,
            warnings: ['Dropped an unsupported <img> tag.', 'Dropped a second unsupported tag.'],
        });

        const documentId = newDocumentId('append-warn');
        trackRead(documentId, null);
        const server = createServer();
        registerAppend(server);

        const result = await server.getTool('appendMarkdown').execute(
            { documentId, markdown: 'Some content' },
            { log }
        );

        expect(result).toContain('Successfully appended 12 characters of markdown with 2 warnings (content dropped');
    });
});

describe('replaceDocumentWithMarkdown success message', () => {
    it('starts with "Successfully replaced document content" and omits a warning note when there are no warnings', async () => {
        insertMarkdownMock.mockReset().mockResolvedValue({
            totalElapsedMs: 1,
            parseElapsedMs: 1,
            warnings: [],
        });

        const documentId = newDocumentId('replace-clean');
        trackRead(documentId, null);
        const server = createServer();
        registerReplace(server);

        const result = await server.getTool('replaceDocumentWithMarkdown').execute(
            { documentId, markdown: 'Some content' },
            { log }
        );

        expect(result).toContain('Successfully replaced document content with 12 characters of markdown.');
        expect(result).not.toContain('warning');
    });

    it('keeps the "Successfully replaced" prefix and adds the warning-count note when content was dropped', async () => {
        insertMarkdownMock.mockReset().mockResolvedValue({
            totalElapsedMs: 1,
            parseElapsedMs: 1,
            warnings: ['Dropped an unsupported <img> tag.'],
        });

        const documentId = newDocumentId('replace-warn');
        trackRead(documentId, null);
        const server = createServer();
        registerReplace(server);

        const result = await server.getTool('replaceDocumentWithMarkdown').execute(
            { documentId, markdown: 'Some content' },
            { log }
        );

        expect(result).toContain('Successfully replaced document content with 12 characters of markdown with 1 warning (content dropped');
    });
});
