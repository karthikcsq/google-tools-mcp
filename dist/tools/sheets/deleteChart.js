import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
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
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Deleting chart ${args.chartId} from spreadsheet ${args.spreadsheetId}`);
            try {
                await sheets.spreadsheets.batchUpdate({
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
                });
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`;
                return `${sheetUrl}\nChart ${args.chartId} deleted successfully.`;
            }
            catch (error) {
                log.error(`Error deleting chart: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to delete chart: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
