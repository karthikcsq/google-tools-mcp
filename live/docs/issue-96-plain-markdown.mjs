// Issue #96 -- readDocument has no plainMarkdown option, so HTML color spans
// leak into the primary editing path.
//
// The reporter's evidence, same document ID, same window, two tools:
//   readDocument                          -> [<span style="color:#1155cc">**Live 1-on-1 console**</span>](...)
//   readDriveFile with plainMarkdown:true -> [**Live 1-on-1 console**](...)
//
// readDocument is the documented editing path, so the tool that feeds the
// primary edit loop is the one that cannot produce clean markdown.
//
// Acceptance criteria from the report: readDocument accepts plainMarkdown
// (default false, no change to existing behaviour), and with plainMarkdown:true
// the output on a colored document contains no <span style=...>, matching
// readDriveFile on the same document and format.
export const name = 'issue-96-plain-markdown';
export const issue = 96;
export const description = 'readDocument must accept plainMarkdown and suppress HTML color spans, matching readDriveFile.';
export const expectedOnBase = 'fail';

const COLORED = 'Live 1-on-1 console';

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#96 plain markdown'), ctx.fixture('issue-96-colored-span.md'));
    await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });

    // Google Docs applies explicit colors liberally; this makes one explicitly,
    // so the fixture is a colored document the way theirs was.
    await ctx.call('modifyText', {
        documentId: doc.id,
        target: { textToFind: COLORED },
        style: { foregroundColor: '#1155cc' },
    });

    const rich = await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });
    ctx.assertIncludes(rich, '<span style=', 'Setup failed: the default readDocument output carries no color span to suppress.');

    const plain = await ctx.call('readDocument', { documentId: doc.id, format: 'markdown', plainMarkdown: true });
    const viaDriveFile = await ctx.call('readDriveFile', { fileId: doc.id, format: 'markdown', plainMarkdown: true });

    ctx.assertNotIncludes(
        viaDriveFile,
        '<span style=',
        'Setup failed: readDriveFile(plainMarkdown:true) still emitted a color span, so the comparison is meaningless.',
    );
    ctx.assertNotIncludes(
        plain,
        '<span style=',
        'readDocument ignored plainMarkdown and emitted a color span anyway; the documented editing path still cannot '
        + 'produce clean markdown while readDriveFile can (#96).',
    );
}
