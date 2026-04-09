import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'formatCells',
        description: "Applies formatting to a range of cells in a spreadsheet. Supports bold, italic, font size, text color, background color, alignment, and number format. Use range '1:1' to format an entire header row, 'A:A' for an entire column, or 'A1:D1' for specific cells. Use numberFormat to control how values are displayed (e.g. as numbers, text, dates) or to clear a format by setting type to 'TEXT'.",
        parameters: z
            .object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            range: z
                .string()
                .describe('A1 notation range to format. Examples: "Sheet1!A1:D1", "1:1" (entire row 1), "A:A" (entire column A), "B2:E10".'),
            bold: z.boolean().optional().describe('Apply bold text formatting.'),
            italic: z.boolean().optional().describe('Apply italic text formatting.'),
            fontSize: z.number().min(1).optional().describe('Font size in points.'),
            foregroundColor: z.string().optional().describe('Text color as hex (e.g., "#FF0000").'),
            backgroundColor: z
                .string()
                .optional()
                .describe('Cell background color as hex (e.g., "#D9EAD3").'),
            horizontalAlignment: z
                .enum(['LEFT', 'CENTER', 'RIGHT'])
                .optional()
                .describe('Horizontal text alignment.'),
            numberFormat: z
                .object({
                type: z
                    .enum([
                    'TEXT',
                    'NUMBER',
                    'PERCENT',
                    'CURRENCY',
                    'DATE',
                    'TIME',
                    'DATE_TIME',
                    'SCIENTIFIC',
                ])
                    .describe('Number format type. Use "TEXT" to treat cells as plain text (also clears any existing date/number format). Use "NUMBER" for general numeric display.'),
                pattern: z
                    .string()
                    .optional()
                    .describe('Optional custom format pattern (e.g., "0.00", "#,##0", "yyyy-MM-dd"). If omitted, the default pattern for the type is used.'),
            })
                .optional()
                .describe('Controls how cell values are displayed. Useful for clearing date formatting (set type to "TEXT") or applying a custom number pattern.'),
        })
            .refine((data) => data.bold !== undefined ||
            data.italic !== undefined ||
            data.fontSize !== undefined ||
            data.foregroundColor !== undefined ||
            data.backgroundColor !== undefined ||
            data.horizontalAlignment !== undefined ||
            data.numberFormat !== undefined, { message: 'At least one formatting option must be provided.' }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Formatting cells in range "${args.range}" of spreadsheet ${args.spreadsheetId}`);
            try {
                // Build the format object expected by the helper
                const format = {};
                if (args.backgroundColor) {
                    const rgb = SheetsHelpers.hexToRgb(args.backgroundColor);
                    if (!rgb)
                        throw new UserError(`Invalid background color: "${args.backgroundColor}".`);
                    format.backgroundColor = rgb;
                }
                const hasTextFormat = args.bold !== undefined ||
                    args.italic !== undefined ||
                    args.fontSize !== undefined ||
                    args.foregroundColor !== undefined;
                if (hasTextFormat) {
                    format.textFormat = {};
                    if (args.bold !== undefined)
                        format.textFormat.bold = args.bold;
                    if (args.italic !== undefined)
                        format.textFormat.italic = args.italic;
                    if (args.fontSize !== undefined)
                        format.textFormat.fontSize = args.fontSize;
                    if (args.foregroundColor) {
                        const rgb = SheetsHelpers.hexToRgb(args.foregroundColor);
                        if (!rgb)
                            throw new UserError(`Invalid foreground color: "${args.foregroundColor}".`);
                        format.textFormat.foregroundColor = rgb;
                    }
                }
                if (args.horizontalAlignment) {
                    format.horizontalAlignment = args.horizontalAlignment;
                }
                if (args.numberFormat) {
                    format.numberFormat = args.numberFormat;
                }
                await SheetsHelpers.formatCells(sheets, args.spreadsheetId, args.range, format);
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`;
                return `${sheetUrl}\nSuccessfully applied formatting to range "${args.range}".`;
            }
            catch (error) {
                log.error(`Error formatting cells: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to format cells: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
