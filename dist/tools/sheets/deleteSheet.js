import { UserError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient, getSheetsClient } from '../../clients.js';
import { guardMutation } from '../../readTracker.js';
import { beginSheetsStructureMutation, ResourceReadHandleParameter } from '../../resourceHandles.js';
export function register(server) {
    server.addTool({
        name: 'deleteSheet',
        description: 'Deletes a sheet (tab) from a spreadsheet. Use getSpreadsheetInfo to find the numeric sheet ID.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            sheetId: z
                .number()
                .int()
                .describe('The numeric sheet ID to delete. Use getSpreadsheetInfo to find sheet IDs.'),
            readHandle: ResourceReadHandleParameter,
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            const drive = await getDriveClient();
            log.info(`Deleting sheet ID ${args.sheetId} from spreadsheet ${args.spreadsheetId}`);
            try {
                const lease = await beginSheetsStructureMutation({
                    spreadsheetId: args.spreadsheetId, readHandle: args.readHandle, drive, sheets,
                    legacyGuard: () => guardMutation(args.spreadsheetId),
                });
                if (!lease.structure.some((sheet) => sheet.sheetId === args.sheetId)) {
                    await lease.abort();
                    throw new UserError('The requested sheet is not present in the current spreadsheet structure. Call getSpreadsheetInfo again.');
                }
                await lease.write(() => sheets.spreadsheets.batchUpdate({
                    spreadsheetId: args.spreadsheetId,
                    requestBody: {
                        requests: [
                            {
                                deleteSheet: {
                                    sheetId: args.sheetId,
                                },
                            },
                        ],
                    },
                }));
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`;
                return `${sheetUrl}\nSuccessfully deleted sheet (ID: ${args.sheetId}) from spreadsheet.`;
            }
            catch (error) {
                log.error(`Error deleting sheet in spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw wrapOperationError('delete sheet', error, { status: error?.code });
            }
        },
    });
}
