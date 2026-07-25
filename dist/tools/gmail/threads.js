// Gmail Thread tools
import { z } from 'zod';
import { UserError } from 'fastmcp';
import { getGmailClient } from '../../clients.js';
import { processMessagePart, formatMessageClean, formatMessageMetadata, capToResponseBudget, makeOmissionStub, DEFAULT_MAX_RESPONSE_CHARS } from '../../helpers.js';

// A single message can exceed maxResponseChars on its own (maxBodyChars only
// caps each MIME part independently, and headers/metadata add more on top).
// Rather than ship it unbounded or drop it with no explanation, replace it
// with a bounded stub naming the message id and how to fetch it directly.
const messageOmissionStub = (maxResponseChars) => (message, budgetForStub) => makeOmissionStub(message, budgetForStub, id =>
    `This message alone is larger than maxResponseChars (${maxResponseChars}), even with per-part caps applied. Fetch it directly with messageIds: ["${id}"] and a larger maxResponseChars, or use format: 'metadata' for headers only.`);

// A single thread can exceed maxResponseChars on its own even after every
// message inside it has already been capped (e.g. maxResponseChars is small
// enough that even the per-thread floor does not fit). Same treatment as a
// single oversized message: a bounded stub rather than an unbounded thread
// or a silently dropped one.
const threadOmissionStub = (maxResponseChars) => (thread, budgetForStub) => makeOmissionStub(thread, budgetForStub, id =>
    `This thread alone is larger than maxResponseChars (${maxResponseChars}), even after per-message capping. Fetch it directly with getThread using id: "${id}" and a larger maxResponseChars, a smaller maxMessages, or format: 'metadata'.`);

// Truncates fullNote to whatever room remains so that adding it to an object
// already measured at baseSize (before the note key exists) keeps the whole
// thing at or under maxChars. The same "measure the real remaining room,
// don't guess a constant" approach makeOmissionStub already uses for its
// reason text. Returns '' when there is no room left at all, so the caller
// can skip attaching the key entirely rather than add a useless empty note.
const boundedNote = (fullNote, baseSize, maxChars) => {
    if (!maxChars || maxChars <= 0) return fullNote;
    // Reserve a little extra for the "truncationNote" key, its quotes, and
    // the comma joining it to what is already in the object.
    const room = Math.max(0, maxChars - baseSize - 20);
    return room > 0 ? fullNote.slice(0, room) : '';
};

// Applies the whole-response character budget to a thread's formatted
// messages array, keeping the latest messages (dropping oldest-first),
// stamping truncation metadata directly on the thread object (degrading its
// own note text to whatever room is left rather than a fixed length), and
// replacing a still-oversized last message with a bounded stub. Caps against
// the real serialized size of the whole thread object (not just its messages
// array), so headers, snippet, and every other field the Gmail API attaches
// are accounted for too.
//
// If even the smallest possible response for this thread, every message
// stubbed, the note dropped, still cannot fit maxResponseChars, there is no
// honest payload to return: this throws a UserError naming the measured
// minimum instead of silently shipping something far larger than requested.
const capThreadMessages = (thread, maxResponseChars) => {
    if (!thread.messages) return thread;
    const items = thread.messages;
    const result = capToResponseBudget(items, maxResponseChars, 'start', messageOmissionStub(maxResponseChars), (capped, truncated, totalCount, includedCount, maxChars) => {
        thread.messages = capped;
        if (truncated) {
            thread.responseTruncated = true;
            thread.totalMessages = totalCount;
            thread.includedMessages = includedCount;
            const fullNote = `Showing the latest ${includedCount} of ${totalCount} messages to stay under maxResponseChars (${maxResponseChars}). Use maxMessages, messageIds, format:'metadata', or a smaller maxBodyChars to fetch specific messages, or raise/zero maxResponseChars for the rest.`;
            const note = boundedNote(fullNote, JSON.stringify(thread).length, maxChars);
            if (note) thread.truncationNote = note;
            else delete thread.truncationNote;
        } else {
            delete thread.responseTruncated;
            delete thread.totalMessages;
            delete thread.includedMessages;
            delete thread.truncationNote;
        }
        return thread;
    });
    if (!result.ok) {
        throw new UserError(`maxResponseChars (${maxResponseChars}) is too small to return this thread, even with every message reduced to a bare size-omission stub. The smallest possible response for this thread is about ${result.minimumViableChars} characters. Retry with a larger maxResponseChars (at least ${result.minimumViableChars}), or use format: 'metadata' for a much smaller response.`);
    }
    return thread;
};

export function register(server) {
    server.addTool({
        name: 'getThread',
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
        name: 'listThreads',
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
                const threads = data.threads;
                const threadsResult = capToResponseBudget(threads, params.maxResponseChars, 'end', threadOmissionStub(params.maxResponseChars), (capped, truncated, totalCount, includedCount, maxChars) => {
                    data.threads = capped;
                    if (truncated) {
                        data.responseTruncated = true;
                        data.totalThreads = totalCount;
                        data.includedThreads = includedCount;
                        const fullNote = `Showing ${includedCount} of ${totalCount} threads fetched this call to stay under maxResponseChars (${params.maxResponseChars}). Use pageToken to continue, a smaller maxResults/maxMessages/maxBodyChars, or raise/zero maxResponseChars for the rest.`;
                        const note = boundedNote(fullNote, JSON.stringify(data).length, maxChars);
                        if (note) data.truncationNote = note;
                        else delete data.truncationNote;
                    }
                    return data;
                });
                if (!threadsResult.ok) {
                    throw new UserError(`maxResponseChars (${params.maxResponseChars}) is too small to return any threads for this call, even a single thread reduced to a bare size-omission stub. The smallest possible response is about ${threadsResult.minimumViableChars} characters. Retry with a larger maxResponseChars, fewer maxResults, or format: 'metadata'.`);
                }
            }
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'batchGetThreads',
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
            const batchResult = capToResponseBudget(results, params.maxResponseChars, 'end', threadOmissionStub(params.maxResponseChars), (capped, truncated, totalCount, includedCount, maxChars) => {
                if (!truncated) return capped;
                const withMetadata = capped.slice();
                const lastIndex = withMetadata.length - 1;
                withMetadata[lastIndex] = {
                    ...withMetadata[lastIndex],
                    batchResponseTruncated: true,
                    totalThreadsRequested: totalCount,
                    includedThreads: includedCount,
                };
                const fullNote = `Only ${includedCount} of ${totalCount} requested threads are included to stay under maxResponseChars (${params.maxResponseChars}). Re-run with fewer ids, a smaller maxMessages/maxBodyChars, or raise/zero maxResponseChars for the rest.`;
                const note = boundedNote(fullNote, JSON.stringify(withMetadata).length, maxChars);
                if (note) withMetadata[lastIndex] = { ...withMetadata[lastIndex], truncationNote: note };
                return withMetadata;
            });
            if (!batchResult.ok) {
                throw new UserError(`maxResponseChars (${params.maxResponseChars}) is too small to return any of the requested threads, even a single thread reduced to a bare size-omission stub. The smallest possible response is about ${batchResult.minimumViableChars} characters. Retry with a larger maxResponseChars, fewer ids, or format: 'metadata'.`);
            }
            return JSON.stringify(batchResult.payload);
        },
    });

    server.addTool({
        name: 'modifyThread',
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
        name: 'deleteThread',
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
        name: 'trashThread',
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
