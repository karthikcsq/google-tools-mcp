import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'deleteColumns',
        description: 'Deletes one or more columns from a Google Sheet. Columns are 1-based. Multiple ranges are processed right-to-left to avoid index shifting.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            sheetName: z
                .string()
                .optional()
                .describe('Name of the sheet/tab. Defaults to the first sheet if not provided.'),
            columns: z
                .array(z.object({
                startIndex: z
                    .number()
                    .int()
                    .min(1)
                    .describe('1-based column number of the first column to delete (inclusive).'),
                endIndex: z
                    .number()
                    .int()
                    .min(1)
                    .describe('1-based column number of the last column to delete (inclusive).'),
            }))
                .min(1)
                .describe('Array of column ranges to delete. Each entry is {startIndex, endIndex} using 1-based column numbers.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Deleting columns in spreadsheet ${args.spreadsheetId}`);
            try {
                const sheetId = await SheetsHelpers.resolveSheetId(sheets, args.spreadsheetId, args.sheetName);
                // Sort descending so right-to-left deletion avoids index shifting
                const sorted = [...args.columns].sort((a, b) => b.startIndex - a.startIndex);
                const requests = sorted.map(({ startIndex, endIndex }) => ({
                    deleteDimension: {
                        range: {
                            sheetId,
                            dimension: 'COLUMNS',
                            startIndex: startIndex - 1,
                            endIndex: endIndex,
                        },
                    },
                }));
                await sheets.spreadsheets.batchUpdate({
                    spreadsheetId: args.spreadsheetId,
                    requestBody: { requests },
                });
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`;
                const totalCols = args.columns.reduce((sum, { startIndex, endIndex }) => sum + (endIndex - startIndex + 1), 0);
                return `${sheetUrl}\nSuccessfully deleted ${totalCols} column(s) across ${args.columns.length} range(s).`;
            }
            catch (error) {
                log.error(`Error deleting columns: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to delete columns: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
