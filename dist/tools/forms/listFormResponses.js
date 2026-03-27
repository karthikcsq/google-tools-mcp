import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getFormsClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'list_form_responses',
        description:
            'Lists responses submitted to a Google Form. Returns a paginated list of responses with timestamps and answers.',
        parameters: z.object({
            formId: z.string().describe('The ID of the Google Form'),
            pageSize: z
                .number()
                .min(1)
                .max(5000)
                .optional()
                .describe('Number of responses to return per page (default 10, max 5000)'),
            pageToken: z.string().optional().describe('Token for fetching the next page of results'),
        }),
        execute: async (args, { log }) => {
            const forms = await getFormsClient();
            log.info(`Listing responses for form: ${args.formId}`);

            const params = { formId: args.formId };
            if (args.pageSize) params.pageSize = args.pageSize;
            if (args.pageToken) params.pageToken = args.pageToken;

            try {
                const response = await forms.forms.responses.list(params);
                const data = response.data;
                const responses = (data.responses || []).map((r) => ({
                    responseId: r.responseId,
                    createTime: r.createTime,
                    lastSubmittedTime: r.lastSubmittedTime,
                    answers: r.answers || {},
                }));

                return JSON.stringify(
                    {
                        totalResponses: responses.length,
                        nextPageToken: data.nextPageToken || null,
                        responses,
                    },
                    null,
                    2,
                );
            } catch (error) {
                log.error(`Error listing form responses: ${error.message || error}`);
                if (error.code === 401)
                    throw new UserError('Authentication failed. Try logging out and re-authenticating.');
                if (error.code === 404) throw new UserError(`Form not found: ${args.formId}`);
                throw new UserError(`Failed to list form responses: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
