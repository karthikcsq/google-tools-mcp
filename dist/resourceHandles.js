// Explicit resource capabilities for Sheets and Drive mutations.
//
// These APIs do not expose Docs-style conditional write controls.  A lease
// therefore serializes mutations in this process and compares a freshly read
// canonical resource projection immediately before issuing the API request.
// It cannot close a concurrent writer's race after that comparison; callers
// are told about that documented limit rather than being promised atomic CAS.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { publicError } from './errors.js';
import { ReadHandleError } from './readHandles.js';
import { getRequestContext } from './requestContext.js';
import {
    getReadHandleStore,
    isHandleRuntimeActive,
    setResultHandle,
    setResultResourceState,
    setResultWarning,
    syncRuntimeBinding,
} from './handleRuntime.js';
import { trackMutation } from './readTracker.js';

export const ResourceReadHandleParameter = z.string().optional().describe(
    'Capability returned by the corresponding read tool. Required on the modern MCP runtime, including modern stdio.',
);

const SHEETS_VALUES_KIND = 'sheets-values-v1';
const SHEETS_CELL_STATE_KIND = 'sheets-cell-state-v1';
const SHEETS_STRUCTURE_KIND = 'sheets-structure-v1';
const DRIVE_FILE_KIND = 'drive-file-v1';
const SHEETS_HANDLE_REQUIRED =
    'This Sheets mutation requires a readHandle. Call readSpreadsheet for the exact bounded range first, then pass the returned readHandle.';
const DRIVE_HANDLE_REQUIRED =
    'This deletion requires a readHandle. Call getFileInfo for this file first, then pass the returned readHandle.';
const SHEETS_REREAD_REQUIRED =
    'The spreadsheet changed after this handle was read. Read the affected range again before writing.';
const DRIVE_REREAD_REQUIRED =
    'The Drive file changed after this handle was read. Call getFileInfo again before deleting it.';
const SHEETS_SCOPE_REQUIRED =
    'This readHandle does not authorize the requested bounded range. Read every range this mutation will change, then retry.';

const mutationTails = new Map();
const MAX_RANGES_PER_READ = 32;
const MAX_CELLS_PER_RANGE = 100_000;
const MAX_TOTAL_CELLS_PER_READ = 250_000;
const MAX_COLUMN_INDEX = 18_277; // Sheets' current maximum ZZZ column index.
const MAX_ROW_INDEX = 9_999_999;

