import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
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
            log.info(`Getting info for spreadsheet: ${args.spreadsheetId}`);
            try {
                const metadata = await SheetsHelpers.getSpreadsheetMetadata(sheets, args.spreadsheetId);
                const sheetList = metadata.sheets || [];
                return JSON.stringify({
                    title: metadata.properties?.title || 'Untitled',
                    id: metadata.spreadsheetId,
                    url: `https://docs.google.com/spreadsheets/d/${metadata.spreadsheetId}`,
                    sheets: sheetList.map((sheet) => {
                        const props = sheet.properties;
                        return {
                            title: props?.title || 'Untitled',
                            sheetId: props?.sheetId,
                            rows: props?.gridProperties?.rowCount || 0,
                            columns: props?.gridProperties?.columnCount || 0,
                            hidden: props?.hidden || false,
                        };
                    }),
                }, null, 2);
            }
            catch (error) {
                log.error(`Error getting spreadsheet info ${args.spreadsheetId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to get spreadsheet info: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
