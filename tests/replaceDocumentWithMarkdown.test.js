// Regression tests for the local-workspace mirror write ordering in
// dist/tools/utils/replaceDocumentWithMarkdown.js.
//
// The workspace mirror used to be written BEFORE the Google Docs mutation
// (fetch/delete/cleanup/insert) had succeeded. That meant a failure anywhere
// in that sequence left the local file holding content that was never
// actually committed to the document -- and if the delete step had already
// succeeded before the insert step failed, the workspace file showed the
// full intended result while the document itself was left partial. These
// tests pin that the mirror write now only happens after insertMarkdown
// resolves and the mutation is tracked, so a failed push never touches the
// previous local copy.
//
// Uses GOOGLE_MCP_WORKSPACE_DIR (dist/workspace.js) to sandbox these
// tests in a throwaway fs.mkdtemp() directory instead of the real per-user
// production workspace.
import { describe, expect, it, jest, beforeAll, afterAll } from '@jest/globals';
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

const { register } = await import('../dist/tools/utils/replaceDocumentWithMarkdown.js');
const { trackRead } = await import('../dist/readTracker.js');
const { writeWorkspaceFile, getWorkspacePath, getWorkspaceDir } = await import('../dist/workspace.js');

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

// Body shape reused for both documents.get calls the tool makes (the initial
// structure fetch and the post-delete survivor re-read). The exact indices
// don't matter for these tests -- only that the delete/cleanup batchUpdate
// calls succeed so execution reaches insertMarkdown.
const genericBody = { data: { body: { content: [{ startIndex: 1, endIndex: 5, paragraph: {} }] } } };

let sandboxDir;
let previousEnvValue;

beforeAll(async () => {
    previousEnvValue = process.env.GOOGLE_MCP_WORKSPACE_DIR;
    sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtm-replace-md-test-'));
    process.env.GOOGLE_MCP_WORKSPACE_DIR = sandboxDir;
});

afterAll(async () => {
    if (previousEnvValue === undefined) {
        delete process.env.GOOGLE_MCP_WORKSPACE_DIR;
    } else {
        process.env.GOOGLE_MCP_WORKSPACE_DIR = previousEnvValue;
    }
    // Safe to remove unconditionally: this is our own throwaway sandbox
    // directory, never the real production workspace path.
    await fs.rm(sandboxDir, { recursive: true, force: true });
});

describe('replaceDocumentWithMarkdown workspace mirror ordering', () => {
    it('leaves the previous workspace copy untouched when the Docs insert fails', async () => {
        expect(getWorkspaceDir()).toBe(sandboxDir);

        const documentId = `doc-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await writeWorkspaceFile(documentId, 'PREVIOUS COMMITTED CONTENT');
        trackRead(documentId, null);

        documentsGet.mockReset().mockResolvedValue(genericBody);
        documentsBatchUpdate.mockReset().mockResolvedValue({ data: {} });
        insertMarkdownMock.mockReset().mockRejectedValue(new Error('simulated insert failure'));

        const server = createServer();
        register(server);

        // The tool still rejects, but the arbitrary caught text is now an
        // internal cause rather than a caller-visible message: the caller gets
        // the generic operation template only.
        let thrown;
        try {
            await server.getTool('replaceDocumentWithMarkdown').execute(
                { documentId, markdown: 'NEW CONTENT THAT NEVER LANDS' },
                { log }
            );
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeDefined();
        expect(thrown.message).toBe('The apply markdown operation failed.');
        expect(thrown.message).not.toContain('simulated insert failure');

        // The Docs mutation never succeeded, so the local mirror must still
        // hold exactly what was there before this call -- never the new
        // content, and never deleted.
        const onDisk = await fs.readFile(getWorkspacePath(documentId), 'utf-8');
        expect(onDisk).toBe('PREVIOUS COMMITTED CONTENT');
    });

    it('leaves the previous workspace copy untouched when delete succeeds but insert fails', async () => {
        // Same as above, but explicit about the "partial document" scenario the
        // review comment called out: deleteContentRange (the first batchUpdate)
        // succeeds, then insertMarkdown fails. The workspace must not show the
        // full intended result while the document itself is left partial.
        const documentId = `doc-partial-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await writeWorkspaceFile(documentId, 'OLD DOCUMENT CONTENT');
        trackRead(documentId, null);

        documentsGet.mockReset().mockResolvedValue(genericBody);
        documentsBatchUpdate.mockReset().mockResolvedValue({ data: {} }); // delete + cleanup succeed
        insertMarkdownMock.mockReset().mockRejectedValue(new Error('insert failed after delete'));

        const server = createServer();
        register(server);

        await expect(
            server.getTool('replaceDocumentWithMarkdown').execute(
                { documentId, markdown: 'FULL NEW DOCUMENT' },
                { log }
            )
        ).rejects.toThrow();

        expect(documentsBatchUpdate).toHaveBeenCalled(); // delete did happen
        const onDisk = await fs.readFile(getWorkspacePath(documentId), 'utf-8');
        expect(onDisk).toBe('OLD DOCUMENT CONTENT');
    });

    it('mirrors the new content only after insertMarkdown succeeds', async () => {
        const documentId = `doc-success-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await writeWorkspaceFile(documentId, 'STALE CONTENT');
        trackRead(documentId, null);

        documentsGet.mockReset().mockResolvedValue(genericBody);
        documentsBatchUpdate.mockReset().mockResolvedValue({ data: {} });
        insertMarkdownMock.mockReset().mockResolvedValue({ totalElapsedMs: 1, parseElapsedMs: 1 });

        const server = createServer();
        register(server);

        const result = await server.getTool('replaceDocumentWithMarkdown').execute(
            { documentId, markdown: 'SUCCESSFULLY PUSHED CONTENT' },
            { log }
        );

        expect(result).toContain('Successfully replaced document content');
        const onDisk = await fs.readFile(getWorkspacePath(documentId), 'utf-8');
        expect(onDisk).toBe('SUCCESSFULLY PUSHED CONTENT');
    });
});
