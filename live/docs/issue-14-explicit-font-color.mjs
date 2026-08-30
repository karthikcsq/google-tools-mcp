// Issue #14 -- text inserted by the editing tools has no explicit font color,
// so Google Docs shows no color selected in the picker.
//
// ACCEPTANCE CHECK, not a repro. The report is a UI observation (select the
// text, open the font colour picker, no swatch is highlighted) that no tool
// call can see. What IS checkable, and is exactly the report's suggested fix --
// "When inserting text, explicitly set the foreground color to the document's
// default text color so that Google Docs recognizes it as having a defined
// color value" -- is that the document structure carries a foregroundColor on
// the runs the tool wrote.
export const name = 'issue-14-explicit-font-color';
export const issue = 14;
export const description = 'Acceptance: text written by replaceDocumentWithMarkdown must carry an explicit foreground color.';
export const expectedOnBase = 'fail';

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#14 explicit font color'), 'Placeholder body replaced below.');
    await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });

    await ctx.call('replaceDocumentWithMarkdown', {
        documentId: doc.id,
        markdown: ctx.fixture('issue-14-font-color.md'),
    });

    const structure = JSON.parse(await ctx.call('readDocument', { documentId: doc.id, format: 'json' }));
    const runs = [];
    for (const element of structure.body?.content || []) {
        for (const run of element.paragraph?.elements || []) {
            const content = run.textRun?.content;
            if (!content || !content.trim()) continue;
            runs.push({ text: content.trim().slice(0, 40), hasColor: Boolean(run.textRun.textStyle?.foregroundColor) });
        }
    }

    ctx.assert(runs.length > 0, 'Setup failed: the document has no text runs after the push.');
    const uncolored = runs.filter((run) => !run.hasColor);
    ctx.assert(
        uncolored.length === 0,
        uncolored.length + ' of ' + runs.length + ' text run(s) written by replaceDocumentWithMarkdown carry no explicit '
        + 'foregroundColor (e.g. "' + uncolored[0]?.text + '"), so Google Docs treats them as "no color set" (#14).',
    );
}
