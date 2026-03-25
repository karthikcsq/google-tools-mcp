import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'getTable',
        description: 'Gets detailed information about a specific table including its columns, range, and properties. Use the table name or ID returned by listTables.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            tableIdentifier: z
                .string()
                .describe('The table name or table ID. Names are resolved first, then IDs. Use listTables to see available tables.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Getting table details for: ${args.tableIdentifier}`);
            try {
                const { table, sheetName, sheetId } = await SheetsHelpers.resolveTableIdentifier(sheets, args.spreadsheetId, args.tableIdentifier);
                // Build detailed table information
                const columns = table.columnProperties?.map((col) => ({
                    index: col.columnIndex,
                    name: col.columnName,
                })) || [];
                const range = table.range
                    ? `${sheetName}!${SheetsHelpers.rowColToA1(table.range.startRowIndex || 0, table.range.startColumnIndex || 0)}:${SheetsHelpers.rowColToA1((table.range.endRowIndex || 1) - 1, (table.range.endColumnIndex || 1) - 1)}`
                    : 'Unknown';
                return JSON.stringify({
                    tableId: table.tableId,
                    name: table.name,
                    sheetName,
                    sheetId,
                    range,
                    columns,
                    columnCount: table.columnProperties?.length || 0,
                }, null, 2);
            }
            catch (error) {
                log.error(`Error getting table details: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to get table details: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
