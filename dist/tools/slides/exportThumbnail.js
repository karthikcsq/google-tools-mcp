import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSlidesClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'exportSlideThumbnail',
        description: 'Export a slide as a thumbnail image URL (PNG or JPEG) from a Google Slides presentation.',
        parameters: z.object({
            presentationId: z.string().describe('Presentation ID'),
            slideObjectId: z.string().describe('Slide object ID'),
            mimeType: z.enum(['PNG', 'JPEG']).optional().default('PNG').describe('Image format'),
            size: z.enum(['SMALL', 'MEDIUM', 'LARGE']).optional().default('LARGE').describe('Thumbnail size'),
        }),
        execute: async (args, { log }) => {
            const slidesApi = await getSlidesClient();

            try {
                const response = await slidesApi.presentations.pages.getThumbnail({
                    presentationId: args.presentationId,
                    pageObjectId: args.slideObjectId,
                    'thumbnailProperties.mimeType': args.mimeType,
                    'thumbnailProperties.thumbnailSize': args.size,
                });

                const url = response.data?.contentUrl;
                if (!url) throw new UserError('No thumbnail URL returned by Google Slides API.');

                return JSON.stringify({
                    slideObjectId: args.slideObjectId,
                    mimeType: args.mimeType,
                    size: args.size,
                    thumbnailUrl: url,
                });
            } catch (error) {
                if (error instanceof UserError) throw error;
                log.error(`Error exporting thumbnail: ${error.message || error}`);
                throw new UserError(`Failed to export thumbnail: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
