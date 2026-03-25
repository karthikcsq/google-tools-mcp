import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'duplicateSheet',
        description: 'Duplicates a sheet (tab) within a spreadsheet, copying all values, formulas, formatting, validations, and conditional formatting. Use getSpreadsheetInfo to find the numeric sheet ID.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            sheetId: z
                .number()
                .int()
                .describe('The numeric sheet ID to duplicate. Use getSpreadsheetInfo to find sheet IDs.'),
            newSheetName: z
                .string()
                .min(1)
                .optional()
                .describe('Name for the duplicated sheet. If omitted, Google auto-names it "Copy of <original>".'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Duplicating sheet ID ${args.sheetId} in spreadsheet ${args.spreadsheetId}${args.newSheetName ? ` as "${args.newSheetName}"` : ''}`);
            try {
                const response = await sheets.spreadsheets.batchUpdate({
                    spreadsheetId: args.spreadsheetId,
                    requestBody: {
                        requests: [
                            {
                                duplicateSheet: {
                                    sourceSheetId: args.sheetId,
                                    newSheetName: args.newSheetName,
                                },
                            },
                        ],
                    },
                });
                const duplicatedSheet = response.data.replies?.[0]?.duplicateSheet?.properties;
                if (!duplicatedSheet) {
                    throw new UserError('Failed to duplicate sheet - no sheet properties returned.');
                }
                return `Successfully duplicated sheet as "${duplicatedSheet.title}" (Sheet ID: ${duplicatedSheet.sheetId}).`;
            }
            catch (error) {
                log.error(`Error duplicating sheet in spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to duplicate sheet: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
