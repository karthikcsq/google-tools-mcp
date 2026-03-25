import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'groupRows',
        description: 'Creates collapsible row groups in a Google Sheet using the Sheets API addDimensionGroup request. Each group specifies a range of rows (1-based, inclusive) to collapse.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            sheetName: z
                .string()
                .optional()
                .describe('Name of the sheet/tab. Defaults to the first sheet if not provided.'),
            groups: z
                .array(z.object({
                startRowIndex: z
                    .number()
                    .int()
                    .describe('1-based row number of the first row in the group (inclusive).'),
                endRowIndex: z
                    .number()
                    .int()
                    .describe('1-based row number of the last row in the group (inclusive).'),
            }))
                .min(1)
                .describe('Array of row ranges to group. Each entry is {startRowIndex, endRowIndex} using 1-based row numbers.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Grouping rows in spreadsheet ${args.spreadsheetId}`);
            try {
                const sheetId = await SheetsHelpers.resolveSheetId(sheets, args.spreadsheetId, args.sheetName);
                // Convert 1-based inclusive row numbers to 0-based exclusive indices
                // required by the Sheets API DimensionRange
                const requests = args.groups.map(({ startRowIndex, endRowIndex }) => ({
                    addDimensionGroup: {
                        range: {
                            sheetId,
                            dimension: 'ROWS',
                            startIndex: startRowIndex - 1, // 0-based, inclusive
                            endIndex: endRowIndex, // 0-based, exclusive (= 1-based inclusive)
                        },
                    },
                }));
                await sheets.spreadsheets.batchUpdate({
                    spreadsheetId: args.spreadsheetId,
                    requestBody: { requests },
                });
                return `Successfully created ${args.groups.length} row group(s).`;
            }
            catch (error) {
                log.error(`Error grouping rows: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to group rows: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
