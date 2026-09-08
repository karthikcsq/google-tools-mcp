import { UserError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient, getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
import { guardMutation } from '../../readTracker.js';
import {
    beginSheetsMutation,
    beginSheetsStructureMutation,
    prepareSheetValueTargets,
    ResourceReadHandleParameter,
} from '../../resourceHandles.js';
export function register(server) {
    server.addTool({
        name: 'deleteTable',
        description: 'Deletes a table from a spreadsheet. By default, only removes the table object and formatting while keeping the cell data. Optionally clears the data as well. Modern deleteData calls require a readSpreadsheet handle that contains the table data range; data-preserving deletes use getSpreadsheetInfo.',
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
            readHandle: ResourceReadHandleParameter,
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            const drive = await getDriveClient();
            let lease;
            log.info(`Deleting table "${args.tableIdentifier}" from spreadsheet: ${args.spreadsheetId}`);
            try {
                // Resolve the actual table range before reserving a value
                // handle. deleteData overwrites those cells, so a structure
                // handle alone must never authorize it.
                const { table, sheetName } = await SheetsHelpers.resolveTableIdentifier(sheets, args.spreadsheetId, args.tableIdentifier);
                let clearedRange = null;
                if (args.deleteData && table.range) {
                    const startRow = table.range.startRowIndex ?? 0;
                    const startColumn = table.range.startColumnIndex ?? 0;
                    const endRow = table.range.endRowIndex;
                    const endColumn = table.range.endColumnIndex;
                    if (!Number.isSafeInteger(endRow) || !Number.isSafeInteger(endColumn) || endRow <= startRow || endColumn <= startColumn) {
                        throw new UserError('The table does not expose a bounded data range. Call listTables and read the intended cells before deleting data.');
                    }
                    clearedRange = `'${sheetName.replace(/'/g, "''")}'!${SheetsHelpers.rowColToA1(startRow, startColumn)}:${SheetsHelpers.rowColToA1(endRow - 1, endColumn - 1)}`;
                }
                if (args.deleteData && !clearedRange) {
                    throw new UserError('The table does not expose a bounded data range. Call listTables and read the intended cells before deleting data.');
                }
                if (args.deleteData) {
                    const targets = await prepareSheetValueTargets(
                        sheets, args.spreadsheetId, [{ range: clearedRange }], { clear: true },
                    );
                    lease = await beginSheetsMutation({
                        spreadsheetId: args.spreadsheetId, readHandle: args.readHandle, drive, sheets, targets,
                        legacyGuard: () => guardMutation(args.spreadsheetId),
                    });
                } else {
                    lease = await beginSheetsStructureMutation({
                        spreadsheetId: args.spreadsheetId, readHandle: args.readHandle, drive, sheets,
                        legacyGuard: () => guardMutation(args.spreadsheetId),
                    });
                    if (!lease.structure.some((sheet) => sheet.tables.some((candidate) => candidate.tableId === table.tableId))) {
                        await lease.abort();
                        throw new UserError('The requested table is not present in the current spreadsheet structure. Call getSpreadsheetInfo again.');
                    }
                }
                // Both steps share one lease: a failure after table deletion is
                // uncertain, so the handle is invalidated rather than reused.
                await lease.write(async () => {
                    await SheetsHelpers.deleteTableHelper(sheets, args.spreadsheetId, table.tableId || '');
                    if (clearedRange) await SheetsHelpers.clearRange(sheets, args.spreadsheetId, clearedRange);
                    return null;
                });
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
                await lease?.abort();
                log.error(`Error deleting table: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw wrapOperationError('delete table', error, { status: error?.code });
            }
        },
    });
}
