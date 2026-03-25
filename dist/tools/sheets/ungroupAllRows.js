import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'ungroupAllRows',
        description: 'Removes all row groupings from a sheet by deleting the entire row dimension group. Use before re-running groupRows to prevent duplicate collapse widgets from accumulating across report refreshes.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            sheetName: z
                .string()
                .optional()
                .describe('Name of the sheet/tab. Defaults to the first sheet if not provided.'),
            totalRows: z
                .number()
                .int()
                .optional()
                .default(500)
                .describe('Number of rows to clear groups from (default: 500). Set higher if the sheet has more rows.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Removing all row groups from spreadsheet ${args.spreadsheetId}`);
            try {
                const sheetId = await SheetsHelpers.resolveSheetId(sheets, args.spreadsheetId, args.sheetName);
                const totalRows = args.totalRows ?? 500;
                const request = {
                    deleteDimensionGroup: {
                        range: {
                            sheetId,
                            dimension: 'ROWS',
                            startIndex: 0,
                            endIndex: totalRows,
                        },
                    },
                };
                // deleteDimensionGroup removes one level at a time; call repeatedly until no groups remain
                let removed = 0;
                // eslint-disable-next-line no-constant-condition
                while (true) {
                    try {
                        await sheets.spreadsheets.batchUpdate({
                            spreadsheetId: args.spreadsheetId,
                            requestBody: { requests: [request] },
                        });
                        removed++;
                    }
                    catch (err) {
                        // When no groups remain the API returns an error — treat as done
                        break;
                    }
                }
                return `Successfully removed all row groups (${removed} level(s) cleared).`;
            }
            catch (error) {
                log.error(`Error removing row groups: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to remove row groups: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
