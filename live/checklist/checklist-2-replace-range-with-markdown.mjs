// Post-merge manual checklist item 2: "Rewrite one heading section with
// replaceRangeWithMarkdown; confirm surrounding content is untouched."
//
// replaceRangeWithMarkdown is not registered on every branch, so the scenario
// says so plainly rather than erroring in a way that reads as a scenario bug.
export const name = 'checklist-2-replace-range-with-markdown';
export const issue = 107;
export const description = 'Manual checklist 2: replaceRangeWithMarkdown must rewrite one heading section and leave the rest untouched.';
export const expectedOnBase = 'fail';

const KEEP_FIRST = 'This paragraph must survive untouched.';
const KEEP_LAST = 'This paragraph must also survive untouched.';
const OLD_LINE = 'Old first line.';
const NEW_LINE = 'Brand new first item.';
const NESTED_LINE = 'Brand new nested item.';

export async function run(ctx) {
    if (!ctx.hasTool('replaceRangeWithMarkdown')) {
        ctx.fail('replaceRangeWithMarkdown is not registered in this build, so there is still no section-scoped markdown replace.');
    }

    const doc = await ctx.createDoc(ctx.title('checklist-2 section replace'), ctx.fixture('checklist-2-heading-sections.md'));
    await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });

    await ctx.call('replaceRangeWithMarkdown', {
        documentId: doc.id,
        markdown: ctx.fixture('checklist-2-replacement.md'),
        range: { afterHeading: 'Rewrite This Section', untilNextHeadingOfLevel: 2 },
    });

    const after = await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });

    ctx.assertIncludes(after, KEEP_FIRST, 'The section before the rewritten one did not survive.');
    ctx.assertIncludes(after, KEEP_LAST, 'The section after the rewritten one did not survive.');
    ctx.assertNotIncludes(after, OLD_LINE, 'The old content of the rewritten section is still there.');
    ctx.assertIncludes(after, NEW_LINE, 'The new content of the rewritten section is missing.');

    const nested = after.split('\n').some((line) => /^\s{2,}(\d+\.|[-*+])\s/.test(line) && line.includes(NESTED_LINE));
    ctx.assert(nested, 'The replacement markdown did not build real nested list structure inside the section.');
}
