import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'freezeRowsAndColumns',
        description: 'Pins rows and/or columns so they stay visible when scrolling. Use frozenRows=1 to freeze a header row. Set a value to 0 to unfreeze.',
        parameters: z
            .object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            sheetName: z
                .string()
                .optional()
                .describe('Name of the sheet/tab. Defaults to the first sheet if not provided.'),
            frozenRows: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe('Number of rows to freeze from the top (e.g., 1 for a header row). Set to 0 to unfreeze rows.'),
            frozenColumns: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe('Number of columns to freeze from the left. Set to 0 to unfreeze columns.'),
        })
            .refine((data) => data.frozenRows !== undefined || data.frozenColumns !== undefined, {
            message: 'At least one of frozenRows or frozenColumns must be provided.',
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Freezing rows=${args.frozenRows ?? 'unchanged'}, cols=${args.frozenColumns ?? 'unchanged'} in spreadsheet ${args.spreadsheetId}`);
            try {
                await SheetsHelpers.freezeRowsAndColumns(sheets, args.spreadsheetId, args.sheetName, args.frozenRows, args.frozenColumns);
                const parts = [];
                if (args.frozenRows !== undefined) {
                    parts.push(args.frozenRows === 0 ? 'unfroze rows' : `froze top ${args.frozenRows} row(s)`);
                }
                if (args.frozenColumns !== undefined) {
                    parts.push(args.frozenColumns === 0
                        ? 'unfroze columns'
                        : `froze left ${args.frozenColumns} column(s)`);
                }
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`;
                return `${sheetUrl}\nSuccessfully ${parts.join(' and ')}.`;
            }
            catch (error) {
                log.error(`Error freezing rows/columns: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to freeze rows/columns: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
