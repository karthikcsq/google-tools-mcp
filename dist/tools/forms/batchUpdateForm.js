import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getFormsClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'batch_update_form',
        description:
            'Applies one or more updates to a Google Form. Supports creating, updating, deleting, and moving items, as well as updating form info and settings. ' +
            'Each request in the array should be an object with exactly one key: createItem, updateItem, deleteItem, moveItem, updateFormInfo, or updateSettings. ' +
            'See the Google Forms API batchUpdate documentation for the full request schema.',
        parameters: z.object({
            formId: z.string().describe('The ID of the Google Form to update'),
            requests: z
                .array(z.record(z.any()))
                .min(1)
                .describe(
                    'Array of update requests. Each object should have one key: createItem, updateItem, deleteItem, moveItem, updateFormInfo, or updateSettings',
                ),
        }),
        execute: async (args, { log }) => {
            const forms = await getFormsClient();
            log.info(`Batch updating form ${args.formId} with ${args.requests.length} request(s)`);

            const validKeys = new Set([
                'createItem',
                'updateItem',
                'deleteItem',
                'moveItem',
                'updateFormInfo',
                'updateSettings',
            ]);

            for (const req of args.requests) {
                const keys = Object.keys(req);
                if (keys.length !== 1 || !validKeys.has(keys[0])) {
                    throw new UserError(
                        `Invalid request object. Each request must have exactly one key from: ${[...validKeys].join(', ')}. Got: ${keys.join(', ')}`,
                    );
                }
            }

            try {
                const response = await forms.forms.batchUpdate({
                    formId: args.formId,
                    requestBody: { requests: args.requests },
                });
                const data = response.data;
                const replies = data.replies || [];

                const result = {
                    requestsApplied: args.requests.length,
                    repliesReceived: replies.length,
                };

                const createdItems = [];
                for (const reply of replies) {
                    if (reply.createItem) {
                        const ci = reply.createItem;
                        createdItems.push({
                            itemId: ci.itemId,
                            questionId: ci.questionId?.[0] || null,
                        });
                    }
                }
                if (createdItems.length > 0) {
                    result.createdItems = createdItems;
                }

                return JSON.stringify(result, null, 2);
            } catch (error) {
                log.error(`Error batch updating form: ${error.message || error}`);
                if (error.code === 401)
                    throw new UserError('Authentication failed. Try logging out and re-authenticating.');
                if (error.code === 404) throw new UserError(`Form not found: ${args.formId}`);
                throw new UserError(`Failed to batch update form: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
