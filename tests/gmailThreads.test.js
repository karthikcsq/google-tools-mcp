import { describe, it, expect, jest, beforeAll } from '@jest/globals';

const getThread = jest.fn();

jest.unstable_mockModule('../dist/clients.js', () => ({
    getGmailClient: async () => ({
        users: { threads: { get: getThread } },
    }),
}));

describe('Gmail thread output controls', () => {
    let getThreadTool;

    beforeAll(async () => {
        const tools = new Map();
        const { register } = await import('../dist/tools/gmail/threads.js');
        register({ addTool: tool => tools.set(tool.name, tool) });
        getThreadTool = tools.get('get_thread');
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
});
