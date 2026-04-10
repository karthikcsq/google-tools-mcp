import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSlidesClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'replaceAllTextInSlides',
        description:
            'Find and replace all matching text across all slides in a Google Slides presentation.',
        parameters: z.object({
            presentationId: z.string().describe('Presentation ID'),
            containsText: z.string().describe('Text to search for'),
            replaceText: z.string().describe('Replacement text'),
            matchCase: z.boolean().optional().default(false).describe('Case-sensitive match'),
        }),
        execute: async (args, { log }) => {
            const slidesApi = await getSlidesClient();

            try {
                const response = await slidesApi.presentations.batchUpdate({
                    presentationId: args.presentationId,
                    requestBody: {
                        requests: [
                            {
                                replaceAllText: {
                                    containsText: { text: args.containsText, matchCase: args.matchCase },
                                    replaceText: args.replaceText,
                                },
                            },
                        ],
                    },
                });

                const count = response.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
                return JSON.stringify({
                    success: true,
                    occurrencesChanged: count,
                    message: `Replaced ${count} occurrence(s) of "${args.containsText}"`,
                });
            } catch (error) {
                log.error(`Error replacing text: ${error.message || error}`);
                throw new UserError(`Failed to replace text: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
