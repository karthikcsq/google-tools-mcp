// Gmail Label tools
import { z } from 'zod';
import { getGmailClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'create_label',
        description: 'Create a new label',
        parameters: z.object({
            name: z.string().describe("The display name of the label"),
            messageListVisibility: z.enum(['show', 'hide']).optional().describe("Visibility of messages with this label in the message list"),
            labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
            color: z.object({
                textColor: z.string().describe("The text color as hex string"),
                backgroundColor: z.string().describe("The background color as hex string"),
            }).optional().describe("The color settings for the label"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.labels.create({ userId: 'me', requestBody: params });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'delete_label',
        description: 'Delete a label',
        parameters: z.object({
            id: z.string().describe("The ID of the label to delete"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.labels.delete({ userId: 'me', id: params.id });
            return JSON.stringify(data || { success: true });
        },
    });

    server.addTool({
        name: 'get_label',
        description: 'Get a specific label by ID',
        parameters: z.object({
            id: z.string().describe("The ID of the label to retrieve"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.labels.get({ userId: 'me', id: params.id });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'list_labels',
        description: 'List all labels in the user\'s mailbox',
        parameters: z.object({}),
        execute: async () => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.labels.list({ userId: 'me' });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'patch_label',
        description: 'Patch an existing label (partial update)',
        parameters: z.object({
            id: z.string().describe("The ID of the label to patch"),
            name: z.string().optional().describe("The display name of the label"),
            messageListVisibility: z.enum(['show', 'hide']).optional().describe("Visibility of messages with this label"),
            labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
            color: z.object({
                textColor: z.string().describe("The text color as hex string"),
                backgroundColor: z.string().describe("The background color as hex string"),
            }).optional().describe("The color settings for the label"),
        }),
        execute: async (params) => {
            const { id, ...labelData } = params;
            const gmail = await getGmailClient();
            const { data } = await gmail.users.labels.patch({ userId: 'me', id, requestBody: labelData });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'update_label',
        description: 'Update an existing label',
        parameters: z.object({
            id: z.string().describe("The ID of the label to update"),
            name: z.string().optional().describe("The display name of the label"),
            messageListVisibility: z.enum(['show', 'hide']).optional().describe("Visibility of messages with this label"),
            labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
            color: z.object({
                textColor: z.string().describe("The text color as hex string"),
                backgroundColor: z.string().describe("The background color as hex string"),
            }).optional().describe("The color settings for the label"),
        }),
        execute: async (params) => {
            const { id, ...labelData } = params;
            const gmail = await getGmailClient();
            const { data } = await gmail.users.labels.update({ userId: 'me', id, requestBody: labelData });
            return JSON.stringify(data);
        },
    });
}