function hash(value) {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function asPublic(error) {
    if (error instanceof ReadHandleError) return publicError(error.message);
    return error;
}

function isVersion(value) {
    return (typeof value === 'string' && value.length > 0) ||
        (Number.isSafeInteger(value) && value >= 0);
}

function quoteSheetTitle(title) {
    return `'${String(title).replace(/'/g, "''")}'`;
}

function columnToIndex(value) {
    let result = 0;
    for (const character of value.toUpperCase()) {
        result = (result * 26) + (character.charCodeAt(0) - 64);
    }
    const index = result - 1;
    if (!Number.isSafeInteger(index) || index < 0 || index > MAX_COLUMN_INDEX) {
        throw publicError('The A1 column is outside the supported bounded read range.');
    }
    return index;
}

function indexToColumn(index) {
    let value = index + 1;
    let output = '';
    while (value > 0) {
        value -= 1;
        output = String.fromCharCode(65 + (value % 26)) + output;
        value = Math.floor(value / 26);
    }
    return output;
}

function splitSheetAndA1(input) {
    let quoted = false;
    for (let index = 0; index < input.length; index += 1) {
        if (input[index] !== "'") continue;
        if (quoted && input[index + 1] === "'") {
            index += 1;
            continue;
        }
        quoted = !quoted;
        continue;
    }
    if (quoted) throw publicError('The A1 range has an unterminated quoted sheet name.');

    quoted = false;
    for (let index = 0; index < input.length; index += 1) {
        if (input[index] === "'") {
            if (quoted && input[index + 1] === "'") {
                index += 1;
                continue;
            }
            quoted = !quoted;
        }
        else if (input[index] === '!' && !quoted) {
            return { sheet: input.slice(0, index), a1: input.slice(index + 1) };
        }
    }
    return { sheet: null, a1: input };
}

function parseSheetName(raw) {
    const value = raw.trim();
    if (value.startsWith("'")) {
        if (!value.endsWith("'") || value.length < 2) {
            throw publicError('The A1 range has an invalid quoted sheet name.');
        }
        return value.slice(1, -1).replace(/''/g, "'");
    }
    return value;
}

function parseA1Bounds(value) {
    const match = /^\s*([A-Za-z]+)([1-9]\d*)(?::([A-Za-z]+)([1-9]\d*))?\s*$/.exec(value);
    if (!match) {
        throw publicError('Use a bounded A1 cell range such as Sheet1!A1:C10. Whole rows, whole columns, named ranges, and unbounded ranges are not safe for a read handle.');
    }
    const startColumn = columnToIndex(match[1]);
    const startRow = Number(match[2]) - 1;
    const endColumn = match[3] ? columnToIndex(match[3]) : startColumn;
    const endRow = match[4] ? Number(match[4]) - 1 : startRow;
    if (!Number.isSafeInteger(startRow) || !Number.isSafeInteger(endRow) || startRow > MAX_ROW_INDEX || endRow > MAX_ROW_INDEX || endColumn < startColumn || endRow < startRow) {
        throw publicError('The A1 range must run from its upper-left cell to its lower-right cell.');
    }
    const bounds = { startRow, endRow: endRow + 1, startColumn, endColumn: endColumn + 1 };
    if ((bounds.endRow - bounds.startRow) * (bounds.endColumn - bounds.startColumn) > MAX_CELLS_PER_RANGE) {
        throw publicError(`A read-handle range may cover at most ${MAX_CELLS_PER_RANGE} cells. Split the read into bounded ranges.`);
    }
    return bounds;
}

function summarizeSheetObjects(entry) {
    const range = (value) => value && typeof value === 'object' ? {
        sheetId: value.sheetId ?? null,
        startRowIndex: value.startRowIndex ?? null,
        endRowIndex: value.endRowIndex ?? null,
        startColumnIndex: value.startColumnIndex ?? null,
        endColumnIndex: value.endColumnIndex ?? null,
    } : null;
    return {
        charts: (entry?.charts ?? []).map((chart) => ({
            chartId: chart?.chartId ?? null,
            position: chart?.position ?? null,
            spec: chart?.spec ?? null,
        })),
        tables: (entry?.tables ?? []).map((table) => ({
            tableId: table?.tableId ?? null,
            name: table?.name ?? null,
            range: range(table?.range),
        })),
    };
}

function sheetsFromMetadata(data, { includeObjects = false } = {}) {
    const sheets = (data?.sheets ?? []).map((entry) => ({
        sheetId: entry?.properties?.sheetId,
        title: entry?.properties?.title,
        rowCount: entry?.properties?.gridProperties?.rowCount ?? null,
        columnCount: entry?.properties?.gridProperties?.columnCount ?? null,
        hidden: Boolean(entry?.properties?.hidden),
        ...(includeObjects ? summarizeSheetObjects(entry) : {}),
    })).filter((entry) => Number.isSafeInteger(entry.sheetId) && typeof entry.title === 'string' && entry.title.length > 0);
    if (sheets.length === 0) throw publicError('The spreadsheet has no readable sheets.');
    return sheets;
}

export function canonicalizeSheetRange(input, sheets) {
    if (typeof input !== 'string' || input.trim().length === 0) {
        throw publicError('A bounded A1 range is required.');
    }
    const parsed = splitSheetAndA1(input.trim());
    const sheetName = parsed.sheet === null ? sheets[0].title : parseSheetName(parsed.sheet);
    const sheet = sheets.find((candidate) => candidate.title === sheetName);
    if (!sheet) throw publicError(`Sheet "${sheetName}" was not found in this spreadsheet.`);
    const bounds = parseA1Bounds(parsed.a1);
    return {
        ...bounds,
        sheetId: sheet.sheetId,
        titleHash: hash(sheet.title),
        canonical: `${quoteSheetTitle(sheet.title)}!${indexToColumn(bounds.startColumn)}${bounds.startRow + 1}:${indexToColumn(bounds.endColumn - 1)}${bounds.endRow}`,
    };
}

function descriptor(range) {
    return {
        sheetId: range.sheetId,
        titleHash: range.titleHash,
        startRow: range.startRow,
        endRow: range.endRow,
        startColumn: range.startColumn,
        endColumn: range.endColumn,
    };
}

function sameDescriptor(left, right) {
    return left.sheetId === right.sheetId && left.titleHash === right.titleHash &&
        left.startRow === right.startRow && left.endRow === right.endRow &&
        left.startColumn === right.startColumn && left.endColumn === right.endColumn;
}

function contains(outer, inner) {
    return outer.sheetId === inner.sheetId && outer.titleHash === inner.titleHash &&
        outer.startRow <= inner.startRow && outer.endRow >= inner.endRow &&
        outer.startColumn <= inner.startColumn && outer.endColumn >= inner.endColumn;
}

function overlaps(left, right) {
    return left.sheetId === right.sheetId &&
        left.startRow < right.endRow && right.startRow < left.endRow &&
        left.startColumn < right.endColumn && right.startColumn < left.endColumn;
}

function cellProjection(cell) {
    return {
        entered: cell?.userEnteredValue ?? null,
        effective: cell?.effectiveValue ?? null,
        formatted: cell?.formattedValue ?? null,
    };
}

function cellStateProjection(cell) {
    return {
        userEnteredFormat: cell?.userEnteredFormat ?? null,
        dataValidation: cell?.dataValidation ?? null,
    };
}

async function getDriveVersion(drive, resourceId) {
    const response = await drive.files.get({
        fileId: resourceId,
        fields: 'id,version',
        supportsAllDrives: true,
    });
    const version = response?.data?.version;
    if (!isVersion(version)) throw publicError('Google did not return a usable Drive version for this resource. Read it again after the service is available.');
    return version;
}

async function getSheetMetadata(sheets, spreadsheetId, { includeObjects = false } = {}) {
    const response = await sheets.spreadsheets.get({
        spreadsheetId,
        includeGridData: false,
        fields: includeObjects
            ? 'spreadsheetId,properties(title),sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)),charts(chartId,position,spec),tables(tableId,name,range))'
            : 'spreadsheetId,properties(title),sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)))',
    });
    if (!response?.data || typeof response.data !== 'object') {
        throw publicError('Google did not return usable spreadsheet metadata. Read the spreadsheet again.');
    }
    return {
        title: response.data.properties?.title ?? null,
        sheets: sheetsFromMetadata(response.data, { includeObjects }),
    };
}

async function captureValueRange(sheets, spreadsheetId, range) {
    const response = await sheets.spreadsheets.get({
        spreadsheetId,
        ranges: [range.canonical],
        includeGridData: true,
        fields: 'sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue))))',
    });
    const sheet = response?.data?.sheets?.find((entry) => entry?.properties?.sheetId === range.sheetId);
    if (!sheet || sheet?.properties?.sheetId !== range.sheetId || hash(sheet?.properties?.title ?? '') !== range.titleHash) {
        throw publicError('Google did not return the requested sheet for this baseline. Read the spreadsheet again.');
    }
    const data = sheet?.data?.[0] ?? {};
    const startRow = data.startRow ?? range.startRow;
    const startColumn = data.startColumn ?? range.startColumn;
    if (data.rowData !== undefined && !Array.isArray(data.rowData)) {
        throw publicError('Google returned malformed grid data for this baseline. Read the spreadsheet again.');
    }
    const rows = (data.rowData ?? []).map((row) => (row?.values ?? []).map(cellProjection));
    return {
        descriptor: descriptor(range),
        dataStartRow: startRow,
        dataStartColumn: startColumn,
        rows,
    };
}

async function captureCellStateRange(sheets, spreadsheetId, range) {
    const response = await sheets.spreadsheets.get({
        spreadsheetId,
        ranges: [range.canonical],
        includeGridData: true,
        fields: 'sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(userEnteredFormat,dataValidation))))',
    });
    const sheet = response?.data?.sheets?.find((entry) => entry?.properties?.sheetId === range.sheetId);
    if (!sheet || sheet?.properties?.sheetId !== range.sheetId || hash(sheet?.properties?.title ?? '') !== range.titleHash) {
        throw publicError('Google did not return the requested sheet for this baseline. Read the spreadsheet again.');
    }
    const data = sheet?.data?.[0] ?? {};
    if (data.rowData !== undefined && !Array.isArray(data.rowData)) {
        throw publicError('Google returned malformed grid data for this baseline. Read the spreadsheet again.');
    }
    return {
        descriptor: descriptor(range),
        dataStartRow: data.startRow ?? range.startRow,
        dataStartColumn: data.startColumn ?? range.startColumn,
        rows: (data.rowData ?? []).map((row) => (row?.values ?? []).map(cellStateProjection)),
    };
}

function normalizeBaselineRanges(ranges) {
    if (!Array.isArray(ranges) || ranges.length === 0) {
        throw publicError('The readHandle does not contain a usable Sheets range baseline. Read the spreadsheet again.');
    }
    return ranges.map((range) => {
        if (!Number.isSafeInteger(range?.sheetId) || !Number.isSafeInteger(range?.startRow) ||
            !Number.isSafeInteger(range?.endRow) || !Number.isSafeInteger(range?.startColumn) ||
            !Number.isSafeInteger(range?.endColumn) || typeof range?.titleHash !== 'string') {
            throw publicError('The readHandle does not contain a usable Sheets range baseline. Read the spreadsheet again.');
        }
        return range;
    });
}

function scalarValue(value) {
    if (!value || typeof value !== 'object') return null;
    for (const key of ['stringValue', 'numberValue', 'boolValue', 'formulaValue']) {
        if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
    }
    return value.errorValue ? `#${value.errorValue.type ?? 'ERROR'}` : null;
}

function trimDisplayRows(rows) {
    while (rows.length > 0 && rows[rows.length - 1].every((value) => value === null)) rows.pop();
    return rows.map((row) => {
        while (row.length > 0 && row[row.length - 1] === null) row.pop();
        return row.map((value) => value ?? '');
    });
}

function displayRange(captured, valueRenderOption) {
    const values = trimDisplayRows(captured.rows.map((row) => row.map((cell) => {
        if (valueRenderOption === 'FORMATTED_VALUE') return cell.formatted ?? '';
        if (valueRenderOption === 'FORMULA') return scalarValue(cell.entered) ?? scalarValue(cell.effective) ?? '';
        return scalarValue(cell.effective) ?? '';
    }).map((value) => value === '' ? null : value)));
    // The fingerprint always includes the user-entered and formula state. Show
    // those bounded projections on every value read/successor as well, so a
    // caller never receives authority based on a formula it could not inspect.
    const enteredValues = trimDisplayRows(captured.rows.map((row) => row.map((cell) => {
        const value = scalarValue(cell.entered);
        return value === null || value === '' ? null : value;
    })));
    const formulas = trimDisplayRows(captured.rows.map((row) => row.map((cell) => {
        const value = cell?.entered?.formulaValue;
        return typeof value === 'string' && value.length > 0 ? value : null;
    })));
    return { values, enteredValues, formulas };
}

/** Fetch the Drive version plus value/formula/sheet-identity state for bounded ranges. */
export async function readSheetsValueBaseline({ drive, sheets, spreadsheetId, ranges, descriptors = null, valueRenderOption = 'FORMATTED_VALUE' }) {
    if ((!descriptors && (!Array.isArray(ranges) || ranges.length === 0)) || (ranges?.length ?? descriptors?.length ?? 0) > MAX_RANGES_PER_READ) {
        throw publicError(`A resource read may contain between 1 and ${MAX_RANGES_PER_READ} bounded ranges.`);
    }
    const [version, metadataResponse] = await Promise.all([
        getDriveVersion(drive, spreadsheetId),
        getSheetMetadata(sheets, spreadsheetId),
    ]);
    const metadata = metadataResponse.sheets;
    const byId = new Map(metadata.map((sheet) => [sheet.sheetId, sheet]));
    const canonical = descriptors
        ? descriptors.map((saved) => {
            const sheet = byId.get(saved.sheetId);
            if (!sheet || hash(sheet.title) !== saved.titleHash) {
                throw publicError(SHEETS_REREAD_REQUIRED);
            }
            return {
                ...saved,
                canonical: `${quoteSheetTitle(sheet.title)}!${indexToColumn(saved.startColumn)}${saved.startRow + 1}:${indexToColumn(saved.endColumn - 1)}${saved.endRow}`,
            };
        })
        : ranges.map((range) => canonicalizeSheetRange(range, metadata));
    const totalCells = canonical.reduce((total, range) => total + ((range.endRow - range.startRow) * (range.endColumn - range.startColumn)), 0);
    if (totalCells > MAX_TOTAL_CELLS_PER_READ) {
        throw publicError(`A resource read may cover at most ${MAX_TOTAL_CELLS_PER_READ} cells in total. Split it into separate reads.`);
    }
    const capturedRanges = [];
    for (const range of canonical) capturedRanges.push(await captureValueRange(sheets, spreadsheetId, range));
    const rangeDescriptors = canonical.map(descriptor);
    const projection = capturedRanges.map((entry) => ({
        descriptor: entry.descriptor,
        dataStartRow: entry.dataStartRow,
        dataStartColumn: entry.dataStartColumn,
        rows: entry.rows,
    }));
    const fingerprint = hash({ kind: SHEETS_VALUES_KIND, ranges: projection });
    return {
        version,
        fingerprint,
        metadata: { kind: SHEETS_VALUES_KIND, ranges: rangeDescriptors },
        ranges: canonical,
        isEmpty: capturedRanges.every((entry) => entry.rows.every((row) => row.every((cell) =>
            cell.entered === null && cell.effective === null && cell.formatted === null))),
        displayRanges: capturedRanges.map((entry, index) => ({
            range: canonical[index].canonical,
            ...displayRange(entry, valueRenderOption),
        })),
    };
}

function displayCellStateRange(captured, range) {
    const cells = [];
    for (let rowIndex = 0; rowIndex < captured.rows.length; rowIndex += 1) {
        for (let columnIndex = 0; columnIndex < captured.rows[rowIndex].length; columnIndex += 1) {
            const state = captured.rows[rowIndex][columnIndex];
            if (state.userEnteredFormat === null && state.dataValidation === null) continue;
            cells.push({
                row: captured.dataStartRow + rowIndex + 1,
                column: captured.dataStartColumn + columnIndex + 1,
                ...(state.userEnteredFormat !== null ? { userEnteredFormat: state.userEnteredFormat } : {}),
                ...(state.dataValidation !== null ? { dataValidation: state.dataValidation } : {}),
            });
        }
    }
    return { range: range.canonical, cells };
}

/** Fetch the exact existing format and dropdown state that a format write replaces. */
export async function readSheetsCellStateBaseline({ drive, sheets, spreadsheetId, ranges, descriptors = null }) {
    if ((!descriptors && (!Array.isArray(ranges) || ranges.length === 0)) || (ranges?.length ?? descriptors?.length ?? 0) > MAX_RANGES_PER_READ) {
        throw publicError(`A resource read may contain between 1 and ${MAX_RANGES_PER_READ} bounded ranges.`);
    }
    const [version, metadataResponse] = await Promise.all([
        getDriveVersion(drive, spreadsheetId),
        getSheetMetadata(sheets, spreadsheetId),
    ]);
    const metadata = metadataResponse.sheets;
    const byId = new Map(metadata.map((sheet) => [sheet.sheetId, sheet]));
    const canonical = descriptors
        ? descriptors.map((saved) => {
            const sheet = byId.get(saved.sheetId);
            if (!sheet || hash(sheet.title) !== saved.titleHash) throw publicError(SHEETS_REREAD_REQUIRED);
            return {
                ...saved,
                canonical: `${quoteSheetTitle(sheet.title)}!${indexToColumn(saved.startColumn)}${saved.startRow + 1}:${indexToColumn(saved.endColumn - 1)}${saved.endRow}`,
            };
        })
        : ranges.map((range) => canonicalizeSheetRange(range, metadata));
    const totalCells = canonical.reduce((total, range) => total + ((range.endRow - range.startRow) * (range.endColumn - range.startColumn)), 0);
    if (totalCells > MAX_TOTAL_CELLS_PER_READ) {
        throw publicError(`A resource read may cover at most ${MAX_TOTAL_CELLS_PER_READ} cells in total. Split it into separate reads.`);
    }
    const capturedRanges = [];
    for (const range of canonical) capturedRanges.push(await captureCellStateRange(sheets, spreadsheetId, range));
    const projection = capturedRanges.map((entry) => ({
        descriptor: entry.descriptor,
        dataStartRow: entry.dataStartRow,
        dataStartColumn: entry.dataStartColumn,
        rows: entry.rows,
    }));
    return {
        version,
        fingerprint: hash({ kind: SHEETS_CELL_STATE_KIND, ranges: projection }),
        metadata: { kind: SHEETS_CELL_STATE_KIND, ranges: canonical.map(descriptor) },
        ranges: canonical,
        sheets: metadata,
        displayRanges: capturedRanges.map((entry, index) => displayCellStateRange(entry, canonical[index])),
    };
}

/** Read the sheet identity/grid structure used by structural destructive tools. */
export async function readSheetsStructureBaseline({ drive, sheets, spreadsheetId }) {
    const [version, metadataResponse] = await Promise.all([
        getDriveVersion(drive, spreadsheetId),
        getSheetMetadata(sheets, spreadsheetId, { includeObjects: true }),
    ]);
    const sheetList = metadataResponse.sheets;
    const structure = sheetList.map((sheet) => ({
        sheetId: sheet.sheetId,
        titleHash: hash(sheet.title),
        rowCount: sheet.rowCount,
        columnCount: sheet.columnCount,
        hidden: sheet.hidden,
        chartsHash: hash(sheet.charts),
        tablesHash: hash(sheet.tables),
    }));
    const observedStructure = {
        title: metadataResponse.title,
        sheets: sheetList.map((sheet) => ({
            sheetId: sheet.sheetId,
            title: sheet.title,
            rowCount: sheet.rowCount,
            columnCount: sheet.columnCount,
            hidden: sheet.hidden,
            // `structure` above fingerprints the complete chart spec. Return the
            // same bounded object to the caller so a successor never grants
            // authority over a chart configuration that the caller did not see.
            charts: sheet.charts.map((chart) => ({
                chartId: chart.chartId,
                position: chart.position,
                spec: chart.spec,
            })),
            tables: sheet.tables.map((table) => ({ tableId: table.tableId, name: table.name, range: table.range })),
        })),
    };
    return {
        version,
        fingerprint: hash({ kind: SHEETS_STRUCTURE_KIND, structure }),
        // Structural writes recompute this full fingerprint immediately before
        // the request and use the freshly observed `sheets` for object lookup.
        // Retaining the entire structure in handle metadata adds no authority
        // and would make an ordinary large workbook exceed a private budget.
        metadata: { kind: SHEETS_STRUCTURE_KIND },
        sheets: sheetList,
        title: metadataResponse.title,
        observedStructure,
    };
}

/**
 * A newly-created spreadsheet can safely seed its actual empty default grid.
 * The grid is capped at the normal handle budget and is checked from the
 * canonical value projection, rather than trusting the create request.
 */
export async function readNewSpreadsheetBlankGridBaseline({ drive, sheets, spreadsheetId }) {
    const structure = await readSheetsStructureBaseline({ drive, sheets, spreadsheetId });
    const firstSheet = structure.sheets[0];
    if (!Number.isSafeInteger(firstSheet?.rowCount) || !Number.isSafeInteger(firstSheet?.columnCount) ||
        firstSheet.rowCount < 1 || firstSheet.columnCount < 1) {
        throw publicError('Google did not return a bounded initial sheet grid. Call readSpreadsheet before writing.');
    }
    const columns = Math.min(firstSheet.columnCount, MAX_COLUMN_INDEX + 1, MAX_CELLS_PER_RANGE);
    const rows = Math.min(firstSheet.rowCount, Math.floor(MAX_CELLS_PER_RANGE / columns));
    const range = `${quoteSheetTitle(firstSheet.title)}!A1:${indexToColumn(columns - 1)}${rows}`;
    const baseline = await readSheetsValueBaseline({ drive, sheets, spreadsheetId, ranges: [range] });
    if (!baseline.isEmpty) {
        throw publicError('The created spreadsheet is not an empty default grid. Call readSpreadsheet for the exact range before writing.');
    }
    return baseline;
}

async function issueResourceHandle({ resourceKind, resourceId, version, fingerprint, metadata }) {
    if (!isHandleRuntimeActive()) return null;
    const context = getRequestContext();
    const store = getReadHandleStore();
    syncRuntimeBinding(context);
    try {
        const issued = store.issue({
            resourceKind,
            resourceId,
            scope: 'resource',
            version,
            structuralFingerprint: fingerprint,
            metadata,
        });
        setResultHandle(issued.readHandle, issued.expiresAt);
        return issued;
    } catch (error) {
        throw asPublic(error);
    }
}

export function mintSheetsReadHandle(spreadsheetId, baseline) {
    return issueResourceHandle({
        resourceKind: 'sheets', resourceId: spreadsheetId,
        version: baseline.version, fingerprint: baseline.fingerprint, metadata: baseline.metadata,
    });
}

export function driveFileBaseline(file, expectedId = file?.id) {
    if (!file || file.id !== expectedId || !isVersion(file.version)) {
        throw publicError('Google did not return usable current metadata for this Drive file. Call getFileInfo again.');
    }
    const observable = {
        id: file.id,
        name: file.name ?? null,
        mimeType: file.mimeType ?? null,
        parents: Array.isArray(file.parents) ? [...file.parents].sort() : [],
        trashed: Boolean(file.trashed),
        modifiedTime: file.modifiedTime ?? null,
        version: file.version,
    };
    return {
        version: file.version,
        fingerprint: hash({ kind: DRIVE_FILE_KIND, observable }),
        metadata: { kind: DRIVE_FILE_KIND },
    };
}

export function mintDriveReadHandle(fileId, file) {
    const baseline = driveFileBaseline(file, fileId);
    return issueResourceHandle({
        resourceKind: 'drive', resourceId: fileId,
        version: baseline.version, fingerprint: baseline.fingerprint, metadata: baseline.metadata,
    });
}

async function acquireMutationLock(key) {
    const previous = mutationTails.get(key) ?? Promise.resolve();
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    const queued = previous.then(() => gate);
    mutationTails.set(key, queued);
    await previous;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        releaseGate();
        if (mutationTails.get(key) === queued) mutationTails.delete(key);
    };
}

