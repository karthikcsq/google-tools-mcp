import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'addSheet',
        description: "Adds a new sheet (tab) to an existing spreadsheet. Returns the new sheet's title and ID.",
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            sheetTitle: z.string().min(1).describe('Title for the new sheet/tab.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Adding sheet "${args.sheetTitle}" to spreadsheet ${args.spreadsheetId}`);
            try {
                const response = await SheetsHelpers.addSheet(sheets, args.spreadsheetId, args.sheetTitle);
                const addedSheet = response.replies?.[0]?.addSheet?.properties;
                if (!addedSheet) {
                    throw new UserError('Failed to add sheet - no sheet properties returned.');
                }
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`;
                return `${sheetUrl}\nSuccessfully added sheet "${addedSheet.title}" (Sheet ID: ${addedSheet.sheetId}) to spreadsheet.`;
            }
            catch (error) {
                log.error(`Error adding sheet to spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to add sheet: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
