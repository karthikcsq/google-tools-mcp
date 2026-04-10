import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSlidesClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'createSlidesTextBox',
        description:
            'Create a text box on a slide in Google Slides. Position and size are in EMU (English Metric Units: 914400 EMU = 1 inch).',
        parameters: z.object({
            presentationId: z.string().describe('Presentation ID'),
            pageObjectId: z.string().describe('Slide page object ID'),
            text: z.string().describe('Text content'),
            x: z.number().describe('X position in EMU'),
            y: z.number().describe('Y position in EMU'),
            width: z.number().describe('Width in EMU'),
            height: z.number().describe('Height in EMU'),
            fontSize: z.number().optional().describe('Font size in points'),
            bold: z.boolean().optional().describe('Make text bold'),
            italic: z.boolean().optional().describe('Make text italic'),
        }),
        execute: async (args, { log }) => {
            const slidesApi = await getSlidesClient();
            const elementId = `textBox_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

            const requests = [
                {
                    createShape: {
                        objectId: elementId,
                        shapeType: 'TEXT_BOX',
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
                {
                    insertText: { objectId: elementId, text: args.text, insertionIndex: 0 },
                },
            ];

            // Optional formatting
            const textStyle = {};
            const fields = [];
            if (args.fontSize) { textStyle.fontSize = { magnitude: args.fontSize, unit: 'PT' }; fields.push('fontSize'); }
            if (args.bold !== undefined) { textStyle.bold = args.bold; fields.push('bold'); }
            if (args.italic !== undefined) { textStyle.italic = args.italic; fields.push('italic'); }

            if (fields.length > 0) {
                requests.push({
                    updateTextStyle: {
                        objectId: elementId,
                        style: textStyle,
                        fields: fields.join(','),
                        textRange: { type: 'ALL' },
                    },
                });
            }

            try {
                await slidesApi.presentations.batchUpdate({
                    presentationId: args.presentationId,
                    requestBody: { requests },
                });
                return JSON.stringify({ success: true, objectId: elementId, message: `Created text box: ${elementId}` });
            } catch (error) {
                log.error(`Error creating text box: ${error.message || error}`);
                throw new UserError(`Failed to create text box: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
