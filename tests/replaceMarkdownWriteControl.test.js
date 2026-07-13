// Regression test for PR #42 review (ElliotDrel): the best-effort survivor
// cleanup in replaceDocumentWithMarkdown must NOT drop the optimistic-concurrency
// guard when it fails for a non-conflict reason. If cleanup fails, the document
// was not modified, so the following markdown insert must still carry the pending
// requiredRevisionId — otherwise a transient cleanup error reopens the exact
// read-to-write race this PR closes.
//
// Drives the real tool handler with a mocked Google Docs/Drive client (clients.js
// is the only external dependency; everything else — readTracker, insertMarkdown —
// runs for real).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock the auth clients before importing anything that pulls them in.
let fakeDocs;
let fakeDrive;
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => fakeDocs,
    getDriveClient: async () => fakeDrive,
    // Other exports are unused by this flow but present on the real module.
    getSheetsClient: async () => { throw new Error('not used'); },
    getCalendarClient: async () => { throw new Error('not used'); },
}));

const { trackRead } = await import('../dist/readTracker.js');
const { register } = await import('../dist/tools/utils/replaceDocumentWithMarkdown.js');

function createMockServer() {
    const tools = new Map();
    return {
        addTool(def) { tools.set(def.name, def); },
        getTool(name) { return tools.get(name); },
    };
}

const noopLog = { info() {}, error() {}, warn() {}, debug() {} };

describe('replaceDocumentWithMarkdown — guard survives non-conflict cleanup failure', () => {
    let batchCalls;

    beforeEach(() => {
        batchCalls = [];
        // documents.get is called for: replace structure read, post-delete survivor
        // read, and insertMarkdown's namedStyles fetch. Differentiate by fields.
        const documentsGet = jest.fn(async ({ fields }) => {
            if (fields === 'namedStyles') {
                return { data: { namedStyles: { styles: [] } } };
            }
            // First structure read: a non-empty body so the delete step runs.
            // Post-delete survivor read: a short body. Both shapes work for the
            // survivor math; endIndex just needs to be > startIndex on the first.
            return { data: { body: { content: [{ startIndex: 1, endIndex: 10 }] } } };
        });

        const batchUpdate = jest.fn(async ({ requestBody }) => {
            const requests = requestBody.requests;
            batchCalls.push({ requests, writeControl: requestBody.writeControl });
            const isDelete = requests.some((r) => 'deleteContentRange' in r);
            const isCleanup = requests.some(
                (r) => 'deleteParagraphBullets' in r || 'updateTextStyle' in r
            );
            if (isCleanup && !isDelete) {
                // Cleanup batch fails for a NON-conflict reason (e.g. transient 500).
                throw Object.assign(new Error('transient backend error'), { code: 500 });
            }
            if (isDelete) {
                return { data: { writeControl: { requiredRevisionId: 'rev-after-delete' } } };
            }
            // Insert / format batches.
            return { data: { writeControl: { requiredRevisionId: 'rev-after-insert' } } };
        });

        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
        fakeDrive = { files: { get: async () => ({ data: { modifiedTime: null } }) } };
    });

    it('insert still carries the post-delete revision after cleanup fails', async () => {
        const documentId = `replace-guard-${Date.now()}`;
        // Read captures a revision so the operation is guarded.
        trackRead(documentId, null, '# old content', 'rev-read');

        const server = createMockServer();
        register(server);
        const tool = server.getTool('replaceDocumentWithMarkdown');

        await tool.execute(
            { documentId, markdown: '# New heading\n\nSome new body text.' },
            { log: noopLog }
        );

        const deleteCall = batchCalls.find((c) => c.requests.some((r) => 'deleteContentRange' in r));
        const cleanupCall = batchCalls.find(
            (c) => c.requests.some((r) => 'deleteParagraphBullets' in r)
        );
        const firstInsertCall = batchCalls.find((c) => c.requests.some((r) => 'insertText' in r));

        // Delete is the first write and carries the revision from our read.
        expect(deleteCall).toBeDefined();
        expect(deleteCall.writeControl).toEqual({ requiredRevisionId: 'rev-read' });

        // Cleanup peeks the current guard (post-delete revision) but fails.
        expect(cleanupCall).toBeDefined();
        expect(cleanupCall.writeControl).toEqual({ requiredRevisionId: 'rev-after-delete' });

        // The point of the regression: because cleanup failed (non-conflict) and did
        // NOT change the document, the guard is preserved and the insert still
        // carries the post-delete revision — the race stays closed.
        expect(firstInsertCall).toBeDefined();
        expect(firstInsertCall.writeControl).toEqual({ requiredRevisionId: 'rev-after-delete' });
    });

    it('a revision conflict during cleanup is surfaced, not swallowed', async () => {
        // If the cleanup fails specifically because the document changed, that is a
        // genuine concurrent edit and must abort the whole operation.
        const documentId = `replace-conflict-${Date.now()}`;
        trackRead(documentId, null, '# old content', 'rev-read');

        // Override batchUpdate so the cleanup batch fails with a revision conflict.
        fakeDocs.documents.batchUpdate = jest.fn(async ({ requestBody }) => {
            const requests = requestBody.requests;
            const isDelete = requests.some((r) => 'deleteContentRange' in r);
            const isCleanup = requests.some(
                (r) => 'deleteParagraphBullets' in r || 'updateTextStyle' in r
            );
            if (isDelete) {
                return { data: { writeControl: { requiredRevisionId: 'rev-after-delete' } } };
            }
            if (isCleanup) {
                throw Object.assign(new Error('The document has been updated since the revision specified.'), {
                    code: 400,
                    response: { data: { error: { status: 'FAILED_PRECONDITION', message: 'revision mismatch' } } },
                });
            }
            return { data: {} };
        });

        const server = createMockServer();
        register(server);
        const tool = server.getTool('replaceDocumentWithMarkdown');

        await expect(
            tool.execute(
                { documentId, markdown: '# New heading\n\nSome new body text.' },
                { log: noopLog }
            )
        ).rejects.toThrow(/changed since you last read/i);
    });
});
