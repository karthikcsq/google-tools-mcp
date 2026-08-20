import { describe, it, expect, jest, beforeAll, beforeEach } from '@jest/globals';

// Shared Drive client mock surface. Every comment tool must route through
// getDriveClient() — the "whole-directory regression" test below asserts
// this is the *only* Drive surface any tool touches.
const commentsList = jest.fn();
const commentsGet = jest.fn();
const commentsCreate = jest.fn();
const commentsUpdate = jest.fn();
const commentsDelete = jest.fn();
const repliesCreate = jest.fn();
const documentsGet = jest.fn();

const driveClient = {
    comments: {
        list: commentsList,
        get: commentsGet,
        create: commentsCreate,
        update: commentsUpdate,
        delete: commentsDelete,
    },
    replies: {
        create: repliesCreate,
    },
};

let getDriveClientCallCount = 0;

jest.unstable_mockModule('../dist/clients.js', () => ({
    getDriveClient: async () => {
        getDriveClientCallCount += 1;
        return driveClient;
    },
    getDocsClient: async () => ({ documents: { get: documentsGet } }),
    getAuthClient: async () => {
        throw new Error('getAuthClient must not be called by comment tools — they must use getDriveClient()');
    },
}));

describe('Docs comment tools (#86)', () => {
    let tools;

    beforeAll(async () => {
        tools = new Map();
        const { registerCommentTools } = await import('../dist/tools/docs/comments/index.js');
        registerCommentTools({ addTool: (tool) => tools.set(tool.name, tool) });
    });

    beforeEach(() => {
        jest.clearAllMocks();
        getDriveClientCallCount = 0;
    });

    const docId = 'doc-123';

    // -------------------------------------------------------------------
    // resolve -> verify
    // -------------------------------------------------------------------
    describe('resolveComment', () => {
        it('resolves via replies.create with action: resolve, verifies, and never calls comments.update', async () => {
            repliesCreate.mockResolvedValueOnce({ data: { id: 'reply-1', action: 'resolve' } });
            commentsGet.mockResolvedValueOnce({ data: { resolved: true } });

            const result = await tools.get('resolveComment').execute(
                { documentId: docId, commentId: 'c1' },
                { log: { info: () => {}, error: () => {} } },
            );

            expect(repliesCreate).toHaveBeenCalledWith(expect.objectContaining({
                fileId: docId,
                commentId: 'c1',
                requestBody: expect.objectContaining({ action: 'resolve' }),
            }));
            expect(commentsGet).toHaveBeenCalledWith(expect.objectContaining({
                fileId: docId,
                commentId: 'c1',
                fields: 'resolved',
            }));
            expect(commentsUpdate).not.toHaveBeenCalled();
            expect(result).toContain('has been marked as resolved');
        });

        it('passes an optional note through as the resolve reply content', async () => {
            repliesCreate.mockResolvedValueOnce({ data: { id: 'reply-2', action: 'resolve' } });
            commentsGet.mockResolvedValueOnce({ data: { resolved: true } });

            await tools.get('resolveComment').execute(
                { documentId: docId, commentId: 'c1', note: 'Addressed in latest revision.' },
                { log: { info: () => {}, error: () => {} } },
            );

            expect(repliesCreate).toHaveBeenCalledWith(expect.objectContaining({
                requestBody: expect.objectContaining({ content: 'Addressed in latest revision.' }),
            }));
        });

        it('throws a hard failure (not a soft apology) when verification shows the comment is still unresolved', async () => {
            repliesCreate.mockResolvedValueOnce({ data: { id: 'reply-3', action: 'resolve' } });
            commentsGet.mockResolvedValueOnce({ data: { resolved: false } });

            await expect(tools.get('resolveComment').execute(
                { documentId: docId, commentId: 'c1' },
                { log: { info: () => {}, error: () => {} } },
            )).rejects.toThrow(/did not persist/i);

            expect(commentsUpdate).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------
    // reply -> list (accurate reply metadata)
    // -------------------------------------------------------------------
    describe('listComments: reply metadata', () => {
        it('reports accurate replyCount and reply metadata for a commented thread', async () => {
            commentsList.mockResolvedValueOnce({
                data: {
                    comments: [
                        {
                            id: 'c1',
                            content: 'Please clarify this paragraph.',
                            quotedFileContent: { value: 'the quoted text' },
                            author: { displayName: 'Alice', me: false },
                            createdTime: '2026-08-01T00:00:00Z',
                            modifiedTime: '2026-08-02T00:00:00Z',
                            resolved: false,
                            replies: [
                                { id: 'r1', content: 'Sure, here is why.', action: null, author: { displayName: 'Bob', me: true }, createdTime: '2026-08-01T01:00:00Z' },
                                { id: 'r2', content: 'Thanks, makes sense.', action: null, author: { displayName: 'Alice', me: false }, createdTime: '2026-08-01T02:00:00Z' },
                            ],
                        },
                    ],
                },
            });

            const raw = await tools.get('listComments').execute(
                { documentId: docId, maxResults: 50, includeDeleted: false, includeQuotedText: true, unansweredOnly: false },
                { log: { info: () => {}, error: () => {} } },
            );
            const result = JSON.parse(raw);

            expect(result.comments).toHaveLength(1);
            expect(result.comments[0].replyCount).toBe(2);
            expect(result.comments[0].modifiedTime).toBe('2026-08-02T00:00:00Z');
            expect(result.comments[0].replies).toEqual([
                { id: 'r1', author: 'Bob', authorIsMe: true, content: 'Sure, here is why.', action: null, createdTime: '2026-08-01T01:00:00Z' },
                { id: 'r2', author: 'Alice', authorIsMe: false, content: 'Thanks, makes sense.', action: null, createdTime: '2026-08-01T02:00:00Z' },
            ]);
        });

        it('requests replies and modifiedTime in the field mask', async () => {
            commentsList.mockResolvedValueOnce({ data: { comments: [] } });

            await tools.get('listComments').execute(
                { documentId: docId, maxResults: 50, includeDeleted: false, includeQuotedText: true, unansweredOnly: false },
                { log: { info: () => {}, error: () => {} } },
            );

            const fields = commentsList.mock.calls[0][0].fields;
            expect(fields).toContain('replies(');
            expect(fields).toContain('modifiedTime');
            expect(fields).toContain('author(displayName,me)');
        });
    });

    // -------------------------------------------------------------------
    // incremental & pagination, end to end
    // -------------------------------------------------------------------
    describe('listComments: incremental filtering and pagination', () => {
        it('forwards updatedAfter as startModifiedTime, and includeDeleted/maxResults visibly alter the request', async () => {
            commentsList.mockResolvedValueOnce({ data: { comments: [] } });

            await tools.get('listComments').execute(
                {
                    documentId: docId,
                    maxResults: 10,
                    includeDeleted: true,
                    includeQuotedText: true,
                    unansweredOnly: false,
                    updatedAfter: '2026-08-01T00:00:00.000Z',
                },
                { log: { info: () => {}, error: () => {} } },
            );

            expect(commentsList).toHaveBeenCalledWith(expect.objectContaining({
                fileId: docId,
                pageSize: 10,
                includeDeleted: true,
                startModifiedTime: '2026-08-01T00:00:00.000Z',
            }));
        });

        it('does not send startModifiedTime when updatedAfter is omitted', async () => {
            commentsList.mockResolvedValueOnce({ data: { comments: [] } });

            await tools.get('listComments').execute(
                { documentId: docId, maxResults: 50, includeDeleted: false, includeQuotedText: true, unansweredOnly: false },
                { log: { info: () => {}, error: () => {} } },
            );

            expect(commentsList.mock.calls[0][0]).not.toHaveProperty('startModifiedTime');
        });

        it('walks a two-page result set: first call returns nextPageToken, second call with that pageToken returns page two', async () => {
            commentsList.mockResolvedValueOnce({
                data: {
                    nextPageToken: 'page-2-token',
                    comments: [{ id: 'c1', content: 'first page comment', author: {}, resolved: false, replies: [] }],
                },
            });
            commentsList.mockResolvedValueOnce({
                data: {
                    comments: [{ id: 'c2', content: 'second page comment', author: {}, resolved: false, replies: [] }],
                },
            });

            const firstRaw = await tools.get('listComments').execute(
                { documentId: docId, maxResults: 50, includeDeleted: false, includeQuotedText: true, unansweredOnly: false },
                { log: { info: () => {}, error: () => {} } },
            );
            const firstPage = JSON.parse(firstRaw);
            expect(firstPage.comments.map((c) => c.id)).toEqual(['c1']);
            expect(firstPage.nextPageToken).toBe('page-2-token');

            const secondRaw = await tools.get('listComments').execute(
                { documentId: docId, maxResults: 50, includeDeleted: false, includeQuotedText: true, unansweredOnly: false, pageToken: firstPage.nextPageToken },
                { log: { info: () => {}, error: () => {} } },
            );
            const secondPage = JSON.parse(secondRaw);
            expect(secondPage.comments.map((c) => c.id)).toEqual(['c2']);
            expect(secondPage.nextPageToken).toBeUndefined();
            expect(commentsList.mock.calls[1][0].pageToken).toBe('page-2-token');
        });

        // Fix 4(a): the maxResults schema default must be 100 (the old
        // hard-coded pageSize before maxResults/pageToken existed), not 50 —
        // 50 silently halved the effective default page size. The mock
        // server harness in this suite stores the raw tool (bypassing the
        // real server's schema-application layer, same as every other test
        // here), so the default is asserted against the schema directly,
        // exactly what the real server runs before execute() ever sees args.
        it('schema default for maxResults is 100, not 50', () => {
            const parsed = tools.get('listComments').parameters.parse({ documentId: docId });
            expect(parsed.maxResults).toBe(100);
        });

        it('sends pageSize 100 to the Drive API when maxResults is omitted (via schema default)', async () => {
            commentsList.mockResolvedValueOnce({ data: { comments: [] } });
            const parsed = tools.get('listComments').parameters.parse({ documentId: docId });

            await tools.get('listComments').execute(
                parsed,
                { log: { info: () => {}, error: () => {} } },
            );

            expect(commentsList.mock.calls[0][0].pageSize).toBe(100);
        });
    });

    // -------------------------------------------------------------------
    // update-in-place
    // -------------------------------------------------------------------
    describe('updateComment', () => {
        it('sends only { content } in requestBody and surfaces modifiedTime', async () => {
            commentsUpdate.mockResolvedValueOnce({ data: { id: 'c1', content: 'edited text', modifiedTime: '2026-08-05T00:00:00Z' } });

            const result = await tools.get('updateComment').execute(
                { documentId: docId, commentId: 'c1', content: 'edited text' },
                { log: { info: () => {}, error: () => {} } },
            );

            expect(commentsUpdate).toHaveBeenCalledWith({
                fileId: docId,
                commentId: 'c1',
                fields: 'id,content,modifiedTime',
                requestBody: { content: 'edited text' },
            });
            expect(result).toContain('2026-08-05T00:00:00Z');
        });

        it('does not touch resolved status', async () => {
            commentsUpdate.mockResolvedValueOnce({ data: { id: 'c1', content: 'x', modifiedTime: 't' } });

            await tools.get('updateComment').execute(
                { documentId: docId, commentId: 'c1', content: 'x' },
                { log: { info: () => {}, error: () => {} } },
            );

            const body = commentsUpdate.mock.calls[0][0].requestBody;
            expect(body).not.toHaveProperty('resolved');
        });
    });

    // -------------------------------------------------------------------
    // filters: unansweredOnly + truncation
    // -------------------------------------------------------------------
    describe('listComments: unansweredOnly filter and content truncation', () => {
        const baseComments = () => [
            {
                id: 'unanswered-no-replies',
                content: 'No one has replied yet.',
                author: { displayName: 'Alice', me: false },
                resolved: false,
                replies: [],
            },
            {
                id: 'unanswered-last-reply-other',
                content: 'Still open, last reply from someone else.',
                author: { displayName: 'Alice', me: false },
                resolved: false,
                replies: [
                    { id: 'r1', content: 'ack', author: { displayName: 'Alice', me: false }, createdTime: 't1' },
                ],
            },
            {
                id: 'answered-last-reply-me',
                content: 'I already answered this.',
                author: { displayName: 'Alice', me: false },
                resolved: false,
                replies: [
                    { id: 'r2', content: 'done', author: { displayName: 'Me', me: true }, createdTime: 't2' },
                ],
            },
            {
                id: 'resolved-comment',
                content: 'Resolved thread.',
                author: { displayName: 'Alice', me: false },
                resolved: true,
                replies: [],
            },
        ];

        it('unansweredOnly keeps unresolved/no-or-other-last-reply comments and drops resolved and self-answered ones', async () => {
            commentsList.mockResolvedValueOnce({ data: { comments: baseComments() } });

            const raw = await tools.get('listComments').execute(
                { documentId: docId, maxResults: 50, includeDeleted: false, includeQuotedText: true, unansweredOnly: true },
                { log: { info: () => {}, error: () => {} } },
            );
            const result = JSON.parse(raw);

            expect(result.comments.map((c) => c.id).sort()).toEqual([
                'unanswered-last-reply-other',
                'unanswered-no-replies',
            ].sort());
        });

        it('leaves all comments when unansweredOnly is false', async () => {
            commentsList.mockResolvedValueOnce({ data: { comments: baseComments() } });

            const raw = await tools.get('listComments').execute(
                { documentId: docId, maxResults: 50, includeDeleted: false, includeQuotedText: true, unansweredOnly: false },
                { log: { info: () => {}, error: () => {} } },
            );
            const result = JSON.parse(raw);

            expect(result.comments).toHaveLength(4);
        });

        // Fix 4(b): count is post-filter, nextPageToken is pre-filter. A page
        // that unansweredOnly filters down to zero comments must still say
        // more pages exist via an explicit `note`, or count:0 + a token reads
        // as "nothing left", which is wrong.
        it('adds a note when unansweredOnly filters a non-empty page down to zero, with a nextPageToken', async () => {
            const allAnswered = [
                {
                    id: 'answered-1',
                    content: 'done',
                    author: { displayName: 'Alice', me: false },
                    resolved: false,
                    replies: [{ id: 'r1', content: 'ack', author: { displayName: 'Me', me: true }, createdTime: 't1' }],
                },
                {
                    id: 'resolved-1',
                    content: 'resolved',
                    author: { displayName: 'Alice', me: false },
                    resolved: true,
                    replies: [],
                },
            ];
            commentsList.mockResolvedValueOnce({ data: { nextPageToken: 'page-2', comments: allAnswered } });

            const raw = await tools.get('listComments').execute(
                { documentId: docId, maxResults: 50, includeDeleted: false, includeQuotedText: true, unansweredOnly: true },
                { log: { info: () => {}, error: () => {} } },
            );
            const result = JSON.parse(raw);

            expect(result.comments).toHaveLength(0);
            expect(result.count).toBe(0);
            expect(result.nextPageToken).toBe('page-2');
            expect(result.note).toBeTruthy();
            expect(result.note).toMatch(/filtered out/i);
            expect(result.note).toMatch(/nextPageToken/);
        });

        it('adds no note when unansweredOnly filters nothing out', async () => {
            commentsList.mockResolvedValueOnce({ data: { comments: baseComments() } });

            const raw = await tools.get('listComments').execute(
                { documentId: docId, maxResults: 50, includeDeleted: false, includeQuotedText: true, unansweredOnly: false },
                { log: { info: () => {}, error: () => {} } },
            );
            const result = JSON.parse(raw);

            expect(result.note).toBeUndefined();
        });

        it('adds no note when the fetched page was already empty', async () => {
            commentsList.mockResolvedValueOnce({ data: { comments: [] } });

            const raw = await tools.get('listComments').execute(
                { documentId: docId, maxResults: 50, includeDeleted: false, includeQuotedText: true, unansweredOnly: true },
                { log: { info: () => {}, error: () => {} } },
            );
            const result = JSON.parse(raw);

            expect(result.note).toBeUndefined();
        });

        it('truncates comment content, reply content, and quoted text at the 2,000-char cap with a marker', async () => {
            const longText = 'x'.repeat(2500);
            commentsList.mockResolvedValueOnce({
                data: {
                    comments: [
                        {
                            id: 'c-long',
                            content: longText,
                            quotedFileContent: { value: longText },
                            author: { displayName: 'Alice', me: false },
                            resolved: false,
                            replies: [
                                { id: 'r-long', content: longText, author: { displayName: 'Bob', me: false }, createdTime: 't' },
                            ],
                        },
                    ],
                },
            });

            const raw = await tools.get('listComments').execute(
                { documentId: docId, maxResults: 50, includeDeleted: false, includeQuotedText: true, unansweredOnly: false },
                { log: { info: () => {}, error: () => {} } },
            );
            const result = JSON.parse(raw);
            const comment = result.comments[0];

            expect(comment.content.length).toBe(2000 + '…[truncated]'.length);
            expect(comment.content.endsWith('…[truncated]')).toBe(true);
            expect(comment.quotedText.endsWith('…[truncated]')).toBe(true);
            expect(comment.replies[0].content.endsWith('…[truncated]')).toBe(true);
        });

        it('omits quotedText entirely when includeQuotedText is false', async () => {
            commentsList.mockResolvedValueOnce({
                data: {
                    comments: [
                        {
                            id: 'c1',
                            content: 'short',
                            quotedFileContent: { value: 'quoted' },
                            author: { displayName: 'Alice', me: false },
                            resolved: false,
                            replies: [],
                        },
                    ],
                },
            });

            const raw = await tools.get('listComments').execute(
                { documentId: docId, maxResults: 50, includeDeleted: false, includeQuotedText: false, unansweredOnly: false },
                { log: { info: () => {}, error: () => {} } },
            );
            const result = JSON.parse(raw);

            expect(result.comments[0]).not.toHaveProperty('quotedText');
        });
    });

    // -------------------------------------------------------------------
    // whole-directory regression: every tool registered and every tool
    // exclusively uses the shared getDriveClient() mock.
    // -------------------------------------------------------------------
    describe('whole-directory regression', () => {
        it('registers all seven comment tools', () => {
            expect([...tools.keys()].sort()).toEqual([
                'addComment',
                'deleteComment',
                'getComment',
                'listComments',
                'replyToComment',
                'resolveComment',
                'updateComment',
            ].sort());
        });

        it('addComment uses the shared getDriveClient() mock, not a private client', async () => {
            documentsGet.mockResolvedValueOnce({ data: { body: { content: [] } } });
            commentsCreate.mockResolvedValueOnce({ data: { id: 'new-comment' } });

            await tools.get('addComment').execute(
                { documentId: docId, startIndex: 1, endIndex: 5, content: 'note' },
                { log: { info: () => {}, error: () => {} } },
            );

            expect(commentsCreate).toHaveBeenCalledTimes(1);
            expect(getDriveClientCallCount).toBeGreaterThan(0);
        });

        it('getComment uses the shared getDriveClient() mock', async () => {
            commentsGet.mockResolvedValueOnce({ data: { id: 'c1', author: {}, resolved: false, replies: [] } });

            await tools.get('getComment').execute(
                { documentId: docId, commentId: 'c1' },
                { log: { info: () => {}, error: () => {} } },
            );

            expect(commentsGet).toHaveBeenCalledTimes(1);
        });

        it('replyToComment uses the shared getDriveClient() mock', async () => {
            repliesCreate.mockResolvedValueOnce({ data: { id: 'r1' } });

            await tools.get('replyToComment').execute(
                { documentId: docId, commentId: 'c1', content: 'reply text' },
                { log: { info: () => {}, error: () => {} } },
            );

            expect(repliesCreate).toHaveBeenCalledTimes(1);
        });

        it('deleteComment uses the shared getDriveClient() mock', async () => {
            commentsDelete.mockResolvedValueOnce({});

            await tools.get('deleteComment').execute(
                { documentId: docId, commentId: 'c1' },
                { log: { info: () => {}, error: () => {} } },
            );

            expect(commentsDelete).toHaveBeenCalledTimes(1);
        });

        // getAuthClient is wired to throw in this suite's mock, so any tool
        // that still constructed a private google.drive(...) client via
        // getAuthClient() would fail its own test here.
        it('no comment tool touches getAuthClient()', async () => {
            commentsList.mockResolvedValueOnce({ data: { comments: [] } });
            commentsGet.mockResolvedValueOnce({ data: { id: 'c1', author: {}, resolved: false, replies: [] } });
            repliesCreate.mockResolvedValue({ data: { id: 'r1', action: 'resolve' } });
            commentsGet.mockResolvedValueOnce({ data: { resolved: true } });
            commentsUpdate.mockResolvedValueOnce({ data: { id: 'c1', content: 'x', modifiedTime: 't' } });
            commentsDelete.mockResolvedValueOnce({});
            documentsGet.mockResolvedValueOnce({ data: { body: { content: [] } } });
            commentsCreate.mockResolvedValueOnce({ data: { id: 'new' } });

            const log = { info: () => {}, error: () => {} };
            await tools.get('listComments').execute({ documentId: docId, maxResults: 50, includeDeleted: false, includeQuotedText: true, unansweredOnly: false }, { log });
            await tools.get('getComment').execute({ documentId: docId, commentId: 'c1' }, { log });
            await tools.get('resolveComment').execute({ documentId: docId, commentId: 'c1' }, { log });
            await tools.get('updateComment').execute({ documentId: docId, commentId: 'c1', content: 'x' }, { log });
            await tools.get('deleteComment').execute({ documentId: docId, commentId: 'c1' }, { log });
            await tools.get('addComment').execute({ documentId: docId, startIndex: 1, endIndex: 5, content: 'note' }, { log });
            await tools.get('replyToComment').execute({ documentId: docId, commentId: 'c1', content: 'reply' }, { log });

            // If any tool had called getAuthClient(), it would have thrown
            // synchronously inside its try/catch and surfaced as a
            // wrapped/public error instead of the mocked success path above
            // — the fact that every call above resolved proves none did.
            expect(getDriveClientCallCount).toBeGreaterThanOrEqual(7);
        });
    });

    // -------------------------------------------------------------------
    // Error tiers
    // -------------------------------------------------------------------
    describe('error boundary', () => {
        it('resolveComment wraps an unstructured Drive failure as an OperationError, not a raw error.message leak', async () => {
            repliesCreate.mockRejectedValueOnce(new Error('ECONNRESET some internal detail'));

            let thrown;
            try {
                await tools.get('resolveComment').execute(
                    { documentId: docId, commentId: 'c1' },
                    { log: { info: () => {}, error: () => {} } },
                );
            } catch (err) {
                thrown = err;
            }

            expect(thrown).toBeDefined();
            expect(thrown.message).not.toContain('ECONNRESET');
            expect(thrown.message).not.toContain('some internal detail');
        });

        it('resolveComment surfaces the Drive API structured error description', async () => {
            const apiError = new Error('generic');
            apiError.response = { data: { error: { message: 'Comment not found.', code: 404 } } };
            repliesCreate.mockRejectedValueOnce(apiError);

            await expect(tools.get('resolveComment').execute(
                { documentId: docId, commentId: 'missing' },
                { log: { info: () => {}, error: () => {} } },
            )).rejects.toThrow(/Comment not found/);
        });

        it('listComments wraps an unstructured Drive failure without leaking raw error.message', async () => {
            commentsList.mockRejectedValueOnce(new Error('raw internal stack trace text'));

            let thrown;
            try {
                await tools.get('listComments').execute(
                    { documentId: docId, maxResults: 50, includeDeleted: false, includeQuotedText: true, unansweredOnly: false },
                    { log: { info: () => {}, error: () => {} } },
                );
            } catch (err) {
                thrown = err;
            }

            expect(thrown).toBeDefined();
            expect(thrown.message).not.toContain('raw internal stack trace text');
        });

        it('updateComment wraps an unstructured Drive failure without leaking raw error.message', async () => {
            commentsUpdate.mockRejectedValueOnce(new Error('raw internal stack trace text'));

            let thrown;
            try {
                await tools.get('updateComment').execute(
                    { documentId: docId, commentId: 'c1', content: 'x' },
                    { log: { info: () => {}, error: () => {} } },
                );
            } catch (err) {
                thrown = err;
            }

            expect(thrown).toBeDefined();
            expect(thrown.message).not.toContain('raw internal stack trace text');
        });
    });
});
