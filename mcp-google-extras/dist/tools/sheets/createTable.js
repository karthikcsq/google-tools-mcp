import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
// Column type enum matching Google Sheets API
const ColumnTypeSchema = z.enum([
    'TEXT',
    'NUMBER',
    'DATE',
    'DROPDOWN',
    'CHECKBOX',
    'PERCENT',
    'CURRENCY',
]);
export function register(server) {
    server.addTool({
        name: 'createTable',
        description: 'Creates a new named table with specific column types. Tables provide structured data with typed columns, automatic formatting, and special features like dropdown validation.',
        parameters: z
            .object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            name: z
                .string()
                .min(1)
                .describe('Unique name for the table within this spreadsheet. Table names must be unique.'),
            range: z
                .string()
                .describe('A1 notation range for the table (e.g., "Sheet1!A1:E10"). Must be within existing sheet boundaries.'),
            columns: z
                .array(z.object({
                columnName: z.string().min(1).describe('Display name for the column header.'),
                columnType: ColumnTypeSchema.optional().describe('Data type for the column (default: TEXT).'),
                dropdownValues: z
                    .array(z.string())
                    .optional()
                    .describe('Required for DROPDOWN type: list of dropdown options.'),
            }))
                .optional()
                .describe('Column definitions. If not specified, columns are auto-detected from first row.'),
            hasHeaderRow: z
                .boolean()
                .optional()
                .default(true)
                .describe('Whether the table has a header row (default: true).'),
            hasFooterRow: z
                .boolean()
                .optional()
                .default(false)
                .describe('Whether the table should have a footer row (default: false).'),
        })
            .refine((data) => {
            // Validate dropdown columns have values
            if (data.columns) {
                for (const col of data.columns) {
                    if (col.columnType === 'DROPDOWN' &&
                        (!col.dropdownValues || col.dropdownValues.length === 0)) {
                        return false;
                    }
                }
            }
            return true;
        }, {
            message: 'DROPDOWN column type requires dropdownValues to be specified with at least one option.',
            path: ['columns'],
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Creating table "${args.name}" in spreadsheet: ${args.spreadsheetId}`);
            try {
                // Parse the range to get sheet name and grid range
                const { sheetName, a1Range } = SheetsHelpers.parseRange(args.range);
                const sheetId = await SheetsHelpers.resolveSheetId(sheets, args.spreadsheetId, sheetName);
                const gridRange = SheetsHelpers.parseA1ToGridRange(a1Range, sheetId);
                // Build column properties if provided
                let columnProperties;
                if (args.columns && args.columns.length > 0) {
                    columnProperties = args.columns.map((col, index) => {
                        const prop = {
                            columnIndex: index,
                            columnName: col.columnName,
                        };
                        // Add data validation for DROPDOWN type
                        if (col.columnType === 'DROPDOWN' &&
                            col.dropdownValues &&
                            col.dropdownValues.length > 0) {
                            prop.dataValidationRule = {
                                condition: {
                                    type: 'ONE_OF_LIST',
                                    values: col.dropdownValues.map((v) => ({ userEnteredValue: v })),
                                },
                            };
                        }
                        return prop;
                    });
                }
                // Create the table
                const table = await SheetsHelpers.createTableHelper(sheets, args.spreadsheetId, {
                    name: args.name,
                    range: gridRange,
                    columnProperties,
                });
                return JSON.stringify({
                    tableId: table.tableId,
                    name: table.name,
                    range: args.range,
                    columnCount: table.columnProperties?.length || 0,
                    message: `Table "${args.name}" created successfully.`,
                }, null, 2);
            }
            catch (error) {
                log.error(`Error creating table: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to create table: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
