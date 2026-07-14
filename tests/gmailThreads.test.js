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
});
