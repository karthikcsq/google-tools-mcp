import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getFormsClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'set_publish_settings',
        description:
            'Updates the publish settings of a Google Form. Controls whether the form is published as a template and whether respondents must be authenticated.',
        parameters: z.object({
            formId: z.string().describe('The ID of the Google Form'),
            publishAsTemplate: z
                .boolean()
                .optional()
                .describe('Whether to publish the form as a reusable template'),
            requireAuthentication: z
                .boolean()
                .optional()
                .describe('Whether respondents must sign in with a Google account to submit the form'),
        }),
        execute: async (args, { log }) => {
            const forms = await getFormsClient();
            log.info(`Setting publish settings for form: ${args.formId}`);

            const body = {};
            if (args.publishAsTemplate !== undefined) {
                body.publishAsTemplate = args.publishAsTemplate;
            }
            if (args.requireAuthentication !== undefined) {
                body.requireAuthentication = args.requireAuthentication;
            }

            if (Object.keys(body).length === 0) {
                throw publicError('At least one setting (publishAsTemplate or requireAuthentication) must be provided.');
            }

            try {
                await forms.forms.setPublishSettings({
                    formId: args.formId,
                    requestBody: body,
                });

                return JSON.stringify({
                    url: `https://docs.google.com/forms/d/${args.formId}/edit`,
                    success: true,
                    formId: args.formId,
                    message: 'Publish settings updated successfully.',
                    appliedSettings: body,
                }, null, 2);
            } catch (error) {
                if (isPublicError(error)) throw error;
                log.error(`Error setting publish settings: ${error.message || error}`);
                if (error.code === 401)
                    throw publicError('Authentication failed. Try logging out and re-authenticating.');
                if (error.code === 404) throw publicError(`Form not found: ${args.formId}`);
throw wrapOperationError('set form publish settings', error, { status: error?.code });
            }
        },
    });
}
