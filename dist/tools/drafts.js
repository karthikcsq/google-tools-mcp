// Gmail Draft tools
import { z } from 'zod';
import { UserError } from 'fastmcp';
import { getGmailClient } from '../clients.js';
import { processMessagePart, constructRawMessage, constructRawMessageWithAttachments } from '../helpers.js';

export function register(server) {
    server.addTool({
        name: 'create_draft',
        description: 'Create a draft email in Gmail. Note the mechanics of the raw parameter.',
        parameters: z.object({
            raw: z.string().optional().describe("The entire email message in base64url encoded RFC 2822 format, ignores params.to, cc, bcc, subject, body, includeBodyHtml if provided"),
            threadId: z.string().optional().describe("The thread ID to associate this draft with"),
            to: z.array(z.string()).optional().describe("List of recipient email addresses"),
            cc: z.array(z.string()).optional().describe("List of CC recipient email addresses"),
            bcc: z.array(z.string()).optional().describe("List of BCC recipient email addresses"),
            subject: z.string().optional().describe("The subject of the email"),
            body: z.string().optional().describe("The body of the email. Supports plain text or HTML (auto-detected). Use HTML tags like <p>, <br>, <b> for formatted emails."),
            attachments: z.array(z.object({
                filename: z.string().describe("Attachment file name"),
                mimeType: z.string().describe("MIME type of the attachment"),
                base64Data: z.string().describe("Base64 encoded attachment data"),
            })).optional().describe("File attachments to include"),
            includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body"),
        }),
        execute: async (params, { log }) => {
            const gmail = await getGmailClient();
            let raw = params.raw;
            if (!raw) {
                if (params.attachments?.length) {
                    raw = await constructRawMessageWithAttachments(gmail, params);
                } else {
                    raw = await constructRawMessage(gmail, params);
                }
            }
            const createParams = { userId: 'me', requestBody: { message: { raw } } };
            if (params.threadId && createParams.requestBody?.message) {
                createParams.requestBody.message.threadId = params.threadId;
            }
            const { data } = await gmail.users.drafts.create(createParams);
            if (data.message?.payload) {
                data.message.payload = processMessagePart(data.message.payload, params.includeBodyHtml);
            }
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'update_draft',
        description: 'Update an existing draft\'s content. Replaces the draft message with new content.',
        parameters: z.object({
            id: z.string().describe("The ID of the draft to update"),
            raw: z.string().optional().describe("The entire email message in base64url encoded RFC 2822 format, ignores other params if provided"),
            threadId: z.string().optional().describe("The thread ID to associate this draft with"),
            to: z.array(z.string()).optional().describe("List of recipient email addresses"),
            cc: z.array(z.string()).optional().describe("List of CC recipient email addresses"),
            bcc: z.array(z.string()).optional().describe("List of BCC recipient email addresses"),
            subject: z.string().optional().describe("The subject of the email"),
            body: z.string().optional().describe("The body of the email. Supports plain text or HTML (auto-detected). Use HTML tags like <p>, <br>, <b> for formatted emails."),
            attachments: z.array(z.object({
                filename: z.string().describe("Attachment file name"),
                mimeType: z.string().describe("MIME type of the attachment"),
                base64Data: z.string().describe("Base64 encoded attachment data"),
            })).optional().describe("File attachments to include"),
            includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            let raw = params.raw;
            if (!raw) {
                if (params.attachments?.length) {
                    raw = await constructRawMessageWithAttachments(gmail, params);
                } else {
                    raw = await constructRawMessage(gmail, params);
                }
            }
            const updateParams = { userId: 'me', id: params.id, requestBody: { message: { raw } } };
            if (params.threadId && updateParams.requestBody?.message) {
                updateParams.requestBody.message.threadId = params.threadId;
            }
            const { data } = await gmail.users.drafts.update(updateParams);
            if (data.message?.payload) {
                data.message.payload = processMessagePart(data.message.payload, params.includeBodyHtml);
            }
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'delete_draft',
        description: 'Delete a draft',
        parameters: z.object({
            id: z.string().describe("The ID of the draft to delete"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.drafts.delete({ userId: 'me', id: params.id });
            return JSON.stringify(data || { success: true });
        },
    });

    server.addTool({
        name: 'get_draft',
        description: 'Get a specific draft by ID',
        parameters: z.object({
            id: z.string().describe("The ID of the draft to retrieve"),
            includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.drafts.get({ userId: 'me', id: params.id, format: 'full' });
            if (data.message?.payload) {
                data.message.payload = processMessagePart(data.message.payload, params.includeBodyHtml);
            }
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'list_drafts',
        description: 'List drafts in the user\'s mailbox',
        parameters: z.object({
            maxResults: z.number().optional().describe("Maximum number of drafts to return (1-500)"),
            q: z.string().optional().describe("Only return drafts matching the specified query"),
            includeSpamTrash: z.boolean().optional().describe("Include drafts from SPAM and TRASH"),
            includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            let drafts = [];
            const { data } = await gmail.users.drafts.list({ userId: 'me', ...params });
            drafts.push(...(data.drafts || []));
            let pageToken = data.nextPageToken;
            while (pageToken) {
                const { data: nextData } = await gmail.users.drafts.list({ userId: 'me', ...params, pageToken });
                drafts.push(...(nextData.drafts || []));
                pageToken = nextData.nextPageToken;
            }
            drafts = drafts.map(draft => {
                if (draft.message?.payload) {
                    draft.message.payload = processMessagePart(draft.message.payload, params.includeBodyHtml);
                }
                return draft;
            });
            return JSON.stringify(drafts);
        },
    });

    server.addTool({
        name: 'send_draft',
        description: 'Send an existing draft',
        parameters: z.object({
            id: z.string().describe("The ID of the draft to send"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            try {
                const { data } = await gmail.users.drafts.send({ userId: 'me', requestBody: { id: params.id } });
                return JSON.stringify(data);
            } catch (error) {
                throw new UserError('Error sending draft, are you sure you have at least one recipient?');
            }
        },
    });
}
