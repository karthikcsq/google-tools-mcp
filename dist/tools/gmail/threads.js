// Gmail Thread tools
import { z } from 'zod';
import { getGmailClient } from '../../clients.js';
import { processMessagePart, formatMessageClean, formatMessageMetadata, capArrayByResponseBudget, DEFAULT_MAX_RESPONSE_CHARS } from '../../helpers.js';

// Applies the whole-response character budget to a thread's formatted messages
// array, keeping the latest messages (dropping oldest-first) and stamping
// truncation metadata directly on the thread object so callers can tell it
// happened and how to get the rest.
const capThreadMessages = (thread, maxResponseChars) => {
    if (!thread.messages) return thread;
    const budget = capArrayByResponseBudget(thread.messages, maxResponseChars, 'start');
    thread.messages = budget.items;
    if (budget.truncated) {
        thread.responseTruncated = true;
        thread.totalMessages = budget.totalCount;
        thread.includedMessages = budget.includedCount;
        thread.truncationNote = `Showing the latest ${budget.includedCount} of ${budget.totalCount} messages to stay under maxResponseChars (${maxResponseChars}). Use maxMessages, messageIds, format:'metadata', or a smaller maxBodyChars to fetch specific messages, or raise/zero maxResponseChars for the rest.`;
    }
    return thread;
};

