import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'updateTableRange',
        description: "Modifies a table's dimensions (add/remove rows and columns) by updating its range. The new range must include the original table range.",
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            tableIdentifier: z
                .string()
                .describe('The table name or table ID to update. Use listTables to see available tables.'),
            range: z
                .string()
                .describe('New A1 notation range for the table (e.g., "Sheet1!A1:F15"). Must include the original table range.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Updating table range for "${args.tableIdentifier}": ${args.range}`);
            try {
                // Resolve the table to get its current info
                const { table, sheetName } = await SheetsHelpers.resolveTableIdentifier(sheets, args.spreadsheetId, args.tableIdentifier);
                // Parse the new range
                const { a1Range } = SheetsHelpers.parseRange(args.range);
                const sheetId = await SheetsHelpers.resolveSheetId(sheets, args.spreadsheetId, sheetName || undefined);
                const newRange = SheetsHelpers.parseA1ToGridRange(a1Range, sheetId);
                // Update the table range
                const updatedTable = await SheetsHelpers.updateTableRangeHelper(sheets, args.spreadsheetId, table.tableId || '', newRange);
                return JSON.stringify({
                    url: `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`,
                    tableId: updatedTable.tableId,
                    name: updatedTable.name,
                    oldRange: table.range
                        ? `${SheetsHelpers.rowColToA1(table.range.startRowIndex || 0, table.range.startColumnIndex || 0)}:${SheetsHelpers.rowColToA1((table.range.endRowIndex || 1) - 1, (table.range.endColumnIndex || 1) - 1)}`
                        : 'Unknown',
                    newRange: args.range,
                    columnCount: updatedTable.columnProperties?.length || 0,
                    message: `Table "${updatedTable.name}" range updated successfully.`,
                }, null, 2);
            }
            catch (error) {
                log.error(`Error updating table range: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to update table range: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
