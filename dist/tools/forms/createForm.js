import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getFormsClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'create_form',
        description:
            'Creates a new Google Form with a title and optional description. Returns the form ID, edit URL, and responder URL.',
        parameters: z.object({
            title: z.string().describe('The title of the form (shown to respondents)'),
            description: z.string().optional().describe('A description displayed at the top of the form'),
            documentTitle: z
                .string()
                .optional()
                .describe('The document title (shown in Drive). Defaults to the form title if not provided'),
        }),
        execute: async (args, { log }) => {
            const forms = await getFormsClient();
            log.info(`Creating form: ${args.title}`);

            const body = {
                info: {
                    title: args.title,
                    documentTitle: args.documentTitle || args.title,
                },
            };
            if (args.description) {
                body.info.description = args.description;
            }

            try {
                const response = await forms.forms.create({ requestBody: body });
                const form = response.data;

                return JSON.stringify(
                    {
                        formId: form.formId,
                        title: form.info?.title,
                        editUrl: `https://docs.google.com/forms/d/${form.formId}/edit`,
                        responderUrl: form.responderUri || `https://docs.google.com/forms/d/${form.formId}/viewform`,
                    },
                    null,
                    2,
                );
            } catch (error) {
                log.error(`Error creating form: ${error.message || error}`);
                if (error.code === 401)
                    throw new UserError('Authentication failed. Try logging out and re-authenticating.');
                throw new UserError(`Failed to create form: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
