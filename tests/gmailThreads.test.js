import { describe, it, expect, jest, beforeAll } from '@jest/globals';

const getThread = jest.fn();
const listThreads = jest.fn();

jest.unstable_mockModule('../dist/clients.js', () => ({
    getGmailClient: async () => ({
        users: { threads: { get: getThread, list: listThreads } },
    }),
}));

describe('Gmail thread output controls', () => {
    let getThreadTool;
    let listThreadsTool;
    let batchGetThreadsTool;

    beforeAll(async () => {
        const tools = new Map();
        const { register } = await import('../dist/tools/gmail/threads.js');
        register({ addTool: tool => tools.set(tool.name, tool) });
        getThreadTool = tools.get('get_thread');
        listThreadsTool = tools.get('list_threads');
        batchGetThreadsTool = tools.get('batch_get_threads');
    });

    const threeMessageThread = () => ({
        data: {
            id: 'thread-1',
            messages: [
                { id: 'message-1', payload: { headers: [] } },
                { id: 'message-2', payload: { headers: [] } },
                { id: 'message-3', payload: { headers: [] } },
            ],
        },
    });

    it('filters get_thread output to requested messageIds', async () => {
        getThread.mockResolvedValueOnce(threeMessageThread());

        const result = JSON.parse(await getThreadTool.execute({
            id: 'thread-1',
            format: 'metadata',
            messageIds: ['message-2'],
        }));

        expect(result.messages.map(message => message.id)).toEqual(['message-2']);
    });

    it('treats an empty messageIds array as no filter', async () => {
        getThread.mockResolvedValueOnce(threeMessageThread());

        const result = JSON.parse(await getThreadTool.execute({
            id: 'thread-1',
            format: 'metadata',
            messageIds: [],
        }));

        expect(result.messages.map(message => message.id)).toEqual([
            'message-1',
            'message-2',
            'message-3',
        ]);
    });

    it('keeps only the latest N messages with maxMessages', async () => {
        getThread.mockResolvedValueOnce(threeMessageThread());

        const result = JSON.parse(await getThreadTool.execute({
            id: 'thread-1',
            format: 'metadata',
            maxMessages: 2,
        }));

        expect(result.messages.map(message => message.id)).toEqual([
            'message-2',
            'message-3',
        ]);
    });

    it('returns all messages when maxMessages exceeds the thread size', async () => {
        getThread.mockResolvedValueOnce(threeMessageThread());

        const result = JSON.parse(await getThreadTool.execute({
            id: 'thread-1',
            format: 'metadata',
            maxMessages: 50,
        }));

        expect(result.messages.map(message => message.id)).toEqual([
            'message-1',
            'message-2',
            'message-3',
        ]);
    });

    it('keeps the single message of a one-message thread with maxMessages: 1', async () => {
        getThread.mockResolvedValueOnce({
            data: { id: 'thread-solo', messages: [{ id: 'only-message', payload: { headers: [] } }] },
        });

        const result = JSON.parse(await getThreadTool.execute({
            id: 'thread-solo',
            format: 'metadata',
            maxMessages: 1,
        }));

        expect(result.messages.map(message => message.id)).toEqual(['only-message']);
    });

    it('does not throw on an empty-messages thread with maxMessages set', async () => {
        getThread.mockResolvedValueOnce({ data: { id: 'thread-empty', messages: [] } });

        const result = JSON.parse(await getThreadTool.execute({
            id: 'thread-empty',
            format: 'metadata',
            maxMessages: 5,
        }));

        expect(result.messages).toEqual([]);
    });

    it('applies maxMessages per thread in list_threads', async () => {
        listThreads.mockResolvedValueOnce({ data: { threads: [{ id: 'thread-1' }] } });
        getThread.mockResolvedValueOnce(threeMessageThread());

        const result = JSON.parse(await listThreadsTool.execute({
            format: 'metadata',
            maxMessages: 1,
        }));

        expect(result.threads[0].messages.map(m => m.id)).toEqual(['message-3']);
    });

    it('applies maxMessages per thread in batch_get_threads', async () => {
        getThread.mockResolvedValueOnce(threeMessageThread());

        const result = JSON.parse(await batchGetThreadsTool.execute({
            ids: ['thread-1'],
            format: 'metadata',
            maxMessages: 2,
        }));

        expect(result[0].messages.map(m => m.id)).toEqual(['message-2', 'message-3']);
    });

    // -----------------------------------------------------------------------
    // maxResponseChars: whole-response budget (merge-blocking review finding
    // on PR #63 — maxBodyChars only caps each message/part independently, so
    // a default get_thread on a large thread, or list_threads/batch_get_threads
    // across many threads, had no ceiling on total serialized size.
    // -----------------------------------------------------------------------
    const threadWithMessages = (threadId, count, bodyLength) => ({
        data: {
            id: threadId,
            messages: Array.from({ length: count }, (_, idx) => ({
                id: `${threadId}-message-${idx + 1}`,
                payload: {
                    mimeType: 'text/plain',
                    headers: [],
                    body: { data: Buffer.from('x'.repeat(bodyLength)).toString('base64') },
                },
            })),
        },
    });

    it('get_thread: bounds aggregate response size with maxResponseChars, keeping the latest messages', async () => {
        getThread.mockResolvedValueOnce(threadWithMessages('thread-budget', 5, 2000));

        const result = JSON.parse(await getThreadTool.execute({
            id: 'thread-budget',
            format: 'clean',
            maxBodyChars: 0,
            maxResponseChars: 6000,
        }));

        // Many individually-under-cap messages (each 2000 chars, well under any
        // per-message cap) still sum to ~10000+ chars — the aggregate must be
        // bounded even though no single message triggered a per-item cap.
        expect(result.messages.length).toBeLessThan(5);
        expect(result.responseTruncated).toBe(true);
        expect(result.totalMessages).toBe(5);
        expect(result.includedMessages).toBe(result.messages.length);
        expect(typeof result.truncationNote).toBe('string');
        expect(JSON.stringify(result.messages).length).toBeLessThanOrEqual(6000);
        // Keeps the latest messages (highest-numbered ids), dropping the oldest.
        expect(result.messages[result.messages.length - 1].id).toBe('thread-budget-message-5');
        expect(result.messages[0].id).not.toBe('thread-budget-message-1');
    });

    it('get_thread: maxResponseChars: 0 disables the whole-response budget', async () => {
        getThread.mockResolvedValueOnce(threadWithMessages('thread-nolimit', 5, 2000));

        const result = JSON.parse(await getThreadTool.execute({
            id: 'thread-nolimit',
            format: 'clean',
            maxBodyChars: 0,
            maxResponseChars: 0,
        }));

        expect(result.messages.length).toBe(5);
        expect(result.responseTruncated).toBeUndefined();
    });

    it('list_threads: bounds the aggregate response across multiple threads, dropping lowest-priority threads', async () => {
        listThreads.mockResolvedValueOnce({
            data: { threads: [{ id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 't4' }, { id: 't5' }] },
        });
        getThread
            .mockResolvedValueOnce(threadWithMessages('t1', 2, 1500))
            .mockResolvedValueOnce(threadWithMessages('t2', 2, 1500))
            .mockResolvedValueOnce(threadWithMessages('t3', 2, 1500))
            .mockResolvedValueOnce(threadWithMessages('t4', 2, 1500))
            .mockResolvedValueOnce(threadWithMessages('t5', 2, 1500));

        const result = JSON.parse(await listThreadsTool.execute({
            format: 'clean',
            maxBodyChars: 0,
            maxResponseChars: 6000,
        }));

        // Each individual thread (~3000 chars) is under the 6000 cap on its own,
        // but 5 of them combined (~16000 chars) is not — this must be caught at
        // the collection level, not just per-thread.
        expect(result.threads.length).toBeLessThan(5);
        expect(result.responseTruncated).toBe(true);
        expect(result.totalThreads).toBe(5);
        expect(result.includedThreads).toBe(result.threads.length);
        expect(typeof result.truncationNote).toBe('string');
        expect(JSON.stringify(result.threads).length).toBeLessThanOrEqual(6000);
    });

    it('batch_get_threads: bounds the aggregate response across requested ids, flagging truncation on the last thread returned', async () => {
        getThread
            .mockResolvedValueOnce(threadWithMessages('b1', 2, 1500))
            .mockResolvedValueOnce(threadWithMessages('b2', 2, 1500))
            .mockResolvedValueOnce(threadWithMessages('b3', 2, 1500))
            .mockResolvedValueOnce(threadWithMessages('b4', 2, 1500))
            .mockResolvedValueOnce(threadWithMessages('b5', 2, 1500));

        const result = JSON.parse(await batchGetThreadsTool.execute({
            ids: ['b1', 'b2', 'b3', 'b4', 'b5'],
            format: 'clean',
            maxBodyChars: 0,
            maxResponseChars: 6000,
        }));

        expect(result.length).toBeLessThan(5);
        const last = result[result.length - 1];
        expect(last.batchResponseTruncated).toBe(true);
        expect(last.totalThreadsRequested).toBe(5);
        expect(last.includedThreads).toBe(result.length);
        expect(typeof last.truncationNote).toBe('string');
    });

    it('batch_get_threads: maxResponseChars: 0 disables the whole-response budget', async () => {
        getThread
            .mockResolvedValueOnce(threadWithMessages('c1', 2, 1500))
            .mockResolvedValueOnce(threadWithMessages('c2', 2, 1500))
            .mockResolvedValueOnce(threadWithMessages('c3', 2, 1500));

        const result = JSON.parse(await batchGetThreadsTool.execute({
            ids: ['c1', 'c2', 'c3'],
            format: 'clean',
            maxBodyChars: 0,
            maxResponseChars: 0,
        }));

        expect(result.length).toBe(3);
        expect(result[2].batchResponseTruncated).toBeUndefined();
    });
});
