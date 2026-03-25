import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'insertChart',
        description: 'Inserts a chart into a Google Sheet. Supports bar, column, line, area, scatter, pie, donut, and treemap (hierarchical) chart types. ' +
            'For treemap charts, the data must have a label column and a parent label column (use empty string for root nodes) plus a numeric size column. ' +
            'Chart is placed as an overlay at the specified anchor cell.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            sheetName: z
                .string()
                .optional()
                .describe('Name of the sheet/tab containing the data. Defaults to the first sheet.'),
            chartType: z
                .enum(['BAR', 'COLUMN', 'LINE', 'AREA', 'SCATTER', 'PIE', 'DONUT', 'TREEMAP'])
                .describe('Chart type to create.'),
            stackedType: z
                .enum(['NOT_STACKED', 'STACKED', 'PERCENT_STACKED'])
                .default('NOT_STACKED')
                .describe('For bar/column/area charts: whether to stack series. NOT_STACKED = grouped, STACKED = absolute stacked, PERCENT_STACKED = 100% stacked.'),
            title: z.string().optional().describe('Chart title.'),
            dataRange: z
                .string()
                .describe('A1 notation range of the data (e.g., "A1:E50"). Include the header row if present.'),
            headerRow: z
                .boolean()
                .default(true)
                .describe('Whether the first row of the data range is a header row.'),
            // Column indices for flexible data mapping
            labelColumnIndex: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe('For pie/donut/treemap: 1-based column index for node labels (default: 1). For treemap this is the leaf/child label.'),
            parentColumnIndex: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe('For treemap: 1-based column index for parent node labels. Root nodes should have an empty string in this column.'),
            valueColumnIndex: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe('For pie/donut/treemap: 1-based column index for the numeric size/value (default: 2).'),
            // Chart position and size
            anchorRow: z
                .number()
                .int()
                .min(0)
                .default(0)
                .describe('Row index (0-based) of the anchor cell for chart placement.'),
            anchorColumn: z
                .number()
                .int()
                .min(0)
                .default(6)
                .describe('Column index (0-based) of the anchor cell for chart placement.'),
            offsetXPixels: z
                .number()
                .int()
                .default(0)
                .describe('Horizontal offset in pixels from the anchor cell.'),
            offsetYPixels: z
                .number()
                .int()
                .default(0)
                .describe('Vertical offset in pixels from the anchor cell.'),
            widthPixels: z.number().int().default(600).describe('Chart width in pixels.'),
            heightPixels: z.number().int().default(400).describe('Chart height in pixels.'),
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            log.info(`Inserting ${args.chartType} chart into spreadsheet ${args.spreadsheetId}`);
            try {
                const sheetId = await SheetsHelpers.resolveSheetId(sheets, args.spreadsheetId, args.sheetName);
                const { a1Range } = SheetsHelpers.parseRange(args.dataRange);
                const gridRange = SheetsHelpers.parseA1ToGridRange(a1Range, sheetId);
                const startRow = gridRange.startRowIndex ?? 0;
                const endRow = gridRange.endRowIndex ?? startRow + 1;
                const startCol = gridRange.startColumnIndex ?? 0;
                const endCol = gridRange.endColumnIndex ?? startCol + 1;
                const dataStartRow = args.headerRow ? startRow + 1 : startRow;
                const labelCol = startCol + (args.labelColumnIndex ? args.labelColumnIndex - 1 : 0);
                const valueCol = startCol + (args.valueColumnIndex ? args.valueColumnIndex - 1 : 1);
                const parentCol = startCol + (args.parentColumnIndex ? args.parentColumnIndex - 1 : 0);
                const makeSourceRange = (colStart, colEnd, rowStart = dataStartRow) => ({
                    sources: [
                        {
                            sheetId,
                            startRowIndex: rowStart,
                            endRowIndex: endRow,
                            startColumnIndex: colStart,
                            endColumnIndex: colEnd,
                        },
                    ],
                });
                let chartSpec = {};
                if (args.chartType === 'PIE' || args.chartType === 'DONUT') {
                    chartSpec.pieChart = {
                        legendPosition: 'LABELED_LEGEND',
                        pieHole: args.chartType === 'DONUT' ? 0.5 : 0,
                        domain: {
                            data: { sourceRange: makeSourceRange(labelCol, labelCol + 1) },
                        },
                        series: {
                            data: { sourceRange: makeSourceRange(valueCol, valueCol + 1) },
                        },
                    };
                }
                else if (args.chartType === 'TREEMAP') {
                    chartSpec.treemapChart = {
                        labels: {
                            sourceRange: makeSourceRange(labelCol, labelCol + 1),
                        },
                        parentLabels: {
                            sourceRange: makeSourceRange(parentCol, parentCol + 1),
                        },
                        sizeData: {
                            sourceRange: makeSourceRange(valueCol, valueCol + 1),
                        },
                        colorData: {
                            sourceRange: makeSourceRange(valueCol, valueCol + 1),
                        },
                    };
                }
                else {
                    // Basic chart types: BAR, COLUMN, LINE, AREA, SCATTER
                    // Each series must be a separate entry with a single-column source range.
                    const seriesCount = endCol - startCol - 1;
                    const series = Array.from({ length: seriesCount }, (_, i) => ({
                        series: {
                            sourceRange: {
                                sources: [
                                    {
                                        sheetId,
                                        startRowIndex: startRow, // include header so Sheets names the series automatically
                                        endRowIndex: endRow,
                                        startColumnIndex: startCol + 1 + i,
                                        endColumnIndex: startCol + 2 + i,
                                    },
                                ],
                            },
                        },
                        targetAxis: 'LEFT_AXIS',
                    }));
                    chartSpec.basicChart = {
                        chartType: args.chartType,
                        stackedType: args.stackedType,
                        legendPosition: 'BOTTOM_LEGEND',
                        axis: [
                            { position: 'BOTTOM_AXIS', title: '' },
                            { position: 'LEFT_AXIS', title: '' },
                        ],
                        domains: [
                            {
                                domain: {
                                    sourceRange: {
                                        sources: [
                                            {
                                                sheetId,
                                                startRowIndex: startRow,
                                                endRowIndex: endRow,
                                                startColumnIndex: startCol,
                                                endColumnIndex: startCol + 1,
                                            },
                                        ],
                                    },
                                },
                                reversed: false,
                            },
                        ],
                        series,
                        headerCount: args.headerRow ? 1 : 0,
                    };
                }
                if (args.title) {
                    chartSpec.title = args.title;
                }
                const response = await sheets.spreadsheets.batchUpdate({
                    spreadsheetId: args.spreadsheetId,
                    requestBody: {
                        requests: [
                            {
                                addChart: {
                                    chart: {
                                        spec: chartSpec,
                                        position: {
                                            overlayPosition: {
                                                anchorCell: {
                                                    sheetId,
                                                    rowIndex: args.anchorRow,
                                                    columnIndex: args.anchorColumn,
                                                },
                                                offsetXPixels: args.offsetXPixels,
                                                offsetYPixels: args.offsetYPixels,
                                                widthPixels: args.widthPixels,
                                                heightPixels: args.heightPixels,
                                            },
                                        },
                                    },
                                },
                            },
                        ],
                    },
                });
                const chartId = response.data.replies?.[0]?.addChart?.chart?.chartId;
                return `Chart created successfully${chartId ? ` (Chart ID: ${chartId})` : ''}.`;
            }
            catch (error) {
                log.error(`Error inserting chart: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to insert chart: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
