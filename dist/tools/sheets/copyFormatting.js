import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'copyFormatting',
        description: 'Copies formatting (not values) from a source range to a destination range within the same spreadsheet. Copies bold, colors, borders, number formats, etc.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            sourceSheetName: z.string().min(1).describe('Source sheet/tab name (e.g., "Sheet1").'),
            sourceRange: z
                .string()
                .describe('A1 notation for the source range (e.g., "A1:D10"). Do not include the sheet name — use sourceSheetName instead.'),
            destinationSheetName: z
                .string()
                .min(1)
                .describe('Destination sheet/tab name (e.g., "Sheet2").'),
            destinationRange: z
                .string()
                .describe('A1 notation for the destination range (e.g., "A1:D10"). Do not include the sheet name — use destinationSheetName instead.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Copying formatting from ${args.sourceSheetName}!${args.sourceRange} to ${args.destinationSheetName}!${args.destinationRange} in spreadsheet ${args.spreadsheetId}`);
            try {
                // Resolve sheet names to numeric IDs
                const sourceSheetId = await SheetsHelpers.resolveSheetId(sheets, args.spreadsheetId, args.sourceSheetName);
                const destSheetId = await SheetsHelpers.resolveSheetId(sheets, args.spreadsheetId, args.destinationSheetName);
                // Convert A1 ranges to GridRange objects
                const sourceGridRange = SheetsHelpers.parseA1ToGridRange(args.sourceRange, sourceSheetId);
                const destGridRange = SheetsHelpers.parseA1ToGridRange(args.destinationRange, destSheetId);
                await sheets.spreadsheets.batchUpdate({
                    spreadsheetId: args.spreadsheetId,
                    requestBody: {
                        requests: [
                            {
                                copyPaste: {
                                    source: sourceGridRange,
                                    destination: destGridRange,
                                    pasteType: 'PASTE_FORMAT',
                                },
                            },
                        ],
                    },
                });
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`;
                return `${sheetUrl}\nSuccessfully copied formatting from ${args.sourceSheetName}!${args.sourceRange} to ${args.destinationSheetName}!${args.destinationRange}.`;
            }
            catch (error) {
                log.error(`Error copying formatting in spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to copy formatting: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
