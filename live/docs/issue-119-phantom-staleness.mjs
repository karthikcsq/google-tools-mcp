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
// DOES NOT REPRODUCE ON THIS BRANCH, and expectedOnBase says so. Five runs of
// this scenario -- 60 guarded edits, with and without a read between each --
// produced no rejection. That matches the reporter ("I could not make it fire
// deterministically, which points at a revision-id or mtime race"), and there
// is a mechanical reason a single-process run cannot force it: readTracker's
// trackMutation() clears modifiedTime after every successful write, and
// guardMutation skips the external-change comparison when modifiedTime is null.
// So the scenario stands as a regression guard on the staleness path rather
// than as a repro: if the phantom starts firing, this goes red and prints the
// rejection plus whether the identical retry succeeded.
export const expectedOnBase = 'pass';

const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];

const STALE = /changed since you last read it|modified externally since you last read it/i;

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#119 phantom staleness'), ctx.fixture('issue-119-staleness-series.md'));

    // 1.
    await ctx.call('readDocument', { documentId: doc.id, format: 'text' });

    // 2. Twelve edits. No external editor, nothing else touching the document.
    //
    // Each edit is preceded by a read, which is what the reporter's session
    // looked like and what the documented workflow tells callers to do. It also
    // matters mechanically: readTracker.trackMutation() clears modifiedTime
    // after every write and guardMutation skips the external-change comparison
    // when modifiedTime is null, so a back-to-back run of writes cannot trip
    // the guard at all. The read is what re-arms it against a modifiedTime that
    // Google may bump behind us.
    for (let i = 0; i < WORDS.length; i += 1) {
        await ctx.call('readDocument', { documentId: doc.id, format: 'text' });
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
