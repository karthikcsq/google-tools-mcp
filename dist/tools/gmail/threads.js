// Gmail Thread tools
import { z } from 'zod';
import { getGmailClient } from '../../clients.js';
import { processMessagePart, formatMessageClean, formatMessageMetadata } from '../../helpers.js';

export function register(server) {
    server.addTool({
        name: 'get_thread',
        description: 'Get a specific thread by ID. format="clean" (default) returns each message as from/to/subject/date/body. format="metadata" returns headers only. format="full" returns raw MIME trees.',
        parameters: z.object({
            id: z.string().describe("The ID of the thread to retrieve"),
            format: z.enum(['full', 'clean', 'metadata']).optional().default('clean').describe("Response format for each message: clean (default), metadata (headers only), or full (raw MIME tree)"),
            maxBodyChars: z.number().optional().default(3000).describe("Max body characters per message in clean mode. 0 = unlimited."),
            includeBodyHtml: z.boolean().optional().describe("In full mode only: whether to include parsed HTML body parts"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.threads.get({ userId: 'me', id: params.id, format: 'full' });
            if (data.messages) {
                data.messages = data.messages.map(message => {
                    if (params.format === 'clean') return formatMessageClean(message, params.maxBodyChars);
                    if (params.format === 'metadata') return formatMessageMetadata(message);
                    if (message.payload) message.payload = processMessagePart(message.payload, params.includeBodyHtml);
                    return message;
                });
            }
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'list_threads',
        description: 'List threads in the user\'s mailbox. format="metadata" (default) auto-fetches thread details with headers only. format="clean" includes message bodies. format="full" returns raw MIME data. Omit format to get bare thread stubs (id/snippet only).',
        parameters: z.object({
            maxResults: z.number().optional().describe("Maximum number of threads to return"),
            pageToken: z.string().optional().describe("Page token to retrieve a specific page of results"),
            q: z.string().optional().describe("Only return threads matching the specified query"),
            labelIds: z.array(z.string()).optional().describe("Only return threads with labels that match all specified label IDs"),
            includeSpamTrash: z.boolean().optional().describe("Include threads from SPAM and TRASH"),
            format: z.enum(['full', 'clean', 'metadata']).optional().describe("When set, auto-fetches full thread details. metadata=headers only (default when set), clean=with bodies, full=raw MIME tree."),
            maxBodyChars: z.number().optional().default(3000).describe("Max body characters per message in clean mode. 0 = unlimited."),
            includeBodyHtml: z.boolean().optional().describe("In full mode only: whether to include parsed HTML body parts"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.threads.list({
                userId: 'me',
                maxResults: params.maxResults,
                pageToken: params.pageToken,
                q: params.q,
                labelIds: params.labelIds,
                includeSpamTrash: params.includeSpamTrash,
            });
            if (params.format && data.threads?.length) {
                data.threads = await Promise.all(
                    data.threads.map(async ({ id }) => {
                        try {
                            const { data: thread } = await gmail.users.threads.get({ userId: 'me', id, format: 'full' });
                            if (thread.messages) {
                                thread.messages = thread.messages.map(message => {
                                    if (params.format === 'clean') return formatMessageClean(message, params.maxBodyChars);
                                    if (params.format === 'metadata') return formatMessageMetadata(message);
                                    if (message.payload) message.payload = processMessagePart(message.payload, params.includeBodyHtml);
                                    return message;
                                });
                            }
                            return thread;
                        } catch (e) {
                            return { id, error: e.message || 'Failed to retrieve thread' };
                        }
                    })
                );
            }
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'batch_get_threads',
        description: 'Get multiple threads by ID in parallel. More efficient than calling get_thread multiple times.',
        parameters: z.object({
            ids: z.array(z.string()).describe("The IDs of the threads to retrieve"),
            format: z.enum(['full', 'clean', 'metadata']).optional().default('clean').describe("Response format for each message: clean (default), metadata (headers only), or full (raw MIME tree)"),
            maxBodyChars: z.number().optional().default(3000).describe("Max body characters per message in clean mode. 0 = unlimited."),
            includeBodyHtml: z.boolean().optional().describe("In full mode only: whether to include parsed HTML body parts"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const results = await Promise.all(
                params.ids.map(async (id) => {
                    try {
                        const { data } = await gmail.users.threads.get({ userId: 'me', id, format: 'full' });
                        if (data.messages) {
                            data.messages = data.messages.map(message => {
                                if (params.format === 'clean') return formatMessageClean(message, params.maxBodyChars);
                                if (params.format === 'metadata') return formatMessageMetadata(message);
                                if (message.payload) message.payload = processMessagePart(message.payload, params.includeBodyHtml);
                                return message;
                            });
                        }
                        return data;
                    } catch (error) {
                        return { id, error: error.message || 'Failed to retrieve thread' };
                    }
                })
            );
            return JSON.stringify(results);
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
        description: 'Move one or more threads to the trash or restore them. Pass a single id or an array of ids.',
        parameters: z.object({
            ids: z.union([z.string(), z.array(z.string())]).describe("Thread ID or array of thread IDs"),
            action: z.enum(['trash', 'untrash']).describe("'trash' to move to trash, 'untrash' to restore"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const ids = Array.isArray(params.ids) ? params.ids : [params.ids];
            const fn = params.action === 'untrash' ? 'untrash' : 'trash';
            const results = await Promise.all(
                ids.map(async (id) => {
                    try {
                        const { data } = await gmail.users.threads[fn]({ userId: 'me', id });
                        return data;
                    } catch (e) {
                        return { id, error: e.message || `Failed to ${fn} thread` };
                    }
                })
            );
            return JSON.stringify(ids.length === 1 ? results[0] : results);
        },
    });
}