function legacySheetsLease(spreadsheetId, { structure = null, sheets = null } = {}) {
    return {
        active: false,
        // Direct/internal callers predate explicit handles. Keep their
        // read-tracker fallback working, while supplying the metadata that
        // structure and copy-format tools need to resolve an ID safely.
        structure,
        sheets,
        async write(perform) {
            try {
                const response = await perform();
                trackMutation(spreadsheetId);
                return response;
            } catch (error) {
                throw error;
            }
        },
        async abort() {},
    };
}

function assertValueTargets(metadata, targets) {
    if (metadata?.kind !== SHEETS_VALUES_KIND) {
        throw publicError('This readHandle authorizes spreadsheet structure only. Read the values in the range you intend to change.');
    }
    const ranges = normalizeBaselineRanges(metadata.ranges);
    for (const target of targets) {
        if (!ranges.some((range) => contains(range, target))) throw publicError(SHEETS_SCOPE_REQUIRED);
    }
}

function assertNoOverlaps(targets) {
    for (let left = 0; left < targets.length; left += 1) {
        for (let right = left + 1; right < targets.length; right += 1) {
            if (overlaps(targets[left], targets[right])) {
                throw publicError('Batch writes may not contain overlapping output ranges. Split the write into an ordered sequence after a fresh read.');
            }
        }
    }
}

