import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'autoResizeColumns',
        description: 'Auto-resizes columns in a spreadsheet to fit their content. Optionally restrict to a column range (e.g., "A:S"); defaults to all columns.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            sheetName: z
                .string()
                .optional()
                .describe('Name of the sheet/tab. Defaults to the first sheet if not provided.'),
            columns: z
                .string()
                .optional()
                .describe('Column range to resize in A1 notation (e.g., "A:S"). Omit to resize all columns.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Auto-resizing columns in spreadsheet ${args.spreadsheetId}`);
            try {
                const sheetId = await SheetsHelpers.resolveSheetId(sheets, args.spreadsheetId, args.sheetName);
                const dimensionRange = {
                    sheetId,
                    dimension: 'COLUMNS',
                };
                if (args.columns) {
                    const colonIdx = args.columns.indexOf(':');
                    if (colonIdx !== -1) {
                        dimensionRange.startIndex = SheetsHelpers.colLettersToIndex(args.columns.slice(0, colonIdx).trim());
                        dimensionRange.endIndex =
                            SheetsHelpers.colLettersToIndex(args.columns.slice(colonIdx + 1).trim()) + 1;
                    }
                    else {
                        const idx = SheetsHelpers.colLettersToIndex(args.columns.trim());
                        dimensionRange.startIndex = idx;
                        dimensionRange.endIndex = idx + 1;
                    }
                }
                await sheets.spreadsheets.batchUpdate({
                    spreadsheetId: args.spreadsheetId,
                    requestBody: {
                        requests: [
                            {
                                autoResizeDimensions: {
                                    dimensions: dimensionRange,
                                },
                            },
                        ],
                    },
                });
                const rangeDesc = args.columns ? `columns ${args.columns}` : 'all columns';
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`;
                return `${sheetUrl}\nSuccessfully auto-resized ${rangeDesc} to fit content.`;
            }
            catch (error) {
                log.error(`Error auto-resizing columns: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to auto-resize columns: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
