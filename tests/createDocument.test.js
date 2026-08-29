import { describe, expect, it, jest } from '@jest/globals';
import { executeBatchUpdateWithSplitting } from '../dist/googleDocsApiHelpers.js';

let fakeDrive;
let fakeDocs;
const insertMarkdown = jest.fn();
const formatInsertResult = jest.fn(() => 'insert summary');

jest.unstable_mockModule('../dist/clients.js', () => ({
    getDriveClient: async () => fakeDrive,
    getDocsClient: async () => fakeDocs,
}));
jest.unstable_mockModule('../dist/markdown-transformer/index.js', () => ({
    insertMarkdown,
    formatInsertResult,
}));

const { register } = await import('../dist/tools/drive/createDocument.js');

function getTool() {
    let tool;
    register({ addTool(definition) { tool = definition; } });
    return tool;
}

const log = { info() {}, warn() {}, error() {}, debug() {} };
const createdDocument = { id: 'doc-123', name: 'Roadmap', webViewLink: 'https://docs.google.com/document/d/doc-123/edit' };

function setSuccessfulClients() {
    fakeDrive = { files: { create: jest.fn(async () => ({ data: createdDocument })) } };
    fakeDocs = { documents: { batchUpdate: jest.fn(async () => ({ data: {} })) } };
    insertMarkdown.mockReset().mockResolvedValue({ warnings: [] });
    formatInsertResult.mockClear();
}

describe('createDocument', () => {
    it('creates a root document and returns the API identity fields', async () => {
        setSuccessfulClients();
        const result = JSON.parse(await getTool().execute({ title: 'Roadmap' }, { log }));

        expect(fakeDrive.files.create).toHaveBeenCalledWith({
            requestBody: { name: 'Roadmap', mimeType: 'application/vnd.google-apps.document' },
            fields: 'id,name,webViewLink',
            supportsAllDrives: true,
        });
        expect(result).toEqual({ id: 'doc-123', name: 'Roadmap', url: createdDocument.webViewLink });
        expect(fakeDocs.documents.batchUpdate).not.toHaveBeenCalled();
        expect(insertMarkdown).not.toHaveBeenCalled();
    });

    it('places the document in its parent folder and inserts raw initial content', async () => {
        setSuccessfulClients();
        await getTool().execute({ title: 'Roadmap', parentFolderId: 'folder-456', initialContent: 'plain text', contentFormat: 'raw' }, { log });

        expect(fakeDrive.files.create.mock.calls[0][0].requestBody.parents).toEqual(['folder-456']);
        expect(fakeDocs.documents.batchUpdate).toHaveBeenCalledWith({
            documentId: 'doc-123',
            requestBody: { requests: [{ insertText: { location: { index: 1 }, text: 'plain text' } }] },
        });
        expect(insertMarkdown).not.toHaveBeenCalled();
    });

    it('delegates markdown initial content and returns its fidelity warnings', async () => {
        setSuccessfulClients();
        insertMarkdown.mockResolvedValue({ warnings: ['Unsupported tag dropped.'] });
        const result = JSON.parse(await getTool().execute({ title: 'Roadmap', initialContent: '# Heading' }, { log }));

        expect(insertMarkdown).toHaveBeenCalledWith(fakeDocs, 'doc-123', '# Heading', { startIndex: 1, firstHeadingAsTitle: true });
        expect(result.warnings).toEqual(['Unsupported tag dropped.']);
        expect(result.warningNote).toContain('1 item');
    });

    it('returns a visible partial-result warning when initial content insertion fails', async () => {
        setSuccessfulClients();
        insertMarkdown.mockRejectedValue(new Error('internal transport detail'));
        const result = JSON.parse(await getTool().execute({ title: 'Roadmap', initialContent: '# Heading' }, { log }));

        expect(result.warnings).toEqual(['Document created but initial content failed.']);
        expect(result.warningNote).toBe('The document was created, but its initial content could not be added.');
        expect(JSON.stringify(result)).not.toContain('internal transport detail');
    });

    // Review finding 3: insertMarkdown's markdown path is NOT atomic (separate
    // documents.batchUpdate calls per delete/insert/format phase, and batches
    // of 50 within each) — a batch that already succeeded stays committed even
    // if a later batch in the same call throws. The "could not be added"
    // message is only true when NOTHING landed; when something did, the
    // response must say so and point the caller at the document instead of
    // implying it's safe to blindly resend initialContent.
    it('distinguishes a partially-applied batch failure from a total one and tells the caller to inspect the document', async () => {
        setSuccessfulClients();
        // Produce a REAL progress-tagged error via the actual splitting helper
        // (not a hand-rolled stand-in) so this exercises the true mechanism
        // createDocument relies on: batch 1 (50 of 60 insertText requests)
        // succeeds against fakeDocs, batch 2 fails.
        let batchUpdateCalls = 0;
        fakeDocs.documents.batchUpdate = jest.fn(async () => {
            batchUpdateCalls += 1;
            if (batchUpdateCalls === 2) throw Object.assign(new Error('backend hiccup'), { code: 500 });
            return { data: {} };
        });
        const manyInsertRequests = Array.from({ length: 60 }, (_, i) => ({ insertText: { location: { index: 1 }, text: `line ${i}\n` } }));
        let partialProgressError;
        try {
            await executeBatchUpdateWithSplitting(fakeDocs, 'doc-123', manyInsertRequests, undefined, undefined);
        } catch (error) {
            partialProgressError = error;
        }
        expect(partialProgressError).toBeDefined();
        expect(batchUpdateCalls).toBe(2);

        insertMarkdown.mockRejectedValue(partialProgressError);
        const result = JSON.parse(await getTool().execute({ title: 'Roadmap', initialContent: '# Heading' }, { log }));

        expect(result.warnings).toEqual(['Document created but initial content was only partially applied before a later operation failed.']);
        expect(result.warningNote).toMatch(/50 of 60 content operation/);
        expect(result.warningNote).toMatch(/insert phase/);
        expect(result.warningNote).toMatch(/inspect the document/i);
        expect(result.warningNote).not.toBe('The document was created, but its initial content could not be added.');
        expect(JSON.stringify(result)).not.toContain('backend hiccup');
    });

    it('maps Drive 404 and 403 failures to public folder errors', async () => {
        fakeDocs = { documents: { batchUpdate: jest.fn() } };
        fakeDrive = { files: { create: jest.fn(async () => { throw Object.assign(new Error('not found'), { code: 404 }); }) } };
        await expect(getTool().execute({ title: 'Roadmap' }, { log })).rejects.toThrow('Parent folder not found');

        fakeDrive.files.create.mockImplementation(async () => { throw Object.assign(new Error('forbidden'), { code: 403 }); });
        await expect(getTool().execute({ title: 'Roadmap' }, { log })).rejects.toThrow('Permission denied');
    });
});
