import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'appendRows',
        description: 'Appends rows to the end of a sheet. Data is added after the last row with content in the specified range.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            range: z
                .string()
                .describe('A1 notation range indicating where to append (e.g., "A1" or "Sheet1!A1"). Data will be appended starting from this range.'),
            values: z
                .array(z.array(z.any()))
                .describe('2D array of values to append. Each inner array represents a row.'),
            valueInputOption: z
                .enum(['RAW', 'USER_ENTERED'])
                .optional()
                .default('USER_ENTERED')
                .describe('How input data should be interpreted. RAW: values are stored as-is. USER_ENTERED: values are parsed as if typed by a user.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Appending rows to spreadsheet ${args.spreadsheetId}, starting at: ${args.range}`);
            try {
                const response = await SheetsHelpers.appendValues(sheets, args.spreadsheetId, args.range, args.values, args.valueInputOption);
                const updatedCells = response.updates?.updatedCells || 0;
                const updatedRows = response.updates?.updatedRows || 0;
                const updatedRange = response.updates?.updatedRange || args.range;
                return `Successfully appended ${updatedRows} row(s) (${updatedCells} cells) to spreadsheet. Updated range: ${updatedRange}`;
            }
            catch (error) {
                log.error(`Error appending to spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to append to spreadsheet: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
