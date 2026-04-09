import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'batchWrite',
        description: 'Writes data to multiple ranges in a single API call. More efficient than multiple separate writeSpreadsheet calls when updating several ranges at once.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            data: z
                .array(z.object({
                range: z.string().describe('A1 notation range (e.g., "Sheet1!A1:B2").'),
                values: z
                    .array(z.array(z.any()))
                    .describe('2D array of values to write. Each inner array represents a row.'),
            }))
                .min(1)
                .describe('Array of range+values pairs to write in a single batch.'),
            valueInputOption: z
                .enum(['RAW', 'USER_ENTERED'])
                .optional()
                .default('USER_ENTERED')
                .describe('How input data should be interpreted. RAW: values are stored as-is. USER_ENTERED: values are parsed as if typed by a user.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            const rangeNames = args.data.map((d) => d.range).join(', ');
            log.info(`Batch writing to ${args.data.length} range(s) in spreadsheet ${args.spreadsheetId}: ${rangeNames}`);
            try {
                const response = await sheets.spreadsheets.values.batchUpdate({
                    spreadsheetId: args.spreadsheetId,
                    requestBody: {
                        valueInputOption: args.valueInputOption,
                        data: args.data.map((d) => ({ range: d.range, values: d.values })),
                    },
                });
                const totalCells = response.data.totalUpdatedCells || 0;
                const totalRows = response.data.totalUpdatedRows || 0;
                const totalColumns = response.data.totalUpdatedColumns || 0;
                const totalSheets = response.data.totalUpdatedSheets || 0;
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`;
                return `${sheetUrl}\nSuccessfully batch-wrote ${totalCells} cells (${totalRows} rows, ${totalColumns} columns) across ${totalSheets} sheet(s) in ${args.data.length} range(s).`;
            }
            catch (error) {
                log.error(`Error batch writing to spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                if (error.code === 404) {
                    throw new UserError(`Spreadsheet not found (ID: ${args.spreadsheetId}). Check the ID.`);
                }
                if (error.code === 403) {
                    throw new UserError(`Permission denied for spreadsheet (ID: ${args.spreadsheetId}). Ensure you have write access.`);
                }
                throw new UserError(`Failed to batch write to spreadsheet: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