export function register(server) {
    server.addTool({
        name: 'get_thread',
        description: 'Get a specific thread by ID. Clean mode removes quoted reply history when it can be safely identified; an ambiguous Outlook-style quote (no ">" prefixes to mark where it ends) is left in the body rather than guessed at, and flagged via quotedHistoryAmbiguous/quotedHistoryNote. Full mode returns raw MIME trees with decoded text bodies limited by maxBodyChars. Use maxMessages (latest N) or messageIds to fetch only the messages you need. Note: maxBodyChars caps each message body independently, not the total response size. maxResponseChars bounds the aggregate response and truncates (keeping the latest messages) with a truncationNote when the thread is too large.',
        parameters: z.object({
            id: z.string().describe("The ID of the thread to retrieve"),
            format: z.enum(['full', 'clean', 'metadata']).optional().default('clean').describe("Response format for each message: clean (default), metadata (headers only), or full (raw MIME tree)"),
            maxBodyChars: z.number().optional().default(3000).describe("Max decoded chars per text body — per message in clean mode, per MIME text part in full mode; not a whole-response cap. Oversized undecoded parts (e.g. HTML) are omitted with a totalChars note. 0 = unlimited."),
            includeQuoted: z.boolean().optional().default(false).describe("In clean mode: skip quote detection entirely and always return the full body, including any quoted reply history. Default false. Use this if quotedHistoryAmbiguous keeps showing up and you'd rather have the full text every time than a per-message flag."),
            includeBodyHtml: z.boolean().optional().describe("In full mode only: whether to include parsed HTML body parts"),
            messageIds: z.array(z.string()).optional().describe("Only include messages with these IDs in the thread response. An empty array is treated as no filter."),
            maxMessages: z.number().optional().describe("Only include the latest N messages of the thread (applied after messageIds). Omit for all. Use 1-2 for the usual 'just the latest reply' case."),
            maxResponseChars: z.number().optional().default(DEFAULT_MAX_RESPONSE_CHARS).describe(`Whole-response character budget across all messages combined (unlike maxBodyChars, which only caps each message independently). When exceeded, the oldest messages are dropped (keeping the latest) and the response reports responseTruncated/totalMessages/includedMessages/truncationNote. Default ${DEFAULT_MAX_RESPONSE_CHARS}. 0 = unlimited.`),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.threads.get({ userId: 'me', id: params.id, format: 'full' });
            if (data.messages) {
                if (params.messageIds?.length) data.messages = data.messages.filter(message => params.messageIds.includes(message.id));
                if (params.maxMessages > 0) data.messages = data.messages.slice(-params.maxMessages);
                data.messages = data.messages.map(message => {
                    if (params.format === 'clean') return formatMessageClean(message, params.maxBodyChars, params.includeQuoted);
                    if (params.format === 'metadata') return formatMessageMetadata(message);
                    if (message.payload) message.payload = processMessagePart(message.payload, params.includeBodyHtml, params.maxBodyChars);
                    return message;
                });
                capThreadMessages(data, params.maxResponseChars);
            }
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'list_threads',
        description: 'List threads in the user\'s mailbox. Clean mode removes quoted reply history when it can be safely identified; an ambiguous Outlook-style quote (no ">" prefixes to mark where it ends) is left in the body rather than guessed at, and flagged via quotedHistoryAmbiguous/quotedHistoryNote. Full mode limits decoded text bodies with maxBodyChars. Omit format to get bare thread stubs. maxResponseChars bounds the aggregate response size across all fetched threads combined and truncates (dropping the lowest-priority threads, then oldest messages within a thread) with a truncationNote when the call is too large.',
        parameters: z.object({
            maxResults: z.number().optional().describe("Maximum number of threads to return"),
            pageToken: z.string().optional().describe("Page token to retrieve a specific page of results"),
            q: z.string().optional().describe("Only return threads matching the specified query"),
            labelIds: z.array(z.string()).optional().describe("Only return threads with labels that match all specified label IDs"),
            includeSpamTrash: z.boolean().optional().describe("Include threads from SPAM and TRASH"),
            format: z.enum(['full', 'clean', 'metadata']).optional().describe("When set, auto-fetches full thread details. metadata=headers only (default when set), clean=with bodies, full=raw MIME tree."),
            maxBodyChars: z.number().optional().default(3000).describe("Max decoded chars per text body — per message in clean mode, per MIME text part in full mode; not a whole-response cap. Oversized undecoded parts (e.g. HTML) are omitted with a totalChars note. 0 = unlimited."),
            includeQuoted: z.boolean().optional().default(false).describe("In clean mode: skip quote detection entirely and always return the full body, including any quoted reply history. Default false. Use this if quotedHistoryAmbiguous keeps showing up and you'd rather have the full text every time than a per-message flag."),
            includeBodyHtml: z.boolean().optional().describe("In full mode only: whether to include parsed HTML body parts"),
            maxMessages: z.number().optional().describe("Only include the latest N messages per thread. Omit for all."),
            maxResponseChars: z.number().optional().default(DEFAULT_MAX_RESPONSE_CHARS).describe(`Whole-response character budget across every thread this call fetches combined (unlike maxBodyChars, which only caps each message independently, and applies per-thread besides). When exceeded, whole threads are dropped from the end of the list first; each retained thread is also capped individually. Reports responseTruncated/totalThreads/includedThreads/truncationNote at the top level, and the same per-thread when an individual thread's messages were cut. Default ${DEFAULT_MAX_RESPONSE_CHARS}. 0 = unlimited.`),
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
                                if (params.maxMessages > 0) thread.messages = thread.messages.slice(-params.maxMessages);
                                thread.messages = thread.messages.map(message => {
                                    if (params.format === 'clean') return formatMessageClean(message, params.maxBodyChars, params.includeQuoted);
                                    if (params.format === 'metadata') return formatMessageMetadata(message);
                                    if (message.payload) message.payload = processMessagePart(message.payload, params.includeBodyHtml, params.maxBodyChars);
                                    return message;
                                });
                                capThreadMessages(thread, params.maxResponseChars);
                            }
                            return thread;
                        } catch (e) {
                            return { id, error: e.message || 'Failed to retrieve thread' };
                        }
                    })
                );
                const budget = capArrayByResponseBudget(data.threads, params.maxResponseChars, 'end');
                data.threads = budget.items;
                if (budget.truncated) {
                    data.responseTruncated = true;
                    data.totalThreads = budget.totalCount;
                    data.includedThreads = budget.includedCount;
                    data.truncationNote = `Showing ${budget.includedCount} of ${budget.totalCount} threads fetched this call to stay under maxResponseChars (${params.maxResponseChars}). Use pageToken to continue, a smaller maxResults/maxMessages/maxBodyChars, or raise/zero maxResponseChars for the rest.`;
                }
            }
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'batch_get_threads',
        description: 'Get multiple threads by ID in parallel. Clean mode removes quoted reply history when it can be safely identified; an ambiguous Outlook-style quote (no ">" prefixes to mark where it ends) is left in the body rather than guessed at, and flagged via quotedHistoryAmbiguous/quotedHistoryNote. Full mode limits decoded text bodies with maxBodyChars. maxResponseChars bounds the aggregate response size across all requested threads combined: whole threads are dropped from the end of the ids list first, then each retained thread is capped individually, with truncation reported on the last returned thread (batchResponseTruncated/totalThreadsRequested/includedThreads/truncationNote).',
        parameters: z.object({
            ids: z.array(z.string()).describe("The IDs of the threads to retrieve"),
            format: z.enum(['full', 'clean', 'metadata']).optional().default('clean').describe("Response format for each message: clean (default), metadata (headers only), or full (raw MIME tree)"),
            maxBodyChars: z.number().optional().default(3000).describe("Max decoded chars per text body — per message in clean mode, per MIME text part in full mode; not a whole-response cap. Oversized undecoded parts (e.g. HTML) are omitted with a totalChars note. 0 = unlimited."),
            includeQuoted: z.boolean().optional().default(false).describe("In clean mode: skip quote detection entirely and always return the full body, including any quoted reply history. Default false. Use this if quotedHistoryAmbiguous keeps showing up and you'd rather have the full text every time than a per-message flag."),
            includeBodyHtml: z.boolean().optional().describe("In full mode only: whether to include parsed HTML body parts"),
            maxMessages: z.number().optional().describe("Only include the latest N messages per thread. Omit for all."),
            maxResponseChars: z.number().optional().default(DEFAULT_MAX_RESPONSE_CHARS).describe(`Whole-response character budget across every requested thread combined (unlike maxBodyChars, which only caps each message independently, and applies per-thread besides). When exceeded, whole threads are dropped from the end of the ids list first; each retained thread is also capped individually. Truncation is reported on the last returned thread via batchResponseTruncated/totalThreadsRequested/includedThreads/truncationNote, and per-thread when an individual thread's messages were cut. Default ${DEFAULT_MAX_RESPONSE_CHARS}. 0 = unlimited.`),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const results = await Promise.all(
                params.ids.map(async (id) => {
                    try {
                        const { data } = await gmail.users.threads.get({ userId: 'me', id, format: 'full' });
                        if (data.messages) {
                            if (params.maxMessages > 0) data.messages = data.messages.slice(-params.maxMessages);
                            data.messages = data.messages.map(message => {
                                if (params.format === 'clean') return formatMessageClean(message, params.maxBodyChars, params.includeQuoted);
                                if (params.format === 'metadata') return formatMessageMetadata(message);
                                if (message.payload) message.payload = processMessagePart(message.payload, params.includeBodyHtml, params.maxBodyChars);
                                return message;
                            });
                            capThreadMessages(data, params.maxResponseChars);
                        }
                        return data;
                    } catch (error) {
                        return { id, error: error.message || 'Failed to retrieve thread' };
                    }
                })
            );
            const budget = capArrayByResponseBudget(results, params.maxResponseChars, 'end');
            let output = budget.items;
            if (budget.truncated) {
                output = output.slice();
                const lastIndex = output.length - 1;
                output[lastIndex] = {
                    ...output[lastIndex],
                    batchResponseTruncated: true,
                    totalThreadsRequested: budget.totalCount,
                    includedThreads: budget.includedCount,
                    truncationNote: `Only ${budget.includedCount} of ${budget.totalCount} requested threads are included to stay under maxResponseChars (${params.maxResponseChars}). Re-run with fewer ids, a smaller maxMessages/maxBodyChars, or raise/zero maxResponseChars for the rest.`,
                };
            }
            return JSON.stringify(output);
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
