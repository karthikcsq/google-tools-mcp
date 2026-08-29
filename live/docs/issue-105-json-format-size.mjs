// Issue #105 -- readDocument format='json' returns 1.36M chars for a 9.6K-char
// doc, making the documented modifyText index workflow unusable.
//
// The reporter's document: 9,601 characters of plain text, about four pages.
// format='json' returned 1,356,973 characters across 52,156 lines -- roughly
// 140x the text -- and the call failed outright on the token limit.
//
// modifyText's own description says "Use readDocument with format='json' to
// determine indices", so this is the documented path being unreachable. The
// brief's bar for this scenario is 20x, which is generous next to the 140x
// observed and still small enough to catch the regression.
export const name = 'issue-105-json-format-size';
export const issue = 105;
export const description = "readDocument(format='json') must not return more than 20x the document's text length.";
export const expectedOnBase = 'fail';

const MAX_RATIO = 20;

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#105 json size'), ctx.fixture('issue-105-large-doc.md'));

    const textResult = await ctx.call('readDocument', { documentId: doc.id, format: 'text' });
    const header = /^Content \((\d+) characters\):/.exec(String(textResult));
    ctx.assert(header, 'Could not read the document text length out of the readDocument(text) result.');
    const textLength = Number(header[1]);
    ctx.assert(textLength > 8000, 'Setup failed: the fixture document is only ' + textLength + ' characters of text.');

    const json = await ctx.call('readDocument', { documentId: doc.id, format: 'json' });
    const ratio = json.length / textLength;

    ctx.assert(
        ratio <= MAX_RATIO,
        "readDocument(format='json') returned " + json.length + ' characters for ' + textLength + ' characters of text ('
        + ratio.toFixed(1) + 'x, budget ' + MAX_RATIO + 'x), so the index workflow modifyText documents is unreachable (#105).',
    );
}
