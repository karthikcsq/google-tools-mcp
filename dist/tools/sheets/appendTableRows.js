import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'appendTableRows',
        description: 'Appends rows to the end of a table using table-aware insertion. This method respects footers and automatically inserts rows before the footer if one exists.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            tableIdentifier: z
                .string()
                .describe('The table name or table ID to append rows to. Use listTables to see available tables.'),
            values: z
                .array(z.array(z.any()))
                .min(1)
                .describe('2D array of values to append. Each inner array represents a row.'),
            valueInputOption: z
                .enum(['RAW', 'USER_ENTERED'])
                .optional()
                .default('USER_ENTERED')
                .describe('How input data should be interpreted. RAW: values are stored as-is. USER_ENTERED (default): values are parsed as if typed by a user.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Appending ${args.values.length} rows to table "${args.tableIdentifier}"`);
            try {
                // Resolve the table to get its ID
                const { table } = await SheetsHelpers.resolveTableIdentifier(sheets, args.spreadsheetId, args.tableIdentifier);
                // Append rows to the table
                const result = await SheetsHelpers.appendToTableHelper(sheets, args.spreadsheetId, table.tableId || '', args.values);
                return JSON.stringify({
                    url: `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`,
                    tableId: table.tableId,
                    name: table.name,
                    rowsAppended: result.rowsAppended,
                    updatedRange: result.updatedRange,
                    message: `Successfully appended ${result.rowsAppended} row(s) to table "${table.name}".`,
                }, null, 2);
            }
            catch (error) {
                log.error(`Error appending table rows: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to append table rows: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
