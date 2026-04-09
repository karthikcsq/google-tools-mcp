import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'clearRange',
        description: 'Clears all cell values in a range without deleting the cells themselves. Formatting is preserved.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            range: z.string().describe('A1 notation range to clear (e.g., "A1:B10" or "Sheet1!A1:B10").'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Clearing range ${args.range} in spreadsheet ${args.spreadsheetId}`);
            try {
                const response = await SheetsHelpers.clearRange(sheets, args.spreadsheetId, args.range);
                const clearedRange = response.clearedRange || args.range;
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`;
                return `${sheetUrl}\nSuccessfully cleared range ${clearedRange}.`;
            }
            catch (error) {
                log.error(`Error clearing range in spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to clear range: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
