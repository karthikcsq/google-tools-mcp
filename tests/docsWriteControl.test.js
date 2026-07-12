import { describe, it, expect, jest } from '@jest/globals';
import { UserError } from 'fastmcp';
import { executeBatchUpdate } from '../dist/googleDocsApiHelpers.js';
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
