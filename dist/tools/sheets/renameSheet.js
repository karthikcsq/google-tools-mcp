import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'renameSheet',
        description: 'Renames a sheet (tab) in a spreadsheet. Use getSpreadsheetInfo to find the numeric sheet ID.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            sheetId: z
                .number()
                .int()
                .describe('The numeric sheet ID to rename. Use getSpreadsheetInfo to find sheet IDs.'),
            newName: z.string().min(1).describe('The new name for the sheet.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Renaming sheet ID ${args.sheetId} to "${args.newName}" in spreadsheet ${args.spreadsheetId}`);
            try {
                await sheets.spreadsheets.batchUpdate({
                    spreadsheetId: args.spreadsheetId,
                    requestBody: {
                        requests: [
                            {
                                updateSheetProperties: {
                                    properties: {
                                        sheetId: args.sheetId,
                                        title: args.newName,
                                    },
                                    fields: 'title',
                                },
                            },
                        ],
                    },
                });
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`;
                return `${sheetUrl}\nSuccessfully renamed sheet (ID: ${args.sheetId}) to "${args.newName}".`;
            }
            catch (error) {
                log.error(`Error renaming sheet in spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to rename sheet: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