function outputExtent(range, values) {
    if (!Array.isArray(values) || values.length === 0 || !values.every(Array.isArray)) {
        throw publicError('A write must contain at least one row of values.');
    }
    const columns = Math.max(...values.map((row) => row.length));
    if (columns < 1) throw publicError('A write must contain at least one value column.');
    const target = {
        ...range,
        endRow: range.startRow + values.length,
        endColumn: range.startColumn + columns,
    };
    return target;
}

/** Canonicalize a write's requested range and derive the actual values output extent. */
export async function prepareSheetValueTargets(sheets, spreadsheetId, entries, { clear = false } = {}) {
    const metadata = (await getSheetMetadata(sheets, spreadsheetId)).sheets;
    const targets = entries.map((entry) => {
        const range = canonicalizeSheetRange(entry.range, metadata);
        return clear ? range : outputExtent(range, entry.values);
    });
    assertNoOverlaps(targets);
    return targets;
}

/** Canonicalize bounded cells changed by a formatting or validation mutation. */
export async function prepareSheetRangeTargets(sheets, spreadsheetId, ranges) {
    const metadata = (await getSheetMetadata(sheets, spreadsheetId)).sheets;
    const targets = ranges.map((range) => canonicalizeSheetRange(range, metadata));
    assertNoOverlaps(targets);
    return targets;
}

