import { register as readSpreadsheet } from './readSpreadsheet.js';
import { register as writeSpreadsheet } from './writeSpreadsheet.js';
import { register as batchWrite } from './batchWrite.js';
import { register as appendSpreadsheetRows } from './appendSpreadsheetRows.js';
import { register as clearSpreadsheetRange } from './clearSpreadsheetRange.js';
import { register as getSpreadsheetInfo } from './getSpreadsheetInfo.js';
import { register as addSpreadsheetSheet } from './addSpreadsheetSheet.js';
import { register as createSpreadsheet } from './createSpreadsheet.js';
import { register as deleteSheet } from './deleteSheet.js';
import { register as renameSheet } from './renameSheet.js';
import { register as duplicateSheet } from './duplicateSheet.js';
// Formatting & validation
import { register as formatCells } from './formatCells.js';
import { register as readCellFormat } from './readCellFormat.js';
import { register as copyFormatting } from './copyFormatting.js';
import { register as freezeRowsAndColumns } from './freezeRowsAndColumns.js';
import { register as setColumnWidths } from './setColumnWidths.js';
import { register as autoResizeColumns } from './autoResizeColumns.js';
import { register as setDropdownValidation } from './setDropdownValidation.js';
import { register as addConditionalFormatting } from './addConditionalFormatting.js';
import { register as groupRows } from './groupRows.js';
import { register as ungroupAllRows } from './ungroupAllRows.js';
// Tables
import { register as createTable } from './createTable.js';
import { register as listTables } from './listTables.js';
import { register as getTable } from './getTable.js';
import { register as deleteTable } from './deleteTable.js';
import { register as updateTableRange } from './updateTableRange.js';
import { register as appendTableRows } from './appendTableRows.js';
import { register as insertChart } from './insertChart.js';
import { register as deleteChart } from './deleteChart.js';
export function registerSheetsTools(server) {
    readSpreadsheet(server);
    writeSpreadsheet(server);
    batchWrite(server);
    appendSpreadsheetRows(server);
    clearSpreadsheetRange(server);
    getSpreadsheetInfo(server);
    addSpreadsheetSheet(server);
    createSpreadsheet(server);
    deleteSheet(server);
    renameSheet(server);
    duplicateSheet(server);
    // Formatting & validation
    formatCells(server);
    readCellFormat(server);
    copyFormatting(server);
    freezeRowsAndColumns(server);
    setColumnWidths(server);
    autoResizeColumns(server);
    setDropdownValidation(server);
    addConditionalFormatting(server);
    groupRows(server);
    ungroupAllRows(server);
    // Tables
    createTable(server);
    listTables(server);
    getTable(server);
    deleteTable(server);
    updateTableRange(server);
    appendTableRows(server);
    insertChart(server);
    deleteChart(server);
}
