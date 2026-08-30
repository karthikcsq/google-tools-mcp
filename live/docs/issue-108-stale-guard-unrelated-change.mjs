// Issue #108 -- the stale-file guard blocks edits on ANY external change and
// forces a full re-read to clear.
//
// The reporter's case, exactly: the external change was the user editing the
// document TITLE ("Fall 2026 Startup Kickoff" -> "Fall 2026 Purdue
// Entrepreneurship Kickoff"). The pending edit targeted a list item several
// hundred lines away; the target text was byte-identical before and after. The
// edit was completely safe and was rejected anyway.
//
// The real fix they ask for is scoping the check to the target range. They also
// note that an exact unique textToFind match is itself strong evidence the edit
// is safe. Either behaviour satisfies this scenario: the edit goes through.
export const name = 'issue-108-stale-guard-unrelated-change';
export const issue = 108;
export const description = 'An external change that does not overlap the target range must not block a modifyText edit.';
export const expectedOnBase = 'fail';

const TARGET = 'Doors open at six.';
const STALE = /modified externally since you last read it|changed since you last read it/i;

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#108 unrelated external change'), ctx.fixture('issue-108-unrelated-change.md'));

    await ctx.call('readDocument', { documentId: doc.id, format: 'text' });

    // The external change the reporter actually made: a title edit, nowhere
    // near the pending edit's range.
    await ctx.call('renameFile', { fileId: doc.id, newName: ctx.title('#108 Fall 2026 Purdue Entrepreneurship Kickoff') });

    const attempt = await ctx.tryCall('modifyText', {
        documentId: doc.id,
        target: { textToFind: TARGET },
        text: 'Doors open at six fifteen.',
    });

    if (!attempt.ok) {
        const message = (attempt.error?.message || String(attempt.error)).replace(/\s+/g, ' ');
        if (STALE.test(message)) {
            ctx.fail(
                'A title-only external change blocked an edit to "' + TARGET + '", which it does not overlap; clearing it '
                + 'requires a full re-read (#108). Rejection: ' + message.slice(0, 260),
            );
        }
        throw attempt.error;
    }
}
