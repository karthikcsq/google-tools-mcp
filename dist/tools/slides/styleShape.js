import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSlidesClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'styleSlidesShape',
        description:
            'Style a shape in Google Slides: set background color, outline color/weight/dash style.',
        parameters: z.object({
            presentationId: z.string().describe('Presentation ID'),
            objectId: z.string().describe('Shape object ID'),
            backgroundColor: z
                .object({
                    red: z.number().min(0).max(1).optional(),
                    green: z.number().min(0).max(1).optional(),
                    blue: z.number().min(0).max(1).optional(),
                    alpha: z.number().min(0).max(1).optional(),
                })
                .optional()
                .describe('Fill color (RGBA 0-1)'),
            outlineColor: z
                .object({
                    red: z.number().min(0).max(1).optional(),
                    green: z.number().min(0).max(1).optional(),
                    blue: z.number().min(0).max(1).optional(),
                })
                .optional()
                .describe('Outline color (RGB 0-1)'),
            outlineWeight: z.number().optional().describe('Outline thickness in points'),
            outlineDashStyle: z
                .enum(['SOLID', 'DOT', 'DASH', 'DASH_DOT', 'LONG_DASH', 'LONG_DASH_DOT'])
                .optional()
                .describe('Outline dash style'),
        }),
        execute: async (args, { log }) => {
            const slidesApi = await getSlidesClient();
            const shapeProperties = {};
            const fields = [];

            if (args.backgroundColor) {
                shapeProperties.shapeBackgroundFill = {
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
                };
                fields.push('shapeBackgroundFill');
            }

            const outline = {};
            let hasOutline = false;

            if (args.outlineColor) {
                outline.outlineFill = {
                    solidFill: {
                        color: {
                            rgbColor: {
                                red: args.outlineColor.red || 0,
                                green: args.outlineColor.green || 0,
                                blue: args.outlineColor.blue || 0,
                            },
                        },
                    },
                };
                hasOutline = true;
            }
            if (args.outlineWeight !== undefined) {
                outline.weight = { magnitude: args.outlineWeight, unit: 'PT' };
                hasOutline = true;
            }
            if (args.outlineDashStyle) {
                outline.dashStyle = args.outlineDashStyle;
                hasOutline = true;
            }
            if (hasOutline) {
                shapeProperties.outline = outline;
                fields.push('outline');
            }

            if (fields.length === 0) throw new UserError('No styling options specified');

            try {
                await slidesApi.presentations.batchUpdate({
                    presentationId: args.presentationId,
                    requestBody: {
                        requests: [
                            {
                                updateShapeProperties: {
                                    objectId: args.objectId,
                                    shapeProperties,
                                    fields: fields.join(','),
                                },
                            },
                        ],
                    },
                });
                return JSON.stringify({ success: true, message: `Applied styling to shape ${args.objectId}` });
            } catch (error) {
                log.error(`Error styling shape: ${error.message || error}`);
                throw new UserError(`Failed to style shape: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
