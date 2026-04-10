import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSlidesClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'reorderSlides',
        description: 'Reorder one or more slides in a Google Slides presentation by moving them to a target index.',
        parameters: z.object({
            presentationId: z.string().describe('Presentation ID'),
            slideObjectIds: z.array(z.string()).min(1).describe('Array of slide object IDs to move'),
            insertionIndex: z.number().int().min(0).describe('Target insertion index (0-based)'),
        }),
        execute: async (args, { log }) => {
            const slidesApi = await getSlidesClient();

            try {
                await slidesApi.presentations.batchUpdate({
                    presentationId: args.presentationId,
                    requestBody: {
                        requests: [
                            {
                                updateSlidesPosition: {
                                    slideObjectIds: args.slideObjectIds,
                                    insertionIndex: args.insertionIndex,
                                },
                            },
                        ],
                    },
                });
                return JSON.stringify({
                    success: true,
                    message: `Reordered ${args.slideObjectIds.length} slide(s) to index ${args.insertionIndex}`,
                });
            } catch (error) {
                log.error(`Error reordering slides: ${error.message || error}`);
                throw new UserError(`Failed to reorder slides: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
