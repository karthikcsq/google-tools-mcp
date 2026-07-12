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

    it('filters get_thread output to requested messageIds', async () => {
        getThread.mockResolvedValueOnce({
            data: {
                id: 'thread-1',
                messages: [
                    { id: 'message-1', payload: { headers: [] } },
                    { id: 'message-2', payload: { headers: [] } },
                    { id: 'message-3', payload: { headers: [] } },
                ],
            },
        });

        const result = JSON.parse(await getThreadTool.execute({
            id: 'thread-1',
            format: 'metadata',
            messageIds: ['message-2'],
        }));

        expect(result.messages.map(message => message.id)).toEqual(['message-2']);
    });
});