/**
 * Reserve a resource handle, serialize same-service mutations, reread the
 * canonical baseline, and hold that lock until the API result is settled.
 */
export async function beginSheetsMutation({ spreadsheetId, readHandle, drive, sheets, targets, legacyGuard = null }) {
    if (!isHandleRuntimeActive()) {
        if (legacyGuard) await legacyGuard();
        return legacySheetsLease(spreadsheetId);
    }
    if (typeof readHandle !== 'string' || readHandle.length === 0) throw publicError(SHEETS_HANDLE_REQUIRED);
    const context = getRequestContext();
    const store = getReadHandleStore();
    syncRuntimeBinding(context);
    const expected = { resourceKind: 'sheets', resourceId: spreadsheetId, scope: 'resource', tabId: null };
    let rawLease;
    try {
        rawLease = store.beginMutation(readHandle, { expected });
    } catch (error) {
        throw asPublic(error);
    }
    const release = await acquireMutationLock(`sheets:${spreadsheetId}`);
    let settled = false;
    const abort = async () => {
        if (settled) return;
        settled = true;
        try { store.abortBeforeWrite(rawLease.operationId, { expected }); } catch { /* original failure wins */ }
        release();
    };
    try {
        const metadata = store.getInternalMetadata(readHandle, { expected });
        assertValueTargets(metadata, targets);
        assertNoOverlaps(targets);
        const descriptors = normalizeBaselineRanges(metadata.ranges);
        const current = await readSheetsValueBaseline({ drive, sheets, spreadsheetId, descriptors });
        const record = rawLease.record;
        if (current.version !== record.version || current.fingerprint !== record.structuralFingerprint) {
            await abort();
            throw publicError(SHEETS_REREAD_REQUIRED);
        }
        return {
            active: true,
            async write(perform) {
                let response;
                try {
                    response = await perform();
                } catch (error) {
                    if (!settled) {
                        settled = true;
                        try { store.completeAfterWriteFailure(rawLease.operationId, { expected }); } catch { /* preserve API error */ }
                        release();
                    }
                    throw error;
                }
                try {
                    const observed = await readSheetsValueBaseline({ drive, sheets, spreadsheetId, descriptors });
                    const successor = store.completeSuccess(rawLease.operationId, {
                        version: observed.version,
                        structuralFingerprint: observed.fingerprint,
                        metadata: observed.metadata,
                    }, { expected });
                    settled = true;
                    release();
                    setResultHandle(successor.readHandle, successor.expiresAt);
                    setResultResourceState({
                        kind: 'sheets-values-v1',
                        ranges: observed.displayRanges,
                    });
                } catch {
                    if (!settled) {
                        settled = true;
                        try { store.completeAfterWriteFailure(rawLease.operationId, { expected }); } catch { /* best effort */ }
                        release();
                    }
                    setResultWarning('The Sheets write returned successfully, but its post-write state could not be observed. Its handle was invalidated; read the affected range before another mutation.');
                }
                return response;
            },
            abort,
        };
    } catch (error) {
        await abort();
        throw error;
    }
}

