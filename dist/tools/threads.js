// Gmail Thread tools
import { z } from 'zod';
import { getGmailClient } from '../clients.js';
import { processMessagePart } from '../helpers.js';

export function register(server) {
    server.addTool({
        name: 'get_thread',
        description: 'Get a specific thread by ID',
        parameters: z.object({
            id: z.string().describe("The ID of the thread to retrieve"),
            includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.threads.get({ userId: 'me', id: params.id, format: 'full' });
            if (data.messages) {
                data.messages = data.messages.map(message => {
                    if (message.payload) {
                        message.payload = processMessagePart(message.payload, params.includeBodyHtml);
                    }
                    return message;
                });
            }
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'list_threads',
        description: 'List threads in the user\'s mailbox',
        parameters: z.object({
            maxResults: z.number().optional().describe("Maximum number of threads to return"),
            pageToken: z.string().optional().describe("Page token to retrieve a specific page of results"),
            q: z.string().optional().describe("Only return threads matching the specified query"),
            labelIds: z.array(z.string()).optional().describe("Only return threads with labels that match all specified label IDs"),
            includeSpamTrash: z.boolean().optional().describe("Include threads from SPAM and TRASH"),
            includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.threads.list({ userId: 'me', ...params });
            if (data.threads) {
                data.threads = data.threads.map(thread => {
                    if (thread.messages) {
                        thread.messages = thread.messages.map(message => {
                            if (message.payload) {
                                message.payload = processMessagePart(message.payload, params.includeBodyHtml);
                            }
                            return message;
                        });
                    }
                    return thread;
                });
            }
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'modify_thread',
        description: 'Modify the labels applied to a thread',
        parameters: z.object({
            id: z.string().describe("The ID of the thread to modify"),
            addLabelIds: z.array(z.string()).optional().describe("Label IDs to add"),
            removeLabelIds: z.array(z.string()).optional().describe("Label IDs to remove"),
        }),
        execute: async (params) => {
            const { id, ...threadData } = params;
            const gmail = await getGmailClient();
            const { data } = await gmail.users.threads.modify({ userId: 'me', id, requestBody: threadData });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'delete_thread',
        description: 'Delete a thread',
        parameters: z.object({
            id: z.string().describe("The ID of the thread to delete"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.threads.delete({ userId: 'me', id: params.id });
            return JSON.stringify(data || { success: true });
        },
    });

    server.addTool({
        name: 'trash_thread',
        description: 'Move a thread to the trash',
        parameters: z.object({
            id: z.string().describe("The ID of the thread to move to trash"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.threads.trash({ userId: 'me', id: params.id });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'untrash_thread',
        description: 'Remove a thread from the trash',
        parameters: z.object({
            id: z.string().describe("The ID of the thread to remove from trash"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.threads.untrash({ userId: 'me', id: params.id });
            return JSON.stringify(data);
        },
    });
}
