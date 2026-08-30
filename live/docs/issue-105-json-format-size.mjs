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
// observed and still small enough to catch the regression. A fixed build may
// instead refuse oversized raw JSON, but only if its error directs the caller
// to the usable format='index' alternative; a size-only refusal leaves the
// documented workflow unusable.
export const name = 'issue-105-json-format-size';
export const issue = 105;
export const description = "readDocument(format='json') must return bounded output or direct callers to format='index'.";
export const expectedOnBase = 'fail';

const MAX_RATIO = 20;

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#105 json size'), ctx.fixture('issue-105-large-doc.md'));

    const textResult = await ctx.call('readDocument', { documentId: doc.id, format: 'text' });
    const header = /^Content \((\d+) characters\):/.exec(String(textResult));
    ctx.assert(header, 'Could not read the document text length out of the readDocument(text) result.');
    const textLength = Number(header[1]);
    ctx.assert(textLength > 8000, 'Setup failed: the fixture document is only ' + textLength + ' characters of text.');

    const jsonCall = await ctx.tryCall('readDocument', { documentId: doc.id, format: 'json' });
    if (!jsonCall.ok) {
        const message = String(jsonCall.error?.message || jsonCall.error);
        ctx.assertMatch(
            message,
            /format\s*=\s*['"]index['"]/i,
            "readDocument(format='json') refused this document without naming format='index' as a usable index workflow, "
            + 'so the documented modifyText path remains unusable (#105).',
        );
        return;
    }

    const ratio = jsonCall.result.length / textLength;
    ctx.assert(
        ratio <= MAX_RATIO,
        "readDocument(format='json') returned " + jsonCall.result.length + ' characters for ' + textLength + ' characters of text ('
        + ratio.toFixed(1) + 'x, budget ' + MAX_RATIO + 'x), and did not provide an actionable format=\'index\' refusal (#105).',
    );
}
