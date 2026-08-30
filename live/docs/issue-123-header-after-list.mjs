// Issue #123 -- a header immediately after a list gets merged into the last
// list item by a read-then-write round trip with zero edits.
//
// Reporter's steps, in their order:
//   1. Make a doc with a bulleted list followed by a bold-text paragraph
//      acting as a header.
//   2. readDocument(format='markdown').
//   3. replaceDocumentWithMarkdown with the unmodified mirror file.
//   4. readDocument(format='text') -- the header is now glued onto the last
//      list item.
//
// The report diagnosed this as the exporter omitting the blank line after a
// list. That mechanism did not hold up on investigation, so this asserts on the
// OUTCOME the reporter actually observed -- a header glued onto a list item --
// rather than on the missing blank line they inferred.
export const name = 'issue-123-header-after-list';
export const issue = 123;
export const description = 'A header directly after a list must survive an unmodified markdown round trip as its own paragraph.';
export const expectedOnBase = 'fail';

const HEADER = 'Free Social Media Content';
const LAST_ITEM_TAIL = 'so nobody misses you.';

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#123 header after list'), ctx.fixture('issue-123-header-after-list.md'));

    // Step 2.
    const exported = await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });
    const mirror = ctx.rememberMirror(exported);
    ctx.assert(mirror, 'readDocument(format="markdown") did not report a local working-copy path.');
    const beforePush = await ctx.readMirror(mirror);
    ctx.assertIncludes(beforePush, HEADER, 'Setup failed: the header is missing from the export.');

    // Step 3: push the unmodified mirror. Zero edits.
    await ctx.call('replaceDocumentWithMarkdown', { documentId: doc.id, filePath: mirror });

    // Step 4.
    const text = await ctx.call('readDocument', { documentId: doc.id, format: 'text' });
    ctx.assertNotIncludes(
        text,
        LAST_ITEM_TAIL + ' ' + HEADER,
        'The header was merged into the last list item by a zero-edit round trip (#123).',
    );
    ctx.assertMatch(
        text,
        new RegExp('(^|\\n)\\s*' + HEADER + '\\s*(\\n|$)'),
        'The header is no longer a paragraph of its own after the round trip (#123).',
    );
}