/**
 * Same lease protocol as value writes, using the format/validation projection
 * captured by readCellFormat. Formatting writes must not rely on Drive version
 * alone because it can lag while a collaborator changes the target cells.
 */
export async function beginSheetsCellStateMutation({
    spreadsheetId,
    readHandle,
    drive,
    sheets,
    targets,
    legacyGuard = null,
}) {
    if (!isHandleRuntimeActive()) {
        if (legacyGuard) await legacyGuard();
        const metadata = await getSheetMetadata(sheets, spreadsheetId);
        return legacySheetsLease(spreadsheetId, { sheets: metadata.sheets });
    }
    if (typeof readHandle !== 'string' || readHandle.length === 0)
        throw publicError(SHEETS_HANDLE_REQUIRED);
    const context = getRequestContext();
    const store = getReadHandleStore();
    syncRuntimeBinding(context);
    const expected = {
        resourceKind: 'sheets',
        resourceId: spreadsheetId,
        scope: 'resource',
        tabId: null,
    };
    let rawLease;
    try {
        rawLease = store.beginMutation(readHandle, { expected });
    } catch (error) {
        throw asPublic(error);
    }
    const release = await acquireMutationLock(`sheets:${spreadsheetId}`);
    let settled = false;
    const abort = async () => {
        if (settled) return;
        settled = true;
        try {
            store.abortBeforeWrite(rawLease.operationId, { expected });
        } catch {
            /* original error wins */
        }
        release();
    };
    try {
        const metadata = store.getInternalMetadata(readHandle, { expected });
        if (metadata?.kind !== SHEETS_CELL_STATE_KIND) {
            throw publicError(
                'This mutation requires a handle returned by readCellFormat for the exact bounded destination range.',
            );
        }
        assertValueTargets(
            { kind: SHEETS_VALUES_KIND, ranges: metadata.ranges },
            targets,
        );
        assertNoOverlaps(targets);
        const descriptors = normalizeBaselineRanges(metadata.ranges);
        const current = await readSheetsCellStateBaseline({
            drive,
            sheets,
            spreadsheetId,
            descriptors,
        });
        if (
            current.version !== rawLease.record.version ||
            current.fingerprint !== rawLease.record.structuralFingerprint
        ) {
            await abort();
            throw publicError(SHEETS_REREAD_REQUIRED);
        }
        return {
            active: true,
            sheets: current.sheets,
            async write(perform) {
                let response;
                try {
                    response = await perform();
                } catch (error) {
                    if (!settled) {
                        settled = true;
                        try {
                            store.completeAfterWriteFailure(
                                rawLease.operationId,
                                { expected },
                            );
                        } catch {
                            /* preserve API error */
                        }
                        release();
                    }
                    throw error;
                }
                try {
                    const observed = await readSheetsCellStateBaseline({
                        drive,
                        sheets,
                        spreadsheetId,
                        descriptors,
                    });
                    const successor = store.completeSuccess(
                        rawLease.operationId,
                        {
                            version: observed.version,
                            structuralFingerprint: observed.fingerprint,
                            metadata: observed.metadata,
                        },
                        { expected },
                    );
                    settled = true;
                    release();
                    setResultHandle(successor.readHandle, successor.expiresAt);
                    setResultResourceState({
                        kind: SHEETS_CELL_STATE_KIND,
                        ranges: observed.displayRanges,
                    });
                } catch {
                    if (!settled) {
                        settled = true;
                        try {
                            store.completeAfterWriteFailure(
                                rawLease.operationId,
                                { expected },
                            );
                        } catch {
                            /* best effort */
                        }
                        release();
                    }
                    setResultWarning(
                        'The Sheets formatting write returned successfully, but its post-write state could not be observed. Its handle was invalidated; call readCellFormat before another formatting mutation.',
                    );
                }
                return response;
            },
            abort,
        };
    } catch (error) {
        await abort();
        throw error;
    }
}

