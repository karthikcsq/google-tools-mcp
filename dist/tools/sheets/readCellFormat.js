import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import { rowColToA1 } from '../../googleSheetsApiHelpers.js';
/**
 * Converts a Google Sheets RGBA color object (0-1 range) to a hex string.
 * Returns null if the color is undefined or has no meaningful channels.
 */
function rgbaToHex(color) {
    if (!color)
        return null;
    const r = Math.round((color.red ?? 0) * 255);
    const g = Math.round((color.green ?? 0) * 255);
    const b = Math.round((color.blue ?? 0) * 255);
    return `#${r.toString(16).padStart(2, '0').toUpperCase()}${g.toString(16).padStart(2, '0').toUpperCase()}${b.toString(16).padStart(2, '0').toUpperCase()}`;
}
/**
 * Extracts a simplified formatting summary from a Google Sheets CellFormat object.
 * Only includes properties that are explicitly set (non-default).
 */
function simplifyFormat(fmt) {
    if (!fmt)
        return null;
    const result = {};
    // Text formatting
    if (fmt.textFormat) {
        const tf = {};
        if (fmt.textFormat.bold)
            tf.bold = true;
        if (fmt.textFormat.italic)
            tf.italic = true;
        if (fmt.textFormat.strikethrough)
            tf.strikethrough = true;
        if (fmt.textFormat.underline)
            tf.underline = true;
        if (fmt.textFormat.fontSize != null)
            tf.fontSize = fmt.textFormat.fontSize;
        if (fmt.textFormat.fontFamily)
            tf.fontFamily = fmt.textFormat.fontFamily;
        if (fmt.textFormat.foregroundColorStyle?.rgbColor) {
            tf.foregroundColor = rgbaToHex(fmt.textFormat.foregroundColorStyle.rgbColor);
        }
        else if (fmt.textFormat.foregroundColor) {
            tf.foregroundColor = rgbaToHex(fmt.textFormat.foregroundColor);
        }
        if (Object.keys(tf).length > 0)
            result.textFormat = tf;
    }
    // Background color
    if (fmt.backgroundColorStyle?.rgbColor) {
        result.backgroundColor = rgbaToHex(fmt.backgroundColorStyle.rgbColor);
    }
    else if (fmt.backgroundColor) {
        result.backgroundColor = rgbaToHex(fmt.backgroundColor);
    }
    // Alignment
    if (fmt.horizontalAlignment)
        result.horizontalAlignment = fmt.horizontalAlignment;
    if (fmt.verticalAlignment)
        result.verticalAlignment = fmt.verticalAlignment;
    // Number format
    if (fmt.numberFormat) {
        result.numberFormat = {
            type: fmt.numberFormat.type,
            pattern: fmt.numberFormat.pattern,
        };
    }
    // Borders
    if (fmt.borders) {
        const borders = {};
        for (const side of ['top', 'bottom', 'left', 'right']) {
            if (fmt.borders[side]) {
                borders[side] = {
                    style: fmt.borders[side].style,
                    ...(fmt.borders[side].colorStyle?.rgbColor
                        ? { color: rgbaToHex(fmt.borders[side].colorStyle.rgbColor) }
                        : fmt.borders[side].color
                            ? { color: rgbaToHex(fmt.borders[side].color) }
                            : {}),
                };
            }
        }
        if (Object.keys(borders).length > 0)
            result.borders = borders;
    }
    // Wrap strategy
    if (fmt.wrapStrategy)
        result.wrapStrategy = fmt.wrapStrategy;
    return Object.keys(result).length > 0 ? result : null;
}
export function register(server) {
    server.addTool({
        name: 'readCellFormat',
        description: 'Reads the formatting/style of cells in a given range. Returns formatting details like bold, italic, fontSize, fontFamily, colors, alignment, borders, and number format per cell.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            range: z
                .string()
                .describe('A1 notation range to read formatting from (e.g., "Sheet1!A1:D5" or "A1:B2").'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Reading cell format for range "${args.range}" in spreadsheet ${args.spreadsheetId}`);
            try {
                const response = await sheets.spreadsheets.get({
                    spreadsheetId: args.spreadsheetId,
                    ranges: [args.range],
                    includeGridData: true,
                    fields: 'sheets.data.rowData.values.userEnteredFormat,sheets.data.startRow,sheets.data.startColumn',
                });
                const sheetData = response.data.sheets?.[0]?.data?.[0];
                if (!sheetData?.rowData) {
                    return JSON.stringify({ range: args.range, cells: [] }, null, 2);
                }
                const startRow = sheetData.startRow ?? 0;
                const startCol = sheetData.startColumn ?? 0;
                const cells = [];
                for (let rowIdx = 0; rowIdx < sheetData.rowData.length; rowIdx++) {
                    const row = sheetData.rowData[rowIdx];
                    if (!row.values)
                        continue;
                    for (let colIdx = 0; colIdx < row.values.length; colIdx++) {
                        const cellData = row.values[colIdx];
                        const fmt = simplifyFormat(cellData?.userEnteredFormat);
                        if (fmt) {
                            const cellRef = rowColToA1(startRow + rowIdx, startCol + colIdx);
                            cells.push({ cell: cellRef, format: fmt });
                        }
                    }
                }
                return JSON.stringify({ range: args.range, cells }, null, 2);
            }
            catch (error) {
                log.error(`Error reading cell format for spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to read cell format: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
