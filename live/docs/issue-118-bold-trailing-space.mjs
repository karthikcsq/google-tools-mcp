// Issue #118 -- replaceDocumentWithMarkdown emits literal ** / ~~ into the doc
// when a delimiter has a trailing space.
//
// Reporter's steps, in their order:
//   1. readDocument(format='markdown') on a doc containing a bold run whose
//      range includes a trailing space. The exporter emits `**Owner: Andres. **`.
//   2. Edit the working copy elsewhere; leave that span untouched.
//   3. replaceDocumentWithMarkdown(filePath=...).
//   4. The doc now shows literal ** around that text and the bold is gone.
//
// The report is explicit that re-reading as markdown CANNOT verify the push --
// "bold run including a trailing space" and "four literal asterisks" export to
// the identical string. format='text' is the diagnostic, so that is what the
// assertion looks at.
export const name = 'issue-118-bold-trailing-space';
export const issue = 118;
export const description = 'A zero-edit markdown export/re-import round trip must not leave literal ** or ~~ in the document.';
export const expectedOnBase = 'fail';

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#118 bold trailing space'), ctx.fixture('issue-118-bold-trailing-space.md'));

    // createDocument does not register as a read, so read before every write.
    await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });

    // The setup the report describes: users bold a label AND the space after
    // it, so the styled range includes a trailing space.
    await ctx.call('modifyText', {
        documentId: doc.id,
        target: { textToFind: 'Owner: Andres. ' },
        style: { bold: true },
    });
    await ctx.call('modifyText', {
        documentId: doc.id,
        target: { textToFind: 'Dropped from scope. ' },
        style: { strikethrough: true },
    });

    // Step 1: export.
    const exported = await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });
    const mirror = ctx.rememberMirror(exported);
    ctx.assert(mirror, 'readDocument(format="markdown") did not report a local working-copy path.');

    const beforePush = await ctx.readMirror(mirror);
    ctx.assertIncludes(beforePush, 'Owner: Andres.', 'Setup failed: the bold label is missing from the export.');

    // Steps 2 and 3: the span is left untouched and the unmodified working copy
    // is pushed back. No user-authored bad markdown is involved.
    await ctx.call('replaceDocumentWithMarkdown', { documentId: doc.id, filePath: mirror });

    // Step 4.
    const text = await ctx.call('readDocument', { documentId: doc.id, format: 'text' });
    ctx.assertNotIncludes(text, '**', 'A zero-edit round trip left literal ** in the document text (#118).');
    ctx.assertNotIncludes(text, '~~', 'A zero-edit round trip left literal ~~ in the document text (#118).');

    // ...and the emphasis it was carrying still has to be there.
    const formatting = JSON.parse(await ctx.call('getFormatting', {
        documentId: doc.id,
        target: { textToFind: 'Owner: Andres.' },
    }));
    ctx.assert(
        (formatting.textStyles || []).some((run) => run.style?.bold),
        'The bold run did not survive the round trip: getFormatting reports no bold over "Owner: Andres.".',
    );
}
