// Issue #122: readDocument overwrote the local mirror file unconditionally,
// silently destroying an unpushed local edit -- and the workflow it itself
// recommends (readDocument -> edit the mirror -> replaceDocumentWithMarkdown,
// with a diffFromLastRead staleness check before pushing) walks straight into
// that trap: the "safe" pre-push check was the read that wiped the edit.
//
// Two fixes, both covered here (dist/tools/docs/readGoogleDoc.js, using
// dist/workspace.js's backupIfLocallyModified):
//   * A read whose target mirror file was modified more recently than this
//     process's own last write to it is treated as holding an unpushed local
//     edit: the file is backed up to '<path>.bak' before being overwritten,
//     and the result says so.
//   * writeLocalFile:false skips writing to the mirror entirely (e.g. for a
//     diffFromLastRead staleness check the caller does not intend to edit
//     from), so there is nothing to protect and nothing to overwrite.
//
// This exercises the LEGACY (no ambient request context) code path, exactly
// like tests/readGoogleDocWorkspace.test.js: server.getTool(...).execute()
// is called directly, with only dist/clients.js mocked, so writeWorkspaceFile
// and backupIfLocallyModified run against a real (sandboxed) filesystem.
import { describe, expect, it, jest, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const WORKSPACE_ROOT = path.join(os.tmpdir(), `gtm-readdoc-mirror-conflict-${process.pid}-${Date.now()}`);
process.env.GOOGLE_MCP_WORKSPACE_DIR = WORKSPACE_ROOT;

const documentsGet = jest.fn();

jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => ({ documents: { get: documentsGet } }),
    getDriveClient: async () => ({
        files: { get: async () => ({ data: { modifiedTime: null } }) },
    }),
}));

const { register } = await import('../dist/tools/docs/readGoogleDoc.js');
const { getWorkspacePath } = await import('../dist/workspace.js');

function createServer() {
    const tools = new Map();
    return {
        addTool(tool) { tools.set(tool.name, tool); },
        getTool(name) { return tools.get(name); },
    };
}

const log = { info() {}, error() {}, warn() {}, debug() {} };

function docWithBody(content) {
    return { data: { body: { content } } };
}

function paraDoc(text) {
    return docWithBody([{ paragraph: { elements: [{ textRun: { content: `${text}\n` } }] } }]);
}

const cleanupPaths = [];
afterEach(async () => {
    for (const p of cleanupPaths.splice(0)) {
        await fs.rm(p, { force: true }).catch(() => {});
        await fs.rm(`${p}.bak`, { force: true }).catch(() => {});
    }
});

async function readOnce(server, documentId, args = {}) {
    return server.getTool('readDocument').execute(
        { documentId, format: 'markdown', diffFromLastRead: false, ...args },
        { log }
    );
}

