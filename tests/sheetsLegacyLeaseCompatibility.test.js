// Direct/internal callers run without a transport context and retain the
// readTracker fallback. Structural and formatting tools still need the current
// sheet metadata to resolve caller-facing names/IDs; this pins that adapter
// path so it cannot regress to lease.structure/lease.sheets TypeErrors.
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

let fakeDrive;
let fakeSheets;

jest.unstable_mockModule('../dist/clients.js', () => ({
    getDriveClient: async () => fakeDrive,
    getSheetsClient: async () => fakeSheets,
}));

const { trackRead } = await import('../dist/readTracker.js');
const { register: registerDeleteSheet } = await import('../dist/tools/sheets/deleteSheet.js');
const { register: registerDeleteChart } = await import('../dist/tools/sheets/deleteChart.js');
const { register: registerDeleteColumns } = await import('../dist/tools/sheets/deleteColumns.js');
const { register: registerDeleteTable } = await import('../dist/tools/sheets/deleteTable.js');
const { register: registerCopyFormatting } = await import('../dist/tools/sheets/copyFormatting.js');
const { register: registerFormatCells } = await import('../dist/tools/sheets/formatCells.js');

const log = { info() {}, error() {}, warn() {}, debug() {} };

function serverFor(register) {
    const tools = new Map();
    register({ addTool(tool) { tools.set(tool.name, tool); } });
    return tools;
}

function spreadsheetMetadata() {
    return {
        data: {
            properties: { title: 'Legacy direct caller' },
            sheets: [
                {
                    properties: { sheetId: 0, title: 'Sheet1', hidden: false, gridProperties: { rowCount: 100, columnCount: 20 } },
                    charts: [{ chartId: 17, position: { newSheet: true }, spec: { title: 'Trend' } }],
                    tables: [{ tableId: 'table-1', name: 'Accounts', range: { sheetId: 0, startRowIndex: 0, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 3 } }],
                },
                { properties: { sheetId: 1, title: 'Sheet2', hidden: false, gridProperties: { rowCount: 100, columnCount: 20 } }, charts: [], tables: [] },
            ],
        },
    };
}

beforeEach(() => {
    fakeDrive = { files: { get: jest.fn(async () => ({ data: { modifiedTime: null } })) } };
    fakeSheets = {
        spreadsheets: {
            get: jest.fn(async () => spreadsheetMetadata()),
            batchUpdate: jest.fn(async () => ({ data: {} })),
        },
    };
});

describe('legacy Sheets lease metadata adapters', () => {
    it.each([
        ['1:1', { sheetId: 0, startRowIndex: 0, endRowIndex: 1 }, 'endColumnIndex'],
        ['A:A', { sheetId: 0, startColumnIndex: 0, endColumnIndex: 1 }, 'endRowIndex'],
    ])('preserves direct legacy formatting for %s after a tracker read', async (range, expectedRange, absentBound) => {
        const spreadsheetId = `legacy-format-${range}-${Date.now()}-${Math.random()}`;
        trackRead(spreadsheetId, null);
        const tool = serverFor(registerFormatCells).get('formatCells');
        await expect(tool.execute({ spreadsheetId, range, bold: true }, { log })).resolves.toContain('Successfully applied formatting');
        const request = fakeSheets.spreadsheets.batchUpdate.mock.calls[0][0].requestBody.requests[0];
        expect(request.repeatCell.range).toEqual(expectedRange);
        expect(request.repeatCell.range).not.toHaveProperty(absentBound);
    });

    it.each([
        ['deleteSheet', registerDeleteSheet, { sheetId: 1 }],
        ['deleteChart', registerDeleteChart, { chartId: 17 }],
        ['deleteColumns', registerDeleteColumns, { sheetName: 'Sheet1', columns: [{ startIndex: 2, endIndex: 3 }] }],
        ['deleteTable', registerDeleteTable, { tableIdentifier: 'Accounts', deleteData: false }],
        ['copyFormatting', registerCopyFormatting, {
            sourceSheetName: 'Sheet1', sourceRange: 'A1:B10',
            destinationSheetName: 'Sheet2', destinationRange: 'D1',
        }],
    ])('runs %s for a direct caller after a tracker read', async (name, register, args) => {
        const spreadsheetId = `legacy-${name}-${Date.now()}-${Math.random()}`;
        trackRead(spreadsheetId, null);
        const tool = serverFor(register).get(name);

        await expect(tool.execute({ spreadsheetId, ...args }, { log })).resolves.toEqual(expect.any(String));
        expect(fakeSheets.spreadsheets.batchUpdate).toHaveBeenCalledTimes(1);
    });
});
