import { UserError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient, getSheetsClient } from '../../clients.js';
import { trackRead } from '../../readTracker.js';
import { mintSheetsReadHandle, readSheetsStructureBaseline } from '../../resourceHandles.js';
export function register(server) {
    server.addTool({
        name: 'getSpreadsheetInfo',
        description: 'Gets metadata about a spreadsheet including its title, URL, and a list of all sheets with their dimensions.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            const drive = await getDriveClient();
            log.info(`Getting info for spreadsheet: ${args.spreadsheetId}`);
            try {
                const baseline = await readSheetsStructureBaseline({ drive, sheets, spreadsheetId: args.spreadsheetId });
                trackRead(args.spreadsheetId);
                await mintSheetsReadHandle(args.spreadsheetId, baseline);
                const sheetList = baseline.sheets || [];
                return JSON.stringify({
                    title: baseline.title,
                    id: args.spreadsheetId,
                    url: `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}`,
                    sheets: sheetList.map((sheet) => {
                        return {
                            title: sheet.title,
                            sheetId: sheet.sheetId,
                            rows: sheet.rowCount,
                            columns: sheet.columnCount,
                            hidden: sheet.hidden,
                            charts: sheet.charts.map((chart) => ({ chartId: chart.chartId, position: chart.position })),
                            tables: sheet.tables.map((table) => ({ tableId: table.tableId, name: table.name, range: table.range })),
                        };
                    }),
                }, null, 2);
            }
            catch (error) {
                log.error(`Error getting spreadsheet info ${args.spreadsheetId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw wrapOperationError('get spreadsheet info', error, { status: error?.code });
            }
        },
    });
}
