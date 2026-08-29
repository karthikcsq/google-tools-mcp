// Issue #121 -- modifyText replacement text silently inherits the character
// style of the text it replaced, italicizing whole inserted sections.
//
// The reporter's sequence:
//   1. Doc had a placeholder paragraph in italic:
//      "Not drafted yet. Same information, same details..."
//   2. modifyText replaced it with a full email draft, many paragraphs
//   3. Every paragraph rendered italic
//   4. The result read "Successfully replaced text at range 2934-3110." with
//      nothing indicating that 2,500 characters had just landed in italic.
//
// The report's first two asks are alternatives, so either satisfies this: the
// replacement is not italic, OR the result message reports the inherited style.
export const name = 'issue-121-inherited-italic';
export const issue = 121;
export const description = 'A long modifyText replacement must not silently inherit the italic style of the placeholder it replaced.';
export const expectedOnBase = 'fail';

const PLACEHOLDER = 'Not drafted yet. Same information, same details, just addressed to the partner contact.';
const FIRST_LINE = 'First paragraph of the real draft.';

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#121 inherited italic'), ctx.fixture('issue-121-italic-placeholder.md'));
    await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });

    const replacement = [
        FIRST_LINE,
        'Second paragraph of the real draft.',
        'Third paragraph of the real draft.',
        'Fourth paragraph of the real draft.',
    ].join('\n');

    const result = await ctx.call('modifyText', {
        documentId: doc.id,
        target: { textToFind: PLACEHOLDER },
        text: replacement,
    });

    const formatting = JSON.parse(await ctx.call('getFormatting', {
        documentId: doc.id,
        target: { textToFind: FIRST_LINE },
    }));
    const italicRuns = (formatting.textStyles || []).filter((run) => run.style?.italic);
    const resultMentionsInheritance = typeof result === 'string' && /inherit/i.test(result);

    ctx.assert(
        italicRuns.length === 0 || resultMentionsInheritance,
        'The replacement inherited the placeholder italic (' + italicRuns.length + ' italic run(s) over the inserted text) '
        + 'and the result said nothing about it: "' + String(result).replace(/\s+/g, ' ').slice(0, 140) + '" (#121).',
    );
}
