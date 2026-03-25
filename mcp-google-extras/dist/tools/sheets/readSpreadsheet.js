import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'readSpreadsheet',
        description: 'Reads data from a range in a spreadsheet. Returns rows as arrays. Use A1 notation for the range (e.g., "Sheet1!A1:C10").',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            range: z.string().describe('A1 notation range to read (e.g., "A1:B10" or "Sheet1!A1:B10").'),
            valueRenderOption: z
                .enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'])
                .optional()
                .default('FORMATTED_VALUE')
                .describe('How values should be rendered in the output.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Reading spreadsheet ${args.spreadsheetId}, range: ${args.range}`);
            try {
                const response = await SheetsHelpers.readRange(sheets, args.spreadsheetId, args.range, args.valueRenderOption);
                const values = response.values || [];
                return JSON.stringify({ range: args.range, values }, null, 2);
            }
            catch (error) {
                log.error(`Error reading spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to read spreadsheet: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
