import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'setColumnWidths',
        description: 'Sets the width (in pixels) of one or more columns in a spreadsheet. Accepts multiple column specs in a single call, each targeting a single column or a contiguous range (e.g., "A", "B:D").',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            sheetName: z
                .string()
                .optional()
                .describe('Name of the sheet/tab. Defaults to the first sheet if not provided.'),
            columnWidths: z
                .array(z.object({
                column: z
                    .string()
                    .describe('Column or column range in A1 notation (e.g., "A", "B:D").'),
                width: z.number().int().min(0).describe('Width in pixels. Use 0 to hide the column.'),
            }))
                .min(1)
                .describe('List of column width specifications to apply.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Setting column widths in spreadsheet ${args.spreadsheetId}`);
            try {
                await SheetsHelpers.setColumnWidths(sheets, args.spreadsheetId, args.sheetName, args.columnWidths);
                const summary = args.columnWidths.map((cw) => `${cw.column}=${cw.width}px`).join(', ');
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`;
                return `${sheetUrl}\nSuccessfully set column widths: ${summary}.`;
            }
            catch (error) {
                log.error(`Error setting column widths: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to set column widths: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
