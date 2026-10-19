// The structure and format projections handed back to callers must include
// every property used by the read-handle fingerprints. Otherwise a successor
// could authorize an unseen chart/format state.
import { describe, expect, it } from '@jest/globals';
import { readSheetsStructureBaseline } from '../dist/resourceHandles.js';

function sheetResponse(chartSpec) {
    return {
        data: {
            properties: { title: 'Projection test' },
            sheets: [{
                properties: { sheetId: 42, title: 'Quarterly', hidden: false, gridProperties: { rowCount: 100, columnCount: 12 } },
                charts: [{ chartId: 7, position: { overlayPosition: { anchorCell: { rowIndex: 1, columnIndex: 2 } } }, spec: chartSpec }],
                tables: [],
            }],
        },
    };
}

describe('Sheets structure read projection', () => {
    it('returns the complete chart spec that its structure handle fingerprints', async () => {
        let chartSpec = { title: 'Revenue', basicChart: { chartType: 'COLUMN', legendPosition: 'BOTTOM_LEGEND' } };
        const drive = { files: { get: async () => ({ data: { id: 'sheet-1', version: '1' } }) } };
        const sheets = { spreadsheets: { get: async () => sheetResponse(chartSpec) } };

        const first = await readSheetsStructureBaseline({ drive, sheets, spreadsheetId: 'sheet-1' });
        expect(first.observedStructure.sheets[0].charts[0]).toEqual({
            chartId: 7,
            position: { overlayPosition: { anchorCell: { rowIndex: 1, columnIndex: 2 } } },
            spec: chartSpec,
        });

        chartSpec = { title: 'Revenue', basicChart: { chartType: 'LINE', legendPosition: 'BOTTOM_LEGEND' } };
        const changed = await readSheetsStructureBaseline({ drive, sheets, spreadsheetId: 'sheet-1' });
        expect(changed.fingerprint).not.toBe(first.fingerprint);
        expect(changed.observedStructure.sheets[0].charts[0].spec.basicChart.chartType).toBe('LINE');
    });
});