// Capture the full current height, including blank cells that may have acquired
// values since the read. Validate before reserving a destructive API operation.
function deletionTargets(structure, deletion) {
    const sheet =
        deletion.sheetId !== undefined
            ? structure.find((item) => item.sheetId === deletion.sheetId)
            : deletion.sheetName
              ? structure.find((item) => item.title === deletion.sheetName)
              : structure[0];
    if (!sheet)
        throw publicError(
            'The requested sheet is not present. Call getSpreadsheetInfo again.',
        );
    const columns = deletion.columns ?? [
        { startIndex: 1, endIndex: sheet.columnCount },
    ];
    const targets = columns.map(({ startIndex, endIndex }) => {
        if (
            !Number.isSafeInteger(startIndex) ||
            !Number.isSafeInteger(endIndex) ||
            startIndex < 1 ||
            endIndex < startIndex ||
            endIndex > sheet.columnCount
        ) {
            throw publicError(
                'Deletion column ranges must be ordered, non-overlapping, and inside the current sheet grid.',
            );
        }
        return {
            sheetId: sheet.sheetId,
            titleHash: hash(sheet.title),
            startRow: 0,
            endRow: sheet.rowCount,
            startColumn: startIndex - 1,
            endColumn: endIndex,
        };
    });
    assertNoOverlaps(targets);
    return targets;
}

