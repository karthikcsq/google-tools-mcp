// Gmail Message tools
import { z } from 'zod';
import { getGmailClient } from '../clients.js';
import { processMessagePart, constructRawMessage } from '../helpers.js';

export function register(server) {
    server.addTool({
        name: 'send_message',
        description: 'Send an email message to specified recipients. Note the mechanics of the raw parameter.',
        parameters: z.object({
            raw: z.string().optional().describe("The entire email message in base64url encoded RFC 2822 format, ignores to, cc, bcc, subject, body if provided"),
            threadId: z.string().optional().describe("The thread ID to associate this message with"),
            to: z.array(z.string()).optional().describe("List of recipient email addresses"),
            cc: z.array(z.string()).optional().describe("List of CC recipient email addresses"),
            bcc: z.array(z.string()).optional().describe("List of BCC recipient email addresses"),
            subject: z.string().optional().describe("The subject of the email"),
            body: z.string().optional().describe("The body of the email"),
            includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            let raw = params.raw;
            if (!raw) raw = await constructRawMessage(gmail, params);
            const sendParams = { userId: 'me', requestBody: { raw } };
            if (params.threadId && sendParams.requestBody) {
                sendParams.requestBody.threadId = params.threadId;
            }
            const { data } = await gmail.users.messages.send(sendParams);
            if (data.payload) {
                data.payload = processMessagePart(data.payload, params.includeBodyHtml);
            }
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'get_message',
        description: 'Get a specific message by ID with format options',
        parameters: z.object({
            id: z.string().describe("The ID of the message to retrieve"),
            includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.messages.get({ userId: 'me', id: params.id, format: 'full' });
            if (data.payload) {
                data.payload = processMessagePart(data.payload, params.includeBodyHtml);
            }
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'list_messages',
        description: 'List messages in the user\'s mailbox with optional filtering',
        parameters: z.object({
            maxResults: z.number().optional().describe("Maximum number of messages to return (1-500)"),
            pageToken: z.string().optional().describe("Page token to retrieve a specific page of results"),
            q: z.string().optional().describe("Only return messages matching the specified query (same format as Gmail search box)"),
            labelIds: z.array(z.string()).optional().describe("Only return messages with labels that match all specified label IDs"),
            includeSpamTrash: z.boolean().optional().describe("Include messages from SPAM and TRASH"),
            includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.messages.list({ userId: 'me', ...params });
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
        name: 'modify_message',
        description: 'Modify the labels on a message',
        parameters: z.object({
            id: z.string().describe("The ID of the message to modify"),
            addLabelIds: z.array(z.string()).optional().describe("Label IDs to add"),
            removeLabelIds: z.array(z.string()).optional().describe("Label IDs to remove"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.messages.modify({
                userId: 'me', id: params.id,
                requestBody: { addLabelIds: params.addLabelIds, removeLabelIds: params.removeLabelIds }
            });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'delete_message',
        description: 'Immediately and permanently delete a message',
        parameters: z.object({
            id: z.string().describe("The ID of the message to delete"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.messages.delete({ userId: 'me', id: params.id });
            return JSON.stringify(data || { success: true });
        },
    });

    server.addTool({
        name: 'trash_message',
        description: 'Move a message to the trash',
        parameters: z.object({
            id: z.string().describe("The ID of the message to move to trash"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.messages.trash({ userId: 'me', id: params.id });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'untrash_message',
        description: 'Remove a message from the trash',
        parameters: z.object({
            id: z.string().describe("The ID of the message to remove from trash"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.messages.untrash({ userId: 'me', id: params.id });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'batch_delete_messages',
        description: 'Delete multiple messages',
        parameters: z.object({
            ids: z.array(z.string()).describe("The IDs of the messages to delete"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.messages.batchDelete({ userId: 'me', requestBody: { ids: params.ids } });
            return JSON.stringify(data || { success: true });
        },
    });

    server.addTool({
        name: 'batch_modify_messages',
        description: 'Modify the labels on multiple messages',
        parameters: z.object({
            ids: z.array(z.string()).describe("The IDs of the messages to modify"),
            addLabelIds: z.array(z.string()).optional().describe("Label IDs to add"),
            removeLabelIds: z.array(z.string()).optional().describe("Label IDs to remove"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.messages.batchModify({
                userId: 'me',
                requestBody: { ids: params.ids, addLabelIds: params.addLabelIds, removeLabelIds: params.removeLabelIds }
            });
            return JSON.stringify(data || { success: true });
        },
    });

    server.addTool({
        name: 'get_attachment',
        description: 'Get a message attachment',
        parameters: z.object({
            messageId: z.string().describe("ID of the message containing the attachment"),
            id: z.string().describe("The ID of the attachment"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.messages.attachments.get({ userId: 'me', messageId: params.messageId, id: params.id });
            return JSON.stringify(data);
        },
    });
}
