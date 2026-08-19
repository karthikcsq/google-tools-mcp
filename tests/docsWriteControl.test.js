import { describe, it, expect, jest } from '@jest/globals';
import { UserError } from '../dist/errors.js';
import { executeBatchUpdate, executeBatchUpdateWithSplitting } from '../dist/googleDocsApiHelpers.js';
import { getLastReadRevisionId, trackRead } from '../dist/readTracker.js';

describe('Google Docs optimistic concurrency', () => {
    it('sends the revision tracked by the last read as requiredRevisionId', async () => {
        const documentId = `write-control-${Date.now()}`;
        const batchUpdate = jest.fn().mockResolvedValue({ data: { replies: [] } });
        const docs = { documents: { batchUpdate } };
        trackRead(documentId, null, null, 'revision-123');

        const revisionId = getLastReadRevisionId(documentId);
        await executeBatchUpdate(docs, documentId, [{ insertText: {} }], {
            requiredRevisionId: revisionId,
        });

        expect(batchUpdate).toHaveBeenCalledWith({
            documentId,
            requestBody: {
                requests: [{ insertText: {} }],
                writeControl: { requiredRevisionId: 'revision-123' },
            },
        });
    });

    it('omits writeControl when no revisionId is available', async () => {
        const batchUpdate = jest.fn().mockResolvedValue({ data: {} });
        const docs = { documents: { batchUpdate } };

        await executeBatchUpdate(docs, 'doc-without-revision', [{ insertText: {} }]);

        expect(batchUpdate).toHaveBeenCalledWith({
            documentId: 'doc-without-revision',
            requestBody: { requests: [{ insertText: {} }] },
        });
    });

    it('treats FAILED_PRECONDITION as a conflict regardless of message wording', async () => {
        const error = Object.assign(new Error('Precondition check failed.'), {
            code: 400,
            response: { data: { error: { status: 'FAILED_PRECONDITION', message: 'Precondition check failed.' } } },
        });
        const docs = { documents: { batchUpdate: jest.fn().mockRejectedValue(error) } };

        await expect(
            executeBatchUpdate(docs, 'changed-doc', [{ insertText: {} }], { requiredRevisionId: 'stale' })
        ).rejects.toThrow(/changed since you last read/i);
    });

    it('does not classify errors as conflicts when no writeControl was sent', async () => {
        const error = Object.assign(new Error('The document has been updated since the revision specified.'), { code: 400 });
        const docs = { documents: { batchUpdate: jest.fn().mockRejectedValue(error) } };

        await expect(
            executeBatchUpdate(docs, 'doc', [{ insertText: {} }])
        ).rejects.toThrow(/Google API Error/);
    });

    it('chains writeControl across split batches using each response revision', async () => {
        // Each successful batchUpdate returns the document's new head revision.
        // The next batch must require that revision so a collaborator edit landing
        // between our own batches is rejected as a conflict rather than applied.
        let n = 0;
        const batchUpdate = jest.fn().mockImplementation(async () => ({
            data: { replies: [], writeControl: { requiredRevisionId: `rev-after-${++n}` } },
        }));
        const docs = { documents: { batchUpdate } };
        const requests = [
            { deleteContentRange: { range: { startIndex: 1, endIndex: 5 } } },
            { insertText: { location: { index: 1 }, text: 'hello' } },
            { updateTextStyle: { range: { startIndex: 1, endIndex: 5 }, textStyle: {}, fields: 'bold' } },
        ];

        await executeBatchUpdateWithSplitting(docs, 'doc-1', requests, undefined, {
            requiredRevisionId: 'rev-1',
        });

        // Three phases (delete → insert → format) → three batches.
        expect(batchUpdate.mock.calls.length).toBe(3);
        // First batch requires the revision from our read; each later batch requires
        // the revision the previous batch produced.
        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-1' });
        expect(batchUpdate.mock.calls[1][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-after-1' });
        expect(batchUpdate.mock.calls[2][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-after-2' });
    });

    it('leaves split batches unguarded when no initial writeControl (legacy flow)', async () => {
        // A response revision must not silently start guarding a flow that never
        // captured a revision at read time.
        const batchUpdate = jest.fn().mockResolvedValue({
            data: { replies: [], writeControl: { requiredRevisionId: 'rev-x' } },
        });
        const docs = { documents: { batchUpdate } };
        const requests = [
            { deleteContentRange: { range: { startIndex: 1, endIndex: 5 } } },
            { insertText: { location: { index: 1 }, text: 'hello' } },
            { updateTextStyle: { range: { startIndex: 1, endIndex: 5 }, textStyle: {}, fields: 'bold' } },
        ];

        await executeBatchUpdateWithSplitting(docs, 'doc-1', requests, undefined, undefined);

        expect(batchUpdate.mock.calls.length).toBe(3);
        for (const call of batchUpdate.mock.calls) {
            expect(call[0].requestBody.writeControl).toBeUndefined();
        }
    });

    it('turns a revision mismatch into a friendly UserError', async () => {
        const error = Object.assign(new Error(
            'The document has been updated since the revision specified in the request.'
        ), { code: 400 });
        const docs = { documents: { batchUpdate: jest.fn().mockRejectedValue(error) } };

        let conflict;
        try {
            await executeBatchUpdate(docs, 'changed-doc', [{ insertText: {} }], {
                requiredRevisionId: 'stale-revision',
            });
        } catch (error) {
            conflict = error;
        }
        expect(conflict).toBeInstanceOf(UserError);
        expect(conflict.message).toMatch(/changed since you last read.*Read the document again/i);
    });
});
