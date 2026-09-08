import { UserError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient, getSheetsClient } from '../../clients.js';
import { guardMutation } from '../../readTracker.js';
import { beginSheetsStructureMutation, ResourceReadHandleParameter } from '../../resourceHandles.js';
export function register(server) {
    server.addTool({
        name: 'deleteColumns',
        description: 'Deletes one or more columns from a Google Sheet. Columns are 1-based. Multiple ranges are processed right-to-left to avoid index shifting.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            sheetName: z
                .string()
                .optional()
                .describe('Name of the sheet/tab. Defaults to the first sheet if not provided.'),
            columns: z
                .array(z.object({
                startIndex: z
                    .number()
                    .int()
                    .min(1)
                    .describe('1-based column number of the first column to delete (inclusive).'),
                endIndex: z
                    .number()
                    .int()
                    .min(1)
                    .describe('1-based column number of the last column to delete (inclusive).'),
            }))
                .min(1)
                .describe('Array of column ranges to delete. Each entry is {startIndex, endIndex} using 1-based column numbers.'),
            readHandle: ResourceReadHandleParameter,
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            const drive = await getDriveClient();
            log.info(`Deleting columns in spreadsheet ${args.spreadsheetId}`);
            try {
                const lease = await beginSheetsStructureMutation({
                    spreadsheetId: args.spreadsheetId, readHandle: args.readHandle, drive, sheets,
                    legacyGuard: () => guardMutation(args.spreadsheetId),
                });
                const sheet = args.sheetName
                    ? lease.structure.find((candidate) => candidate.title === args.sheetName)
                    : lease.structure[0];
                if (!sheet) {
                    await lease.abort();
                    throw new UserError('The requested sheet is not present in the current spreadsheet structure. Call getSpreadsheetInfo again.');
                }
                const sheetId = sheet.sheetId;
                // Sort descending so right-to-left deletion avoids index shifting
                const sorted = [...args.columns].sort((a, b) => b.startIndex - a.startIndex);
                const requests = sorted.map(({ startIndex, endIndex }) => ({
                    deleteDimension: {
                        range: {
                            sheetId,
                            dimension: 'COLUMNS',
                            startIndex: startIndex - 1,
                            endIndex: endIndex,
                        },
                    },
                }));
                await lease.write(() => sheets.spreadsheets.batchUpdate({
                    spreadsheetId: args.spreadsheetId,
                    requestBody: { requests },
                }));
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`;
                const totalCols = args.columns.reduce((sum, { startIndex, endIndex }) => sum + (endIndex - startIndex + 1), 0);
                return `${sheetUrl}\nSuccessfully deleted ${totalCols} column(s) across ${args.columns.length} range(s).`;
            }
            catch (error) {
                log.error(`Error deleting columns: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw wrapOperationError('delete columns', error, { status: error?.code });
            }
        },
    });
}
