import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSlidesClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'formatSlidesText',
        description:
            'Apply text formatting (bold, italic, underline, font size, color, etc.) to a text element in Google Slides. Use getPresentation to find element objectIds first.',
        parameters: z.object({
            presentationId: z.string().describe('Presentation ID'),
            objectId: z.string().describe('Object ID of the text element'),
            startIndex: z.number().min(0).optional().describe('Start character index (0-based). Omit with endIndex to format all text.'),
            endIndex: z.number().min(0).optional().describe('End character index (0-based)'),
            bold: z.boolean().optional().describe('Make text bold'),
            italic: z.boolean().optional().describe('Make text italic'),
            underline: z.boolean().optional().describe('Underline text'),
            strikethrough: z.boolean().optional().describe('Strikethrough text'),
            fontSize: z.number().optional().describe('Font size in points'),
            fontFamily: z.string().optional().describe('Font family name (e.g. "Arial", "Roboto")'),
            foregroundColor: z
                .object({
                    red: z.number().min(0).max(1).optional(),
                    green: z.number().min(0).max(1).optional(),
                    blue: z.number().min(0).max(1).optional(),
                })
                .optional()
                .describe('Text color as RGB values (0-1)'),
        }),
        execute: async (args, { log }) => {
            const slidesApi = await getSlidesClient();

            const textStyle = {};
            const fields = [];

            if (args.bold !== undefined) { textStyle.bold = args.bold; fields.push('bold'); }
            if (args.italic !== undefined) { textStyle.italic = args.italic; fields.push('italic'); }
            if (args.underline !== undefined) { textStyle.underline = args.underline; fields.push('underline'); }
            if (args.strikethrough !== undefined) { textStyle.strikethrough = args.strikethrough; fields.push('strikethrough'); }
            if (args.fontSize !== undefined) {
                textStyle.fontSize = { magnitude: args.fontSize, unit: 'PT' };
                fields.push('fontSize');
            }
            if (args.fontFamily !== undefined) { textStyle.fontFamily = args.fontFamily; fields.push('fontFamily'); }
            if (args.foregroundColor) {
                textStyle.foregroundColor = {
                    opaqueColor: {
                        rgbColor: {
                            red: args.foregroundColor.red || 0,
                            green: args.foregroundColor.green || 0,
                            blue: args.foregroundColor.blue || 0,
                        },
                    },
                };
                fields.push('foregroundColor');
            }

            if (fields.length === 0) throw new UserError('No formatting options specified');

            const request = {
                updateTextStyle: {
                    objectId: args.objectId,
                    style: textStyle,
                    fields: fields.join(','),
                    textRange:
                        args.startIndex !== undefined && args.endIndex !== undefined
                            ? { type: 'FIXED_RANGE', startIndex: args.startIndex, endIndex: args.endIndex }
                            : { type: 'ALL' },
                },
            };

            try {
                await slidesApi.presentations.batchUpdate({
                    presentationId: args.presentationId,
                    requestBody: { requests: [request] },
                });
                return JSON.stringify({ success: true, message: `Applied text formatting to ${args.objectId}` });
            } catch (error) {
                log.error(`Error formatting text: ${error.message || error}`);
                throw new UserError(`Failed to format text: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
