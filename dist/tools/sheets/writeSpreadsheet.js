import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'writeSpreadsheet',
        description: 'Writes data to a range in a spreadsheet, overwriting existing values. Use appendRows to add data without overwriting.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            range: z
                .string()
                .describe('A1 notation range to write to (e.g., "A1:B2" or "Sheet1!A1:B2").'),
            values: z
                .array(z.array(z.any()))
                .describe('2D array of values to write. Each inner array represents a row.'),
            valueInputOption: z
                .enum(['RAW', 'USER_ENTERED'])
                .optional()
                .default('USER_ENTERED')
                .describe('How input data should be interpreted. RAW: values are stored as-is. USER_ENTERED: values are parsed as if typed by a user.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Writing to spreadsheet ${args.spreadsheetId}, range: ${args.range}`);
            try {
                const response = await SheetsHelpers.writeRange(sheets, args.spreadsheetId, args.range, args.values, args.valueInputOption);
                const updatedCells = response.updatedCells || 0;
                const updatedRows = response.updatedRows || 0;
                const updatedColumns = response.updatedColumns || 0;
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`;
                return `${sheetUrl}\nSuccessfully wrote ${updatedCells} cells (${updatedRows} rows, ${updatedColumns} columns) to range ${args.range}.`;
            }
            catch (error) {
                log.error(`Error writing to spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to write to spreadsheet: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
