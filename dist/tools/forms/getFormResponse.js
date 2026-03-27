import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getFormsClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'get_form_response',
        description:
            'Retrieves a single response from a Google Form by response ID. Returns the response timestamps and all answers keyed by question ID.',
        parameters: z.object({
            formId: z.string().describe('The ID of the Google Form'),
            responseId: z.string().describe('The ID of the specific response to retrieve'),
        }),
        execute: async (args, { log }) => {
            const forms = await getFormsClient();
            log.info(`Getting response ${args.responseId} for form: ${args.formId}`);

            try {
                const response = await forms.forms.responses.get({
                    formId: args.formId,
                    responseId: args.responseId,
                });
                const r = response.data;

                return JSON.stringify(
                    {
                        responseId: r.responseId,
                        createTime: r.createTime,
                        lastSubmittedTime: r.lastSubmittedTime,
                        answers: r.answers || {},
                    },
                    null,
                    2,
                );
            } catch (error) {
                log.error(`Error getting form response: ${error.message || error}`);
                if (error.code === 401)
                    throw new UserError('Authentication failed. Try logging out and re-authenticating.');
                if (error.code === 404)
                    throw new UserError(`Form or response not found: ${args.formId} / ${args.responseId}`);
                throw new UserError(`Failed to get form response: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
