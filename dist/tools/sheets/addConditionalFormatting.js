import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
const ONE_VALUE_CONDITIONS = [
    'NUMBER_GREATER',
    'NUMBER_GREATER_THAN_EQ',
    'NUMBER_LESS',
    'NUMBER_LESS_THAN_EQ',
    'NUMBER_EQ',
    'NUMBER_NOT_EQ',
    'CUSTOM_FORMULA',
];
const TWO_VALUE_CONDITIONS = ['NUMBER_BETWEEN', 'NUMBER_NOT_BETWEEN'];
const NO_VALUE_CONDITIONS = ['BLANK', 'NOT_BLANK'];
const ALL_CONDITION_TYPES = [
    ...ONE_VALUE_CONDITIONS,
    ...TWO_VALUE_CONDITIONS,
    ...NO_VALUE_CONDITIONS,
];
export function register(server) {
    server.addTool({
        name: 'addConditionalFormatting',
        description: 'Adds a conditional formatting rule to one or more ranges in a spreadsheet. Applies a format (background color, bold, text color, etc.) when cells meet a specified condition. Use CUSTOM_FORMULA for complex conditions like "=$A1>$B1". Note: each call appends a new rule — use deleteConditionalFormatting to remove existing rules before re-adding.',
        parameters: z
            .object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            sheetName: z
                .string()
                .optional()
                .describe('Name of the sheet/tab. Defaults to the first sheet if not provided.'),
            ranges: z
                .array(z.string())
                .min(1)
                .describe('One or more A1 notation ranges the rule applies to (e.g., ["B2:S68"] or ["A1:A10", "C1:C10"]).'),
            conditionType: z
                .enum(ALL_CONDITION_TYPES)
                .describe('The condition type. ' +
                'NUMBER_* types compare cell values numerically. ' +
                'CUSTOM_FORMULA evaluates a formula (e.g., "=$A1>10"). ' +
                'BLANK/NOT_BLANK check whether a cell is empty.'),
            conditionValues: z
                .array(z.string())
                .optional()
                .describe('Values for the condition. ' +
                'Omit or pass [] for BLANK and NOT_BLANK. ' +
                'Pass one value for all NUMBER_* single-operand types and CUSTOM_FORMULA. ' +
                'Pass two values for NUMBER_BETWEEN and NUMBER_NOT_BETWEEN (lower bound first).'),
            backgroundColor: z
                .string()
                .optional()
                .describe('Cell background color as hex (e.g., "#FF9900").'),
            bold: z.boolean().optional().describe('Apply bold text formatting.'),
            italic: z.boolean().optional().describe('Apply italic text formatting.'),
            strikethrough: z.boolean().optional().describe('Apply strikethrough text formatting.'),
            underline: z.boolean().optional().describe('Apply underline text formatting.'),
            foregroundColor: z
                .string()
                .optional()
                .describe('Text (foreground) color as hex (e.g., "#FF0000").'),
            fontSize: z.number().min(1).optional().describe('Font size in points.'),
        })
            .refine((data) => data.backgroundColor !== undefined ||
            data.bold !== undefined ||
            data.italic !== undefined ||
            data.strikethrough !== undefined ||
            data.underline !== undefined ||
            data.foregroundColor !== undefined ||
            data.fontSize !== undefined, { message: 'At least one formatting option must be provided.' })
            .refine((data) => {
            const values = data.conditionValues ?? [];
            if (NO_VALUE_CONDITIONS.includes(data.conditionType)) {
                return values.length === 0;
            }
            if (TWO_VALUE_CONDITIONS.includes(data.conditionType)) {
                return values.length === 2;
            }
            return values.length === 1;
        }, (data) => {
            if (NO_VALUE_CONDITIONS.includes(data.conditionType)) {
                return { message: `${data.conditionType} does not accept condition values.` };
            }
            if (TWO_VALUE_CONDITIONS.includes(data.conditionType)) {
                return { message: `${data.conditionType} requires exactly two condition values.` };
            }
            return { message: `${data.conditionType} requires exactly one condition value.` };
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Adding conditional format rule to spreadsheet ${args.spreadsheetId}`);
            try {
                const sheetId = await SheetsHelpers.resolveSheetId(sheets, args.spreadsheetId, args.sheetName);
                const gridRanges = args.ranges.map((r) => SheetsHelpers.parseA1ToGridRange(r, sheetId));
                const conditionValues = (args.conditionValues ?? []).map((v) => ({
                    userEnteredValue: v,
                }));
                const format = {};
                if (args.backgroundColor) {
                    const rgb = SheetsHelpers.hexToRgb(args.backgroundColor);
                    if (!rgb)
                        throw new UserError(`Invalid background color: "${args.backgroundColor}".`);
                    format.backgroundColor = rgb;
                }
                const hasTextFormat = args.bold !== undefined ||
                    args.italic !== undefined ||
                    args.strikethrough !== undefined ||
                    args.underline !== undefined ||
                    args.fontSize !== undefined ||
                    args.foregroundColor !== undefined;
                if (hasTextFormat) {
                    const textFormat = {};
                    if (args.bold !== undefined)
                        textFormat.bold = args.bold;
                    if (args.italic !== undefined)
                        textFormat.italic = args.italic;
                    if (args.strikethrough !== undefined)
                        textFormat.strikethrough = args.strikethrough;
                    if (args.underline !== undefined)
                        textFormat.underline = args.underline;
                    if (args.fontSize !== undefined)
                        textFormat.fontSize = args.fontSize;
                    if (args.foregroundColor) {
                        const rgb = SheetsHelpers.hexToRgb(args.foregroundColor);
                        if (!rgb)
                            throw new UserError(`Invalid foreground color: "${args.foregroundColor}".`);
                        textFormat.foregroundColor = rgb;
                    }
                    format.textFormat = textFormat;
                }
                await SheetsHelpers.addConditionalFormatRule(sheets, args.spreadsheetId, gridRanges, args.conditionType, conditionValues, format);
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`;
                return `${sheetUrl}\nSuccessfully added conditional formatting rule to ${args.ranges.join(', ')}.`;
            }
            catch (error) {
                log.error(`Error adding conditional format rule: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to add conditional formatting: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
