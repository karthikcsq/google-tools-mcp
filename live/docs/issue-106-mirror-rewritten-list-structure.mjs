// Issue #106 -- readDocument's local working copy is silently rewritten between
// calls, and the rewrite breaks the markdown.
//
// The reporter wrote a clean, tight nested list to the working-copy path. On
// the next read the file had gained a blank line CONTAINING THREE TRAILING
// SPACES between every parent item and each of its sub-items, which converts a
// tight list into a loose one; downstream the sub-bullets stop parsing as
// nested items and render as continuation paragraphs of the parent. They also
// report the export flattening nesting depth, so verification was impossible.
//
// This scenario replicates that: write the reporter's exact list to the mirror,
// push it, read back, and assert (a) no whitespace-only lines and (b) the
// nesting is still there.
export const name = 'issue-106-mirror-rewritten-list-structure';
export const issue = 106;
export const description = 'The working copy must not gain whitespace-only lines, and markdown export must preserve nesting depth.';
export const expectedOnBase = 'fail';

const SUB_ITEM = 'Follow up on the table count and space capacity.';

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#106 tight nested list'), ctx.fixture('issue-106-tight-nested-list.md'));

    const first = await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });
    const mirror = ctx.rememberMirror(first);
    ctx.assert(mirror, 'readDocument(format="markdown") did not report a local working-copy path.');

    // The reporter's own clean, tight markdown, written to the working copy the
    // tool told them to hand-edit.
    await ctx.writeMirror(mirror, ctx.fixture('issue-106-tight-nested-list.md'));
    await ctx.call('replaceDocumentWithMarkdown', { documentId: doc.id, filePath: mirror });

    // The next read is where they found the file reformatted.
    await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });
    const after = await ctx.readMirror(mirror);

    const whitespaceOnly = after.split('\n').filter((line) => line.length > 0 && line.trim().length === 0);
    ctx.assert(
        whitespaceOnly.length === 0,
        'The working copy came back with ' + whitespaceOnly.length + ' whitespace-only line(s) '
        + '(e.g. ' + JSON.stringify(whitespaceOnly[0]) + '), which turns the tight list into a loose one (#106).',
    );

    const nested = after.split('\n').some((line) => /^\s{2,}[-*+]\s/.test(line) && line.includes(SUB_ITEM));
    ctx.assert(
        nested,
        'The sub-item "' + SUB_ITEM + '" came back without its nesting indent, so the markdown export cannot be used to '
        + 'verify list structure (#106).',
    );
}
