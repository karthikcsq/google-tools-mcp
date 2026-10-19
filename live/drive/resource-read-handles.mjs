// Resource-handle acceptance against the real loopback HTTP transport.
//
// Creation uses ctx.call so the existing live-smoke guard, journal, and cleanup
// registry own every file. The read/mutate sequence then goes through an actual
// TCP loopback HTTP server built from this worktree's production registrations
// and wrappers. No file outside ctx.folderId is ever named by a mutation.
export const name = 'resource-read-handles';
export const issue = '156-159';
export const description = 'HTTP Sheets and Drive handles allow a bounded flow, reject stale state, and clean up owned artifacts.';
export const expectedOnBase = 'pass';

function textOf(result) {
    return (result?.content ?? []).map((entry) => entry?.text ?? '').join('\n');
}

function assertOk(ctx, result, label) {
    ctx.assert(!result?.isError, `${label} failed: ${textOf(result)}`);
    ctx.assert(typeof result?.readHandle === 'string' && result.readHandle.length > 20,
        `${label} did not return a usable readHandle.`);
    return result.readHandle;
}

export async function run(ctx) {
    const spreadsheet = JSON.parse(await ctx.call('createSpreadsheet', {
        title: ctx.title('#156 Sheets HTTP handle'),
        parentFolderId: ctx.folderId,
    }));
    ctx.track(spreadsheet.id, 'drive');

    const document = await ctx.createDoc(ctx.title('#159 Drive HTTP delete'), ctx.fixture('issue-124-copy-source.md'));
    const http = await ctx.startLoopbackMcp();
    try {
        const range = 'Sheet1!A1:B2';
        const read = await http.call('readSpreadsheet', { spreadsheetId: spreadsheet.id, range });
        const firstHandle = assertOk(ctx, read, 'HTTP readSpreadsheet');

        const write = await http.call('writeSpreadsheet', {
            spreadsheetId: spreadsheet.id,
            range,
            values: [['first', 'write'], ['one', 'two']],
            readHandle: firstHandle,
        });
        const writeHandle = assertOk(ctx, write, 'HTTP writeSpreadsheet');
        ctx.assertIncludes(textOf(write), 'Observed post-write state', 'write successor did not expose observed state in text output.');

        const batch = await http.call('batchWrite', {
            spreadsheetId: spreadsheet.id,
            data: [{ range, values: [['batch', 'write'], ['three', 'four']] }],
            readHandle: writeHandle,
        });
        const batchHandle = assertOk(ctx, batch, 'HTTP batchWrite');

        // Keep an independent read handle, mutate the actual range with the
        // batch successor, then prove the unchanged-version value comparison
        // rejects the old read before it can reach Google.
        const staleRead = await http.call('readSpreadsheet', { spreadsheetId: spreadsheet.id, range });
        const staleHandle = assertOk(ctx, staleRead, 'HTTP stale baseline read');
        const clear = await http.call('clearRange', {
            spreadsheetId: spreadsheet.id, range, readHandle: batchHandle,
        });
        assertOk(ctx, clear, 'HTTP clearRange');
        const stale = await http.call('writeSpreadsheet', {
            spreadsheetId: spreadsheet.id, range, values: [['must', 'fail']], readHandle: staleHandle,
        });
        ctx.assert(stale?.isError === true, 'A stale Sheets handle was accepted after clearRange.');
        ctx.assertMatch(textOf(stale), /changed|read again|authorize/i,
            'Stale Sheets handle returned an unrelated error.');

        const formatRead = await http.call('readCellFormat', { spreadsheetId: spreadsheet.id, range });
        const formatHandle = assertOk(ctx, formatRead, 'HTTP format baseline');
        const unboundedFormat = await http.call('formatCells', {
            spreadsheetId: spreadsheet.id, range: '1:1', bold: true, readHandle: formatHandle,
        });
        ctx.assert(unboundedFormat.isError === true, 'Modern formatting accepted an unbounded row.');
        ctx.assertMatch(textOf(unboundedFormat), /bounded A1/i, 'Unbounded modern formatting returned an unrelated failure.');
        const formatted = await http.call('formatCells', {
            spreadsheetId: spreadsheet.id, range, bold: true, readHandle: formatHandle,
        });
        assertOk(ctx, formatted, 'HTTP bounded formatting');
        const formatAfter = await http.call('readCellFormat', { spreadsheetId: spreadsheet.id, range });
        assertOk(ctx, formatAfter, 'HTTP format readback');
        const visibleFormat = JSON.parse(formatAfter.content[0].text);
        ctx.assert(visibleFormat.cells.some((cell) => cell.userEnteredFormat?.textFormat?.bold === true), 'Bold formatting was absent from Google readback.');

        // Direct legacy callers keep their tracker-based whole-axis behavior.
        await ctx.call('readCellFormat', { spreadsheetId: spreadsheet.id, range });
        await ctx.call('formatCells', { spreadsheetId: spreadsheet.id, range: '1:1', bold: false });
        const rowReadback = JSON.parse(await ctx.call('readCellFormat', { spreadsheetId: spreadsheet.id, range }));
        ctx.assert(rowReadback.cells.some((cell) => cell.cell === 'B1' && cell.userEnteredFormat?.textFormat?.bold === false), 'Legacy whole-row formatting did not reach Google.');
        await ctx.call('formatCells', { spreadsheetId: spreadsheet.id, range: 'A:A', italic: true });
        const legacyReadback = JSON.parse(await ctx.call('readCellFormat', { spreadsheetId: spreadsheet.id, range: 'A1' }));
        ctx.assert(legacyReadback.cells.some((cell) => cell.userEnteredFormat?.textFormat?.italic === true), 'Legacy whole-column formatting did not reach Google.');

        // getFileInfo carries the observed metadata baseline. Rename through
        // the guard first, then the original HTTP handle must reject. A fresh
        // metadata handle is the only authority that can trash this owned doc.
        const oldInfo = await http.call('getFileInfo', { fileId: document.id });
        const oldDriveHandle = assertOk(ctx, oldInfo, 'HTTP getFileInfo');
        await ctx.call('getFileInfo', { fileId: document.id });
        await ctx.call('renameFile', { fileId: document.id, newName: ctx.title('#159 renamed before delete') });
        const staleDelete = await http.call('deleteFile', { fileId: document.id, readHandle: oldDriveHandle });
        ctx.assert(staleDelete?.isError === true, 'A stale Drive deletion handle was accepted after rename.');
        ctx.assertMatch(textOf(staleDelete), /changed|again|metadata/i,
            'Stale Drive deletion handle returned an unrelated error.');

        const freshInfo = await http.call('getFileInfo', { fileId: document.id });
        const deleteHandle = assertOk(ctx, freshInfo, 'fresh HTTP getFileInfo');
        const trashed = await http.call('deleteFile', { fileId: document.id, readHandle: deleteHandle });
        ctx.assert(!trashed?.isError, `HTTP deleteFile failed: ${textOf(trashed)}`);
        ctx.assertIncludes(textOf(trashed), 'trashed', 'HTTP deleteFile did not report the trash disposition.');
        ctx.assert(!trashed.readHandle, 'A terminal Drive deletion returned a successor handle.');
    } finally {
        await http.close();
    }
}
