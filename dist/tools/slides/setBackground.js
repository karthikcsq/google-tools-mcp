import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSlidesClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'setSlidesBackground',
        description:
            'Set the background color for one or more slides in a Google Slides presentation.',
        parameters: z.object({
            presentationId: z.string().describe('Presentation ID'),
            pageObjectIds: z.array(z.string()).min(1).describe('Array of slide page object IDs to update'),
            backgroundColor: z
                .object({
                    red: z.number().min(0).max(1).optional(),
                    green: z.number().min(0).max(1).optional(),
                    blue: z.number().min(0).max(1).optional(),
                    alpha: z.number().min(0).max(1).optional(),
                })
                .describe('Background color (RGBA 0-1)'),
        }),
        execute: async (args, { log }) => {
            const slidesApi = await getSlidesClient();

            const requests = args.pageObjectIds.map((pageObjectId) => ({
                updatePageProperties: {
                    objectId: pageObjectId,
                    pageProperties: {
                        pageBackgroundFill: {
                            solidFill: {
                                color: {
                                    rgbColor: {
                                        red: args.backgroundColor.red || 0,
                                        green: args.backgroundColor.green || 0,
                                        blue: args.backgroundColor.blue || 0,
                                    },
                                },
                                alpha: args.backgroundColor.alpha ?? 1,
                            },
                        },
                    },
                    fields: 'pageBackgroundFill',
                },
            }));

            try {
                await slidesApi.presentations.batchUpdate({
                    presentationId: args.presentationId,
                    requestBody: { requests },
                });
                return JSON.stringify({ success: true, message: `Set background for ${args.pageObjectIds.length} slide(s)` });
            } catch (error) {
                log.error(`Error setting background: ${error.message || error}`);
                throw new UserError(`Failed to set background: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
