import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'listTables',
        description: 'Lists all tables in a spreadsheet or specific sheet. Use this to discover table names and IDs before performing table operations.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            sheetName: z
                .string()
                .optional()
                .describe('Optional: filter tables to only those on this specific sheet.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Listing tables for spreadsheet: ${args.spreadsheetId}`);
            try {
                const tables = await SheetsHelpers.listAllTables(sheets, args.spreadsheetId, args.sheetName);
                if (tables.length === 0) {
                    return JSON.stringify({
                        spreadsheetId: args.spreadsheetId,
                        sheetFilter: args.sheetName || 'All sheets',
                        tables: [],
                        message: 'No tables found. Use createTable to create a table.',
                    }, null, 2);
                }
                const tableList = tables.map((item) => ({
                    tableId: item.table.tableId,
                    name: item.table.name,
                    sheetName: item.sheetName,
                    columnCount: item.table.columnProperties?.length || 0,
                    range: item.table.range
                        ? `${item.sheetName}!${SheetsHelpers.rowColToA1(item.table.range.startRowIndex || 0, item.table.range.startColumnIndex || 0)}:${SheetsHelpers.rowColToA1((item.table.range.endRowIndex || 1) - 1, (item.table.range.endColumnIndex || 1) - 1)}`
                        : 'Unknown',
                }));
                return JSON.stringify({
                    spreadsheetId: args.spreadsheetId,
                    sheetFilter: args.sheetName || 'All sheets',
                    count: tableList.length,
                    tables: tableList,
                }, null, 2);
            }
            catch (error) {
                log.error(`Error listing tables: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to list tables: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
