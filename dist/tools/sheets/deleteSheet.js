import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'deleteSheet',
        description: 'Deletes a sheet (tab) from a spreadsheet. Use getSpreadsheetInfo to find the numeric sheet ID.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            sheetId: z
                .number()
                .int()
                .describe('The numeric sheet ID to delete. Use getSpreadsheetInfo to find sheet IDs.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Deleting sheet ID ${args.sheetId} from spreadsheet ${args.spreadsheetId}`);
            try {
                await sheets.spreadsheets.batchUpdate({
                    spreadsheetId: args.spreadsheetId,
                    requestBody: {
                        requests: [
                            {
                                deleteSheet: {
                                    sheetId: args.sheetId,
                                },
                            },
                        ],
                    },
                });
                return `Successfully deleted sheet (ID: ${args.sheetId}) from spreadsheet.`;
            }
            catch (error) {
                log.error(`Error deleting sheet in spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to delete sheet: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
