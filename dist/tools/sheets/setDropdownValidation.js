import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'setDropdownValidation',
        description: 'Adds or removes a dropdown list on a range of cells. Provide values to create a dropdown restricting input to those options. Omit values to remove dropdown validation from the range.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            range: z
                .string()
                .describe('A1 notation range to apply the dropdown to (e.g., "Sheet1!B2:B100" or "C2:C50").'),
            values: z
                .array(z.string())
                .optional()
                .describe('The allowed dropdown options (e.g., ["Open", "In Progress", "Done"]). Omit to remove existing dropdown validation from the range.'),
            strict: z
                .boolean()
                .optional()
                .default(true)
                .describe('If true, reject input that does not match one of the dropdown values.'),
            inputMessage: z
                .string()
                .optional()
                .describe('Help text shown when a cell with the dropdown is selected.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            const isClearing = !args.values || args.values.length === 0;
            log.info(isClearing
                ? `Clearing dropdown validation on "${args.range}" in spreadsheet ${args.spreadsheetId}`
                : `Setting dropdown validation on "${args.range}" with ${args.values.length} options in spreadsheet ${args.spreadsheetId}`);
            try {
                await SheetsHelpers.setDropdownValidation(sheets, args.spreadsheetId, args.range, args.values, args.strict, args.inputMessage);
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`;
                if (isClearing) {
                    return `${sheetUrl}\nSuccessfully removed dropdown validation from range "${args.range}".`;
                }
                return `${sheetUrl}\nSuccessfully added dropdown validation to range "${args.range}" with ${args.values.length} options: ${args.values.join(', ')}.`;
            }
            catch (error) {
                log.error(`Error setting dropdown validation: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to set dropdown validation: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
