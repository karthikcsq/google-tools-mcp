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

    // -----------------------------------------------------------------------
    // End-to-end budget guarantee (second merge-blocking review finding on
    // PR #63): capArrayByResponseBudget alone was not a guarantee. It kept a
    // single oversized item unbounded, and threads.js attached truncation
    // metadata *after* measuring against the budget, so a near-limit result
    // could be pushed over the ceiling by the metadata itself. These assert
    // the exact final JSON.stringify(...) that get_thread, list_threads, and
    // batch_get_threads actually return, not capArrayByResponseBudget in
    // isolation, including the single-oversized-item cases the review named
    // explicitly.
    // -----------------------------------------------------------------------

    it('get_thread: a single message too large to fit alone is replaced with a bounded omission stub, not shipped unbounded', async () => {
        getThread.mockResolvedValueOnce({
            data: {
                id: 'thread-oversized',
                messages: [
                    {
                        id: 'message-1',
                        payload: {
                            mimeType: 'text/plain',
                            headers: [],
                            body: { data: Buffer.from('y'.repeat(50000)).toString('base64') },
                        },
                    },
                ],
            },
        });

        const raw = await getThreadTool.execute({
            id: 'thread-oversized',
            format: 'clean',
            maxBodyChars: 0,
            maxResponseChars: 2000,
        });

        // The invariant the review asked for: the exact final string the tool
        // returns, not a sub-piece of it, must fit the configured budget.
        expect(raw.length).toBeLessThanOrEqual(2000);

        const result = JSON.parse(raw);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].id).toBe('message-1');
        expect(result.messages[0].responseOmitted).toBe(true);
        expect(result.messages[0].body).toBeUndefined();
        expect(typeof result.messages[0].omittedReason).toBe('string');
        expect(result.messages[0].omittedReason).toContain('message-1');
        expect(result.responseTruncated).toBe(true);
        expect(result.totalMessages).toBe(1);
        expect(result.includedMessages).toBe(1);
    });

    it('list_threads: a single message too large to fit alone within its thread is bounded, keeping the final payload under budget', async () => {
        listThreads.mockResolvedValueOnce({ data: { threads: [{ id: 't1' }] } });
        getThread.mockResolvedValueOnce({
            data: {
                id: 't1',
                messages: [
                    {
                        id: 'm1',
                        payload: {
                            mimeType: 'text/plain',
                            headers: [],
                            body: { data: Buffer.from('y'.repeat(50000)).toString('base64') },
                        },
                    },
                ],
            },
        });

        const raw = await listThreadsTool.execute({
            format: 'clean',
            maxBodyChars: 0,
            maxResponseChars: 1500,
        });

        expect(raw.length).toBeLessThanOrEqual(1500);

        const result = JSON.parse(raw);
        expect(result.threads).toHaveLength(1);
        expect(result.threads[0].messages[0].responseOmitted).toBe(true);
        expect(result.threads[0].messages[0].body).toBeUndefined();
        expect(result.threads[0].responseTruncated).toBe(true);
    });

    it('batch_get_threads: a single requested thread whose only message is too large to fit alone is bounded, keeping the final array under budget', async () => {
        getThread.mockResolvedValueOnce({
            data: {
                id: 'bt1',
                messages: [
                    {
                        id: 'm1',
                        payload: {
                            mimeType: 'text/plain',
                            headers: [],
                            body: { data: Buffer.from('y'.repeat(50000)).toString('base64') },
                        },
                    },
                ],
            },
        });

        const raw = await batchGetThreadsTool.execute({
            ids: ['bt1'],
            format: 'clean',
            maxBodyChars: 0,
            maxResponseChars: 1500,
        });

        expect(raw.length).toBeLessThanOrEqual(1500);

        const result = JSON.parse(raw);
        expect(result).toHaveLength(1);
        expect(result[0].messages[0].responseOmitted).toBe(true);
        expect(result[0].messages[0].body).toBeUndefined();
        // The per-thread cap already brought this single thread under budget
        // on its own, so the aggregate (whole-array) cap never needed to act;
        // batchResponseTruncated only appears when the aggregate step itself
        // has to drop or stub an entire thread, which a lone requested id
        // that already fits does not trigger.
        expect(result[0].batchResponseTruncated).toBeUndefined();
    });

    it('get_thread: reserves room for its own truncation metadata instead of letting it tip a near-limit result over the ceiling', async () => {
        // Four messages whose combined size sits just under the budget with
        // no metadata attached. Appending the truncation note afterward,
        // without reserving room for it first, would push the final payload
        // over maxResponseChars, exactly the bypass the review reported.
        const messages = Array.from({ length: 4 }, (_, i) => ({
            id: `near-message-${i + 1}`,
            payload: {
                mimeType: 'text/plain',
                headers: [],
                body: { data: Buffer.from('z'.repeat(200)).toString('base64') },
            },
        }));
        getThread.mockResolvedValueOnce({ data: { id: 'thread-near', messages } });

        const raw = await getThreadTool.execute({
            id: 'thread-near',
            format: 'clean',
            maxBodyChars: 0,
            maxResponseChars: 900,
        });

        expect(raw.length).toBeLessThanOrEqual(900);

        const result = JSON.parse(raw);
        // Reserving room for the metadata means fewer messages survive than
        // would fit if the array were capped to the full 900 with no
        // reservation (which is exactly how the prior code overshot to 1038
        // chars against this same 900-char budget).
        expect(result.includedMessages).toBeLessThan(4);
        expect(result.messages).toHaveLength(result.includedMessages);
        expect(result.responseTruncated).toBe(true);
    });

    it('get_thread: a normal under-budget response gains no truncation fields at all', async () => {
        getThread.mockResolvedValueOnce({
            data: {
                id: 'thread-small',
                messages: [
                    { id: 'small-1', payload: { mimeType: 'text/plain', headers: [], body: { data: Buffer.from('hello').toString('base64') } } },
                ],
            },
        });

        const raw = await getThreadTool.execute({
            id: 'thread-small',
            format: 'clean',
            maxResponseChars: 100000,
        });

        const result = JSON.parse(raw);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].responseOmitted).toBeUndefined();
        expect(result.responseTruncated).toBeUndefined();
        expect(result.totalMessages).toBeUndefined();
        expect(result.includedMessages).toBeUndefined();
        expect(result.truncationNote).toBeUndefined();
    });

    it('get_thread: maxResponseChars: 0 stays unbounded even for a single oversized message (no stub, no truncation)', async () => {
        getThread.mockResolvedValueOnce({
            data: {
                id: 'thread-unbounded',
                messages: [
                    {
                        id: 'message-1',
                        payload: {
                            mimeType: 'text/plain',
                            headers: [],
                            body: { data: Buffer.from('y'.repeat(50000)).toString('base64') },
                        },
                    },
                ],
            },
        });

        const raw = await getThreadTool.execute({
            id: 'thread-unbounded',
            format: 'clean',
            maxBodyChars: 0,
            maxResponseChars: 0,
        });

        const result = JSON.parse(raw);
        expect(result.messages[0].responseOmitted).toBeUndefined();
        expect(result.messages[0].body).toHaveLength(50000);
        expect(result.responseTruncated).toBeUndefined();
    });
});
