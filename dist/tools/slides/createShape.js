import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSlidesClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'createSlidesShape',
        description:
            'Create a shape on a slide in Google Slides. Position and size are in EMU (914400 EMU = 1 inch).',
        parameters: z.object({
            presentationId: z.string().describe('Presentation ID'),
            pageObjectId: z.string().describe('Slide page object ID'),
            shapeType: z
                .enum(['RECTANGLE', 'ELLIPSE', 'DIAMOND', 'TRIANGLE', 'STAR', 'ROUND_RECTANGLE', 'ARROW'])
                .describe('Shape type'),
            x: z.number().describe('X position in EMU'),
            y: z.number().describe('Y position in EMU'),
            width: z.number().describe('Width in EMU'),
            height: z.number().describe('Height in EMU'),
            backgroundColor: z
                .object({
                    red: z.number().min(0).max(1).optional(),
                    green: z.number().min(0).max(1).optional(),
                    blue: z.number().min(0).max(1).optional(),
                    alpha: z.number().min(0).max(1).optional(),
                })
                .optional()
                .describe('Fill color (RGBA 0-1)'),
        }),
        execute: async (args, { log }) => {
            const slidesApi = await getSlidesClient();
            const elementId = `shape_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

            const requests = [
                {
                    createShape: {
                        objectId: elementId,
                        shapeType: args.shapeType,
                        elementProperties: {
                            pageObjectId: args.pageObjectId,
                            size: {
                                width: { magnitude: args.width, unit: 'EMU' },
                                height: { magnitude: args.height, unit: 'EMU' },
                            },
                            transform: {
                                scaleX: 1,
                                scaleY: 1,
                                translateX: args.x,
                                translateY: args.y,
                                unit: 'EMU',
                            },
                        },
                    },
                },
            ];

            if (args.backgroundColor) {
                requests.push({
                    updateShapeProperties: {
                        objectId: elementId,
                        shapeProperties: {
                            shapeBackgroundFill: {
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
                        fields: 'shapeBackgroundFill',
                    },
                });
            }

            try {
                await slidesApi.presentations.batchUpdate({
                    presentationId: args.presentationId,
                    requestBody: { requests },
                });
                return JSON.stringify({ success: true, objectId: elementId, message: `Created ${args.shapeType} shape: ${elementId}` });
            } catch (error) {
                log.error(`Error creating shape: ${error.message || error}`);
                throw new UserError(`Failed to create shape: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
