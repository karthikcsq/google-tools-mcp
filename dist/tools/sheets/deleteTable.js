import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'deleteTable',
        description: 'Deletes a table from a spreadsheet. By default, only removes the table object and formatting while keeping the cell data. Optionally clears the data as well.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            tableIdentifier: z
                .string()
                .describe('The table name or table ID to delete. Use listTables to see available tables.'),
            deleteData: z
                .boolean()
                .optional()
                .default(false)
                .describe('If true, also clears the cell data in the table range. If false (default), only removes the table object and formatting.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Deleting table "${args.tableIdentifier}" from spreadsheet: ${args.spreadsheetId}`);
            try {
                // First resolve the table to get its ID and range
                const { table, sheetName } = await SheetsHelpers.resolveTableIdentifier(sheets, args.spreadsheetId, args.tableIdentifier);
                // Delete the table
                await SheetsHelpers.deleteTableHelper(sheets, args.spreadsheetId, table.tableId || '');
                // If deleteData is true, clear the range
                let clearedRange = null;
                if (args.deleteData && table.range) {
                    const range = `${sheetName}!${SheetsHelpers.rowColToA1(table.range.startRowIndex || 0, table.range.startColumnIndex || 0)}:${SheetsHelpers.rowColToA1((table.range.endRowIndex || 1) - 1, (table.range.endColumnIndex || 1) - 1)}`;
                    await SheetsHelpers.clearRange(sheets, args.spreadsheetId, range);
                    clearedRange = range;
                }
                return JSON.stringify({
                    url: `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`,
                    tableId: table.tableId,
                    name: table.name,
                    deleted: true,
                    dataCleared: args.deleteData,
                    clearedRange,
                    message: args.deleteData
                        ? `Table "${table.name}" deleted and data cleared.`
                        : `Table "${table.name}" deleted. Data preserved in range.`,
                }, null, 2);
            }
            catch (error) {
                log.error(`Error deleting table: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to delete table: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
