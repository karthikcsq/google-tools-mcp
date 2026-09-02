import { describe, it, expect, jest, beforeAll, beforeEach } from '@jest/globals';

// Drive comment writes advance the Docs revisionId but leave Drive's
// modifiedTime alone (measured live on 2026-09-02: modifiedTime identical
// across addComment, replyToComment and resolveComment while revisionId
// changed each time). guardMutation only compares modifiedTime, so without a
// refresh the next body write went out pinned to the pre-comment revision and
// Google refused it: "This document (...) changed since you last read it"
// when the only change was our own comment. Every comment-mutating tool now
// re-arms the tracked revision after it succeeds.

const commentsCreate = jest.fn();
const commentsUpdate = jest.fn();
const commentsDelete = jest.fn();
const commentsGet = jest.fn();
const repliesCreate = jest.fn();
const documentsGet = jest.fn();

jest.unstable_mockModule('../dist/clients.js', () => ({
    getDriveClient: async () => ({
        comments: { create: commentsCreate, update: commentsUpdate, delete: commentsDelete, get: commentsGet },
        replies: { create: repliesCreate },
        files: { get: async () => ({ data: { modifiedTime: '2026-09-02T19:53:11.311Z' } }) },
    }),
    getDocsClient: async () => ({ documents: { get: documentsGet } }),
}));

const { trackRead, getLastReadRevisionId, getLastReadContent, refreshRevision, requireRereadBeforeMutation } =
    await import('../dist/readTracker.js');

const log = { info: () => {}, error: () => {}, warn: jest.fn() };
const docId = 'doc-with-comments';
const revisionProbes = () => documentsGet.mock.calls.filter(([req]) => req?.fields === 'revisionId');

describe('comment tools re-arm the tracked Docs revision', () => {
    let tools;

    beforeAll(async () => {
        tools = new Map();
        const { registerCommentTools } = await import('../dist/tools/docs/comments/index.js');
        registerCommentTools({ addTool: (tool) => tools.set(tool.name, tool) });
    });

    beforeEach(() => {
        jest.clearAllMocks();
        commentsCreate.mockResolvedValue({ data: { id: 'c1' } });
        commentsUpdate.mockResolvedValue({ data: { id: 'c1', content: 'x', modifiedTime: 't' } });
        commentsDelete.mockResolvedValue({});
        commentsGet.mockResolvedValue({ data: { resolved: true } });
        repliesCreate.mockResolvedValue({ data: { id: 'r1', action: 'resolve' } });
        // addComment's own documents.get (quoted text) has no field mask; the
        // revision probe asks for exactly `revisionId`.
        documentsGet.mockImplementation(async ({ fields }) => (fields === 'revisionId'
            ? { data: { revisionId: 'rev-after-comment' } }
            : { data: { body: { content: [] } } }));
    });

    const cases = [
        ['addComment', { documentId: docId, startIndex: 1, endIndex: 5, content: 'note' }],
        ['replyToComment', { documentId: docId, commentId: 'c1', content: 'reply' }],
        ['resolveComment', { documentId: docId, commentId: 'c1' }],
        ['updateComment', { documentId: docId, commentId: 'c1', content: 'edited' }],
        ['deleteComment', { documentId: docId, commentId: 'c1' }],
    ];

    it.each(cases)('%s refreshes the revision of a tracked document and keeps its content snapshot', async (name, args) => {
        trackRead(docId, '2026-09-02T19:53:11.311Z', '# Body\n', 'rev-at-read');

        await tools.get(name).execute(args, { log });

        expect(revisionProbes()).toHaveLength(1);
        expect(revisionProbes()[0][0]).toEqual({ documentId: docId, fields: 'revisionId' });
        expect(getLastReadRevisionId(docId)).toBe('rev-after-comment');
        // The body did not change, so the diff baseline must survive.
        expect(getLastReadContent(docId)).toBe('# Body\n');
    });

    it.each(cases)('%s does not probe the revision of a document this session never read', async (name, args) => {
        const untracked = { ...args, documentId: 'never-read' };

        await tools.get(name).execute(untracked, { log });

        expect(revisionProbes()).toHaveLength(0);
        expect(getLastReadRevisionId('never-read')).toBeNull();
    });

    it('leaves the stale revision in place (failing closed) when the probe fails, and does not fail the comment', async () => {
        trackRead(docId, '2026-09-02T19:53:11.311Z', '# Body\n', 'rev-at-read');
        documentsGet.mockImplementation(async ({ fields }) => {
            if (fields === 'revisionId') throw new Error('socket hang up');
            return { data: { body: { content: [] } } };
        });

        const result = await tools.get('addComment').execute(
            { documentId: docId, startIndex: 1, endIndex: 5, content: 'note' }, { log },
        );

        expect(result).toContain('Comment added successfully');
        expect(getLastReadRevisionId(docId)).toBe('rev-at-read');
        expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/Could not refresh the tracked revision/));
    });

    it('resolveComment refreshes even when the resolve did not persist (the reply still moved the revision)', async () => {
        trackRead(docId, '2026-09-02T19:53:11.311Z', '# Body\n', 'rev-at-read');
        commentsGet.mockResolvedValue({ data: { resolved: false } });

        await expect(tools.get('resolveComment').execute({ documentId: docId, commentId: 'c1' }, { log }))
            .rejects.toThrow(/did not persist/);

        expect(getLastReadRevisionId(docId)).toBe('rev-after-comment');
    });

    it('does not refresh when the comment write itself failed', async () => {
        trackRead(docId, '2026-09-02T19:53:11.311Z', '# Body\n', 'rev-at-read');
        commentsCreate.mockRejectedValue(new Error('quota'));

        await expect(tools.get('addComment').execute(
            { documentId: docId, startIndex: 1, endIndex: 5, content: 'note' }, { log },
        )).rejects.toThrow();

        expect(revisionProbes()).toHaveLength(0);
        expect(getLastReadRevisionId(docId)).toBe('rev-at-read');
    });
});

describe('readTracker.refreshRevision', () => {
    it('only replaces the revision with a non-empty string', () => {
        trackRead('f1', 't', 'c', 'rev-1');
        refreshRevision('f1', '');
        expect(getLastReadRevisionId('f1')).toBe('rev-1');
        refreshRevision('f1', undefined);
        expect(getLastReadRevisionId('f1')).toBe('rev-1');
        refreshRevision('f1', 'rev-2');
        expect(getLastReadRevisionId('f1')).toBe('rev-2');
    });

    it('does not resurrect a guard on a file that must be re-read first', () => {
        trackRead('f2', 't', 'c', 'rev-1');
        requireRereadBeforeMutation('f2', 'an Apps Script edit we could not track.');
        refreshRevision('f2', 'rev-2');
        expect(getLastReadRevisionId('f2')).toBeNull();
    });

    it('is a no-op for an untracked file', () => {
        refreshRevision('nobody-read-me', 'rev-9');
        expect(getLastReadRevisionId('nobody-read-me')).toBeNull();
    });
});
