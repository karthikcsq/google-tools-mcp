import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSlidesClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'duplicateSlide',
        description: 'Duplicate a slide in a Google Slides presentation.',
        parameters: z.object({
            presentationId: z.string().describe('Presentation ID'),
            slideObjectId: z.string().describe('Object ID of the slide to duplicate'),
        }),
        execute: async (args, { log }) => {
            const slidesApi = await getSlidesClient();

            try {
                const response = await slidesApi.presentations.batchUpdate({
                    presentationId: args.presentationId,
                    requestBody: {
                        requests: [{ duplicateObject: { objectId: args.slideObjectId } }],
                    },
                });

                const newId = response.data.replies?.[0]?.duplicateObject?.objectId;
                return JSON.stringify({
                    success: true,
                    originalId: args.slideObjectId,
                    duplicateId: newId || null,
                    message: `Duplicated slide ${args.slideObjectId}${newId ? ` -> ${newId}` : ''}`,
                });
            } catch (error) {
                log.error(`Error duplicating slide: ${error.message || error}`);
                throw new UserError(`Failed to duplicate slide: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
