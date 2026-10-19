import { UserError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient, getSheetsClient } from '../../clients.js';
import { guardMutation } from '../../readTracker.js';
import { beginSheetsStructureMutation, ResourceReadHandleParameter } from '../../resourceHandles.js';
export function register(server) {
    server.addTool({
        name: 'deleteChart',
        description: 'Deletes a chart from a Google Spreadsheet by chart ID. ' +
            'The chart ID is returned when a chart is created with insertChart.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            chartId: z.number().int().describe('The numeric chart ID to delete.'),
            readHandle: ResourceReadHandleParameter,
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            const drive = await getDriveClient();
            log.info(`Deleting chart ${args.chartId} from spreadsheet ${args.spreadsheetId}`);
            try {
                const lease = await beginSheetsStructureMutation({
                    spreadsheetId: args.spreadsheetId, readHandle: args.readHandle, drive, sheets,
                    legacyGuard: () => guardMutation(args.spreadsheetId),
                });
                if (!lease.structure.some((sheet) => sheet.charts.some((chart) => chart.chartId === args.chartId))) {
                    await lease.abort();
                    throw new UserError('The requested chart is not present in the current spreadsheet structure. Call getSpreadsheetInfo again.');
                }
                await lease.write(() => sheets.spreadsheets.batchUpdate({
                    spreadsheetId: args.spreadsheetId,
                    requestBody: {
                        requests: [
                            {
                                deleteEmbeddedObject: {
                                    objectId: args.chartId,
                                },
                            },
                        ],
                    },
                }));
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`;
                return `${sheetUrl}\nChart ${args.chartId} deleted successfully.`;
            }
            catch (error) {
                log.error(`Error deleting chart: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw wrapOperationError('delete chart', error, { status: error?.code });
            }
        },
    });
}