describe('readDocument local mirror conflict handling (#122)', () => {
    it('backs up an unpushed local edit before the next read overwrites the mirror', async () => {
        const documentId = `mirror-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const localPath = getWorkspacePath(documentId);
        cleanupPaths.push(localPath);

        const server = createServer();
        register(server);

        documentsGet.mockResolvedValueOnce(paraDoc('Original document content'));
        await readOnce(server, documentId);
        expect(await fs.readFile(localPath, 'utf-8')).toBe('Original document content');

        // A human edits the working copy readDocument told them to edit, and
        // does NOT push it yet.
        await fs.writeFile(localPath, 'MY UNPUSHED SECTION, NOT YET PUSHED', 'utf-8');

        documentsGet.mockResolvedValueOnce(paraDoc('Original document content'));
        const result = await readOnce(server, documentId);

        expect(result).toContain('⚠️ LOCAL MIRROR CONFLICT');
        expect(result).toContain(`${localPath}.bak`.replace(/\\/g, '/'));
        // The mirror itself now holds the fresh read (the overwrite still
        // proceeds) -- recovery is from the .bak file, not from re-reading.
        expect(await fs.readFile(localPath, 'utf-8')).toBe('Original document content');
        expect(await fs.readFile(`${localPath}.bak`, 'utf-8')).toBe('MY UNPUSHED SECTION, NOT YET PUSHED');
    });

    it('says nothing about a conflict on an ordinary read-then-read with no local edit', async () => {
        const documentId = `mirror-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        cleanupPaths.push(getWorkspacePath(documentId));

        const server = createServer();
        register(server);

        documentsGet.mockResolvedValueOnce(paraDoc('v1'));
        await readOnce(server, documentId);

        documentsGet.mockResolvedValueOnce(paraDoc('v2, changed on the server only'));
        const result = await readOnce(server, documentId);

        expect(result).not.toContain('LOCAL MIRROR CONFLICT');
        expect(result).toContain('v2, changed on the server only');
    });

    it('also protects an unpushed edit across a diffFromLastRead staleness check', async () => {
        const documentId = `mirror-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const localPath = getWorkspacePath(documentId);
        cleanupPaths.push(localPath);

        const server = createServer();
        register(server);

        documentsGet.mockResolvedValueOnce(paraDoc('v1'));
        await readOnce(server, documentId);

        await fs.writeFile(localPath, 'unpushed local section', 'utf-8');

        // The exact repro from the issue: diffFromLastRead=true as a "safe"
        // pre-push staleness check, with nothing changed on the server.
        documentsGet.mockResolvedValueOnce(paraDoc('v1'));
        const result = await readOnce(server, documentId, { diffFromLastRead: true });

        expect(result).toContain('LOCAL MIRROR CONFLICT');
        expect(await fs.readFile(`${localPath}.bak`, 'utf-8')).toBe('unpushed local section');
    });

    it('writeLocalFile:false leaves the mirror file untouched entirely', async () => {
        const documentId = `mirror-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const localPath = getWorkspacePath(documentId);
        cleanupPaths.push(localPath);

        const server = createServer();
        register(server);

        documentsGet.mockResolvedValueOnce(paraDoc('v1'));
        await readOnce(server, documentId, { writeLocalFile: false });

        // Nothing was written at all -- no mirror, no backup, no advice line.
        await expect(fs.stat(localPath)).rejects.toThrow();
        await expect(fs.stat(`${localPath}.bak`)).rejects.toThrow();
    });

    it('writeLocalFile:false on a diffFromLastRead check never overwrites or backs up an existing edit', async () => {
        const documentId = `mirror-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const localPath = getWorkspacePath(documentId);
        cleanupPaths.push(localPath);

        const server = createServer();
        register(server);

        documentsGet.mockResolvedValueOnce(paraDoc('v1'));
        await readOnce(server, documentId);

        await fs.writeFile(localPath, 'unpushed local section, must survive', 'utf-8');
        const future = new Date(Date.now() + 10_000);
        await fs.utimes(localPath, future, future);

        documentsGet.mockResolvedValueOnce(paraDoc('v1'));
        const result = await readOnce(server, documentId, { diffFromLastRead: true, writeLocalFile: false });

        expect(result).not.toContain('LOCAL MIRROR CONFLICT');
        // The file on disk is exactly what the human wrote -- readDocument
        // never touched it.
        expect(await fs.readFile(localPath, 'utf-8')).toBe('unpushed local section, must survive');
        await expect(fs.stat(`${localPath}.bak`)).rejects.toThrow();
    });

    it('defaults writeLocalFile to true when the field is omitted', async () => {
        const documentId = `mirror-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const localPath = getWorkspacePath(documentId);
        cleanupPaths.push(localPath);

        const server = createServer();
        register(server);

        documentsGet.mockResolvedValueOnce(paraDoc('Hello world'));
        const result = await readOnce(server, documentId);

        expect(result).toContain('📄 Local file:');
        expect(await fs.readFile(localPath, 'utf-8')).toBe('Hello world');
    });
});