export async function beginSheetsStructureMutation({
    spreadsheetId,
    readHandle,
    drive,
    sheets,
    legacyGuard = null,
    valueReadHandle,
    deletion = null,
}) {
    if (!isHandleRuntimeActive()) {
        if (legacyGuard) await legacyGuard();
        const metadata = await getSheetMetadata(sheets, spreadsheetId, {
            includeObjects: true,
        });
        if (deletion) deletionTargets(metadata.sheets, deletion);
        return legacySheetsLease(spreadsheetId, {
            structure: metadata.sheets,
            sheets: metadata.sheets,
        });
    }
    if (typeof readHandle !== 'string' || readHandle.length === 0)
        throw publicError(SHEETS_HANDLE_REQUIRED);
    const context = getRequestContext();
    const store = getReadHandleStore();
    syncRuntimeBinding(context);
    const expected = {
        resourceKind: 'sheets',
        resourceId: spreadsheetId,
        scope: 'resource',
        tabId: null,
    };
    let rawLease;
    try {
        rawLease = store.beginMutation(readHandle, { expected });
    } catch (error) {
        throw asPublic(error);
    }
    const release = await acquireMutationLock(`sheets:${spreadsheetId}`);
    let valueLease;
    let settled = false;
    const abort = async () => {
        if (settled) return;
        settled = true;
        try {
            store.abortBeforeWrite(rawLease.operationId, { expected });
        } catch {
            /* original error wins */
        }
        if (valueLease) {
            try {
                store.abortBeforeWrite(valueLease.operationId, { expected });
            } catch {
                /* original error wins */
            }
        }
        release();
    };
    try {
        const metadata = store.getInternalMetadata(readHandle, { expected });
        if (metadata?.kind !== SHEETS_STRUCTURE_KIND)
            throw publicError(
                'This mutation requires a handle returned by getSpreadsheetInfo.',
            );
        const current = await readSheetsStructureBaseline({
            drive,
            sheets,
            spreadsheetId,
        });
        if (
            current.version !== rawLease.record.version ||
            current.fingerprint !== rawLease.record.structuralFingerprint
        ) {
            await abort();
            throw publicError(SHEETS_REREAD_REQUIRED);
        }
        if (deletion) {
            if (typeof valueReadHandle !== 'string' || !valueReadHandle) {
                throw publicError(
                    'This deletion also requires valueReadHandle from readSpreadsheet covering every cell being deleted, including blank rows.',
                );
            }
            try {
                valueLease = store.beginMutation(valueReadHandle, { expected });
            } catch (error) {
                throw asPublic(error);
            }
            const valueMetadata = store.getInternalMetadata(valueReadHandle, {
                expected,
            });
            assertValueTargets(
                valueMetadata,
                deletionTargets(current.sheets, deletion),
            );
            const observed = await readSheetsValueBaseline({
                drive,
                sheets,
                spreadsheetId,
                descriptors: normalizeBaselineRanges(valueMetadata.ranges),
            });
            if (
                observed.version !== valueLease.record.version ||
                observed.fingerprint !== valueLease.record.structuralFingerprint
            ) {
                throw publicError(SHEETS_REREAD_REQUIRED);
            }
        }
        return {
            active: true,
            structure: current.sheets,
            async write(perform) {
                let response;
                try {
                    response = await perform();
                } catch (error) {
                    if (!settled) {
                        settled = true;
                        try {
                            store.completeAfterWriteFailure(
                                rawLease.operationId,
                                { expected },
                            );
                        } catch {
                            /* preserve error */
                        }
                        if (valueLease) {
                            try {
                                store.completeAfterWriteFailure(
                                    valueLease.operationId,
                                    { expected },
                                );
                            } catch {
                                /* preserve error */
                            }
                        }
                        release();
                    }
                    throw error;
                }
                if (valueLease) {
                    // Deletion changes grid coordinates or removes the sheet. Neither
                    // pre-delete projection can safely become a successor capability.
                    for (const lease of [rawLease, valueLease]) {
                        try {
                            store.completeConsumed(lease.operationId, {
                                expected,
                            });
                        } catch {
                            try {
                                store.completeAfterWriteFailure(
                                    lease.operationId,
                                    { expected },
                                );
                            } catch {
                                /* already invalidated */
                            }
                            setResultWarning(
                                'Deletion succeeded; reread structure and values before another mutation.',
                            );
                        }
                    }
                    settled = true;
                    release();
                    return response;
                }
                try {
                    const observed = await readSheetsStructureBaseline({
                        drive,
                        sheets,
                        spreadsheetId,
                    });
                    const successor = store.completeSuccess(
                        rawLease.operationId,
                        {
                            version: observed.version,
                            structuralFingerprint: observed.fingerprint,
                            metadata: observed.metadata,
                        },
                        { expected },
                    );
                    settled = true;
                    release();
                    setResultHandle(successor.readHandle, successor.expiresAt);
                    setResultResourceState({
                        kind: SHEETS_STRUCTURE_KIND,
                        structure: observed.observedStructure,
                    });
                } catch {
                    if (!settled) {
                        settled = true;
                        try {
                            store.completeAfterWriteFailure(
                                rawLease.operationId,
                                { expected },
                            );
                        } catch {
                            /* best effort */
                        }
                        release();
                    }
                    setResultWarning(
                        'The Sheets mutation returned successfully, but its post-write structure could not be observed. Its handle was invalidated; call getSpreadsheetInfo before another structural mutation.',
                    );
                }
                return response;
            },
            abort,
        };
    } catch (error) {
        await abort();
        throw error;
    }
}

export async function beginDriveDeletion({ fileId, readHandle, drive, legacyGuard = null }) {
    if (!isHandleRuntimeActive()) {
        if (legacyGuard) await legacyGuard();
        return {
            active: false,
            async remove(perform) { return perform(); },
            async abort() {},
        };
    }
    if (typeof readHandle !== 'string' || readHandle.length === 0) throw publicError(DRIVE_HANDLE_REQUIRED);
    const context = getRequestContext();
    const store = getReadHandleStore();
    syncRuntimeBinding(context);
    const expected = { resourceKind: 'drive', resourceId: fileId, scope: 'resource', tabId: null };
    let rawLease;
    try { rawLease = store.beginMutation(readHandle, { expected }); } catch (error) { throw asPublic(error); }
    const release = await acquireMutationLock(`drive:${fileId}`);
    let settled = false;
    const abort = async () => {
        if (settled) return;
        settled = true;
        try { store.abortBeforeWrite(rawLease.operationId, { expected }); } catch { /* original error wins */ }
        release();
    };
    try {
        const metadata = store.getInternalMetadata(readHandle, { expected });
        if (metadata?.kind !== DRIVE_FILE_KIND) throw publicError('This readHandle cannot authorize a Drive deletion. Call getFileInfo first.');
        const fileResponse = await drive.files.get({
            fileId,
            fields: 'id,name,mimeType,parents,trashed,modifiedTime,version',
            supportsAllDrives: true,
        });
        const file = fileResponse?.data;
        let current;
        try { current = driveFileBaseline(file, fileId); }
        catch {
            await abort();
            throw publicError(DRIVE_REREAD_REQUIRED);
        }
        if (file.trashed || current.version !== rawLease.record.version || current.fingerprint !== rawLease.record.structuralFingerprint) {
            await abort();
            throw publicError(DRIVE_REREAD_REQUIRED);
        }
        return {
            active: true,
            file,
            async remove(perform) {
                try {
                    const response = await perform();
                    store.completeConsumed(rawLease.operationId, { expected });
                    settled = true;
                    release();
                    return response;
                } catch (error) {
                    if (!settled) {
                        settled = true;
                        try { store.completeAfterWriteFailure(rawLease.operationId, { expected }); } catch { /* preserve API error */ }
                        release();
                    }
                    throw error;
                }
            },
            abort,
        };
    } catch (error) {
        await abort();
        throw error;
    }
}

export function valueWriteExtent(range, values) {
    return outputExtent(range, values);
}
