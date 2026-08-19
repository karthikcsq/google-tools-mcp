// Gmail Label tools — consolidated dispatch tool (issue #31/#32/#33).
// manageLabel replaces create/patch/delete/get/list_label(s).
import { z } from 'zod';
import { UserError } from '../../errors.js';
import { getGmailClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'manageLabel',
        description:
            'Manage Gmail labels. action: create | patch | delete | get | list. ' +
            'create requires name. patch/delete/get require id.',
        parameters: z.object({
            action: z.enum(['create', 'patch', 'delete', 'get', 'list']).describe('The label operation to perform'),
            id: z.string().optional().describe('The label ID (required for patch, delete, get)'),
            name: z.string().optional().describe('The display name of the label (required for create)'),
            messageListVisibility: z.enum(['show', 'hide']).optional().describe('Visibility of messages with this label in the message list'),
            labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe('Visibility of the label in the label list'),
            color: z.object({
                textColor: z.string().describe('The text color as hex string'),
                backgroundColor: z.string().describe('The background color as hex string'),
            }).optional().describe('The color settings for the label'),
        }),
        execute: async (params) => {
            if (params.action === 'create' && !params.name) {
                throw new UserError('manageLabel action="create" requires name.');
            }
            if (['patch', 'delete', 'get'].includes(params.action) && !params.id) {
                throw new UserError(`manageLabel action="${params.action}" requires id.`);
            }
            const gmail = await getGmailClient();
            const { action, id, ...labelData } = params;
            let data;
            switch (action) {
                case 'create':
                    ({ data } = await gmail.users.labels.create({ userId: 'me', requestBody: labelData }));
                    break;
                case 'patch':
                    ({ data } = await gmail.users.labels.patch({ userId: 'me', id, requestBody: labelData }));
                    break;
                case 'delete':
                    ({ data } = await gmail.users.labels.delete({ userId: 'me', id }));
                    break;
                case 'get':
                    ({ data } = await gmail.users.labels.get({ userId: 'me', id }));
                    break;
                case 'list':
                    ({ data } = await gmail.users.labels.list({ userId: 'me' }));
                    break;
            }
            return JSON.stringify(data || { success: true });
        },
    });
}
