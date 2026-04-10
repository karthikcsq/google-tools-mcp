import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSlidesClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'formatSlidesParagraph',
        description:
            'Apply paragraph formatting (alignment, line spacing, bullets) to a text element in Google Slides.',
        parameters: z.object({
            presentationId: z.string().describe('Presentation ID'),
            objectId: z.string().describe('Object ID of the text element'),
            alignment: z.enum(['START', 'CENTER', 'END', 'JUSTIFIED']).optional().describe('Text alignment'),
            lineSpacing: z.number().optional().describe('Line spacing multiplier (e.g. 1.5)'),
            bulletStyle: z
                .enum(['NONE', 'DISC', 'ARROW', 'SQUARE', 'DIAMOND', 'STAR', 'NUMBERED'])
                .optional()
                .describe('Bullet style'),
        }),
        execute: async (args, { log }) => {
            const slidesApi = await getSlidesClient();
            const requests = [];

            if (args.alignment) {
                requests.push({
                    updateParagraphStyle: {
                        objectId: args.objectId,
                        style: { alignment: args.alignment },
                        fields: 'alignment',
                    },
                });
            }

            if (args.lineSpacing !== undefined) {
                requests.push({
                    updateParagraphStyle: {
                        objectId: args.objectId,
                        style: { lineSpacing: args.lineSpacing },
                        fields: 'lineSpacing',
                    },
                });
            }

            if (args.bulletStyle) {
                if (args.bulletStyle === 'NONE') {
                    requests.push({ deleteParagraphBullets: { objectId: args.objectId } });
                } else if (args.bulletStyle === 'NUMBERED') {
                    requests.push({
                        createParagraphBullets: { objectId: args.objectId, bulletPreset: 'NUMBERED_DIGIT_ALPHA_ROMAN' },
                    });
                } else {
                    requests.push({
                        createParagraphBullets: { objectId: args.objectId, bulletPreset: `BULLET_${args.bulletStyle}_CIRCLE_SQUARE` },
                    });
                }
            }

            if (requests.length === 0) throw new UserError('No formatting options specified');

            try {
                await slidesApi.presentations.batchUpdate({
                    presentationId: args.presentationId,
                    requestBody: { requests },
                });
                return JSON.stringify({ success: true, message: `Applied paragraph formatting to ${args.objectId}` });
            } catch (error) {
                log.error(`Error formatting paragraph: ${error.message || error}`);
                throw new UserError(`Failed to format paragraph: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
