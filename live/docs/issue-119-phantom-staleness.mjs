// Issue #119 -- modifyText raises a phantom staleness error when the document
// has not actually changed, and an immediate identical retry succeeds.
//
// Reporter's reproduction shape, in their order:
//   1. readDocument(documentId, format='text' or 'markdown')
//   2. A short series of successful modifyText calls against that doc
//   3. Somewhere in the series, one call is rejected as stale with an empty diff
//   4. Re-issue the exact same call with no intervening operation -> succeeds
//
// They saw 4 occurrences in roughly 25 calls, so this runs twelve and asserts
// none is rejected. When one is, the failure reports the rejection text and
// whether the byte-identical retry then succeeded -- the signature that
// separates a phantom from a genuine concurrent edit.
export const name = 'issue-119-phantom-staleness';
export const issue = 119;
export const description = 'A series of modifyText calls with no external edits must not be rejected as stale.';
export const expectedOnBase = 'fail';

const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];

const STALE = /changed since you last read it|modified externally since you last read it/i;

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#119 phantom staleness'), ctx.fixture('issue-119-staleness-series.md'));

    // 1.
    await ctx.call('readDocument', { documentId: doc.id, format: 'text' });

    // 2. Twelve edits. No external editor, nothing else touching the document.
    for (let i = 0; i < WORDS.length; i += 1) {
        const find = 'Line ' + WORDS[i] + ' is the ' + ORDINALS[i] + ' target phrase.';
        const args = {
            documentId: doc.id,
            target: { textToFind: find },
            text: 'Line ' + WORDS[i] + ' is the ' + ORDINALS[i] + ' target phrase (edited).',
        };
        const attempt = await ctx.tryCall('modifyText', args);
        if (attempt.ok) continue;

        const message = attempt.error?.message || String(attempt.error);
        if (!STALE.test(message)) throw attempt.error;

        // 4. The distinguishing signal: an immediate byte-identical retry.
        const retry = await ctx.tryCall('modifyText', args);
        ctx.fail(
            'modifyText call ' + (i + 1) + ' of ' + WORDS.length + ' was rejected as stale with no external edit; '
            + 'the byte-identical immediate retry ' + (retry.ok ? 'succeeded' : 'also failed') + ' (#119). Rejection: '
            + message.replace(/\s+/g, ' ').slice(0, 300),
        );
    }
}
