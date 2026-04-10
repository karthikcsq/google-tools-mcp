import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSlidesClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'deleteSlide',
        description: 'Delete a slide from a Google Slides presentation.',
        parameters: z.object({
            presentationId: z.string().describe('Presentation ID'),
            slideObjectId: z.string().describe('Object ID of the slide to delete'),
        }),
        execute: async (args, { log }) => {
            const slidesApi = await getSlidesClient();

            try {
                await slidesApi.presentations.batchUpdate({
                    presentationId: args.presentationId,
                    requestBody: {
                        requests: [{ deleteObject: { objectId: args.slideObjectId } }],
                    },
                });
                return JSON.stringify({ success: true, message: `Deleted slide ${args.slideObjectId}` });
            } catch (error) {
                log.error(`Error deleting slide: ${error.message || error}`);
                throw new UserError(`Failed to delete slide: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
