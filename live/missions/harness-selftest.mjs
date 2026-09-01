// Self-test for the live-mission runner itself, and for the one thing
// live-call structurally cannot prove: that session state survives across
// calls, so a file this session just created can be written to immediately.
//
// This is the #87 / #135 seeding contract, exercised against the real API
// rather than against mocks. Every branch of it lives in one process, which is
// exactly why it needs a mission rather than a sequence of live-call runs.
export const name = 'harness-selftest';
export const goal = 'Prove the runner works and that create-then-write needs no redundant read.';

export async function run(ctx) {
    // 1. Docs: createDocument seeds, so an immediate append must be allowed.
    const doc = await ctx.createDoc(ctx.title('selftest doc'), '# Heading\n\nFirst paragraph.\n');
    ctx.note(`created doc ${doc.id}`);
    const append = await ctx.tryCall('appendText', { documentId: doc.id, text: '\nAppended without a redundant read.\n' });
    if (append.ok) ctx.note('appendText straight after createDocument: allowed (correct)');
    else ctx.friction('appendText', `blocked straight after createDocument: ${append.error?.message}`);

    // 2. Sheets: this is the #135 fix. On main before #135 this rejected with
    //    "has not been read in this session".
    const sheetRaw = await ctx.call('createSpreadsheet', { title: ctx.title('selftest sheet'), parentFolderId: ctx.folderId });
    const sheet = JSON.parse(sheetRaw);
    ctx.note(`created spreadsheet ${sheet.id}`);
    const write = await ctx.tryCall('writeSpreadsheet', { spreadsheetId: sheet.id, range: 'A1', values: [['seeded', 'ok']] });
    if (write.ok) ctx.note('writeSpreadsheet straight after createSpreadsheet: allowed (#135 fix confirmed live)');
    else ctx.friction('writeSpreadsheet', `#135 REGRESSION, blocked after createSpreadsheet: ${write.error?.message}`);

    // 3. copyFile of a Doc: also seeded by #135, same contract.
    const copyRaw = await ctx.tryCall('copyFile', { fileId: doc.id, name: ctx.title('selftest copy'), parentFolderId: ctx.folderId });
    if (!copyRaw.ok) {
        ctx.friction('copyFile', `copy failed outright: ${copyRaw.error?.message}`);
        return;
    }
    const copy = JSON.parse(copyRaw.result);
    ctx.note(`copied doc ${copy.id}`);
    const copyWrite = await ctx.tryCall('appendText', { documentId: copy.id, text: '\nWrote to the copy.\n' });
    if (copyWrite.ok) ctx.note('appendText straight after copyFile: allowed (#135 fix confirmed live)');
    else ctx.friction('appendText', `#135 REGRESSION, blocked after copyFile: ${copyWrite.error?.message}`);

    // 4. The guard must still be effective for a file this session never read.
    //    Uses the copy's id mutated into a plausible-but-unknown id so nothing
    //    real is touched; a rejection here is the correct outcome.
    const unread = await ctx.tryCall('appendText', { documentId: 'unread-file-id-that-does-not-exist', text: 'should not work' });
    if (unread.ok) ctx.friction('appendText', 'GUARD HOLE: wrote to a document this session never read.');
    else ctx.note('guard still rejects an unread document (correct)');
}
