// Issue #107 -- no safe way to rewrite one section of a Doc.
//
// The reporter's case: a doc with a "To Do List" section plus a Schedule and a
// Guest List. The user wanted the To Do List reorganized and nothing else
// touched. replaceDocumentWithMarkdown was ruled out by the tool's own
// FORMATTING LOSS warning, which routes callers to modifyText -- and modifyText
// then flattened all list nesting, so the result was materially worse-looking
// than the original and the user had to repair it by hand.
//
// This runs that exact path: the workaround the warning recommends, on a
// section that has nesting, and asserts both halves of what they needed --
// the nesting survives, and nothing outside the section moves. If a
// section-scoped markdown replace exists in this build (replaceRangeWithMarkdown
// / insertMarkdown), it is used instead, because that is the requested fix.
// replaceRangeWithMarkdown's target parameter is described as "The range to
// replace", which likely led to the old range key here. That prose/parameter
// mismatch should be raised separately; this scenario must use the schema key.
export const name = 'issue-107-section-scoped-rewrite';
export const issue = 107;
export const description = 'Rewriting one section must preserve list nesting inside it and leave every other section untouched.';
export const expectedOnBase = 'fail';

const OLD_SECTION = '1. Book the room.\n2. Confirm catering.\n3. Send the partner packet.';
const NEW_SECTION_MARKDOWN = '1. Rebook the room.\n    1. Confirm the projector.\n    2. Confirm the mics.\n2. Reconfirm catering.';
const KEEP_A = 'Doors at six.';
const KEEP_B = 'Andres';

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#107 section rewrite'), ctx.fixture('issue-107-section-rewrite.md'));
    await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });

    if (ctx.hasTool('replaceRangeWithMarkdown')) {
        // The requested fix: a section-scoped markdown replace.
        await ctx.call('replaceRangeWithMarkdown', {
            documentId: doc.id,
            markdown: NEW_SECTION_MARKDOWN,
            target: { afterHeading: 'To Do List', untilNextHeadingOfLevel: 2 },
        });
    } else {
        // The workaround the FORMATTING LOSS warning routes callers to.
        await ctx.call('modifyText', {
            documentId: doc.id,
            target: { textToFind: OLD_SECTION },
            text: NEW_SECTION_MARKDOWN,
        });
    }

    const after = await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });

    // Everything outside the section has to be untouched.
    ctx.assertIncludes(after, KEEP_A, 'The Schedule section did not survive the section rewrite (#107).');
    ctx.assertIncludes(after, KEEP_B, 'The Guest List section did not survive the section rewrite (#107).');

    // ...and the new nesting has to be real nesting, not flattened text.
    const nested = after.split('\n').some((line) => /^\s{2,}(\d+\.|[-*+])\s/.test(line) && line.includes('Confirm the projector.'));
    ctx.assert(
        nested,
        'The rewritten section came back flattened: "Confirm the projector." is not a nested list item, so the only '
        + 'section-rewrite path available leaves the doc materially worse-looking than the original (#107).',
    );
}
