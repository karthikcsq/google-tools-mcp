// Proves, against the real Drive and Docs APIs, the two comment-thread claims
// that issues #141 and #142 reported against the published 2.0.0:
//
//   #141  listComments returned replyCount: 0 on every thread, because its
//         field mask never asked for `replies`. Since #86 it does, and the count
//         is derived from the array it gets back.
//   #142  replaceDocumentWithMarkdown destroyed every comment anchor in the
//         document without saying so, and listComments kept reporting the dead
//         threads as healthy. Since #88 the replace enumerates unresolved
//         comments before it deletes anything, names them in the response, and
//         refuses outright under onCollateral='block'. The threads still exist
//         in Drive afterwards (that half is Drive API behaviour, not ours), so
//         the warning at push time is the signal an agent has to act on.
//
// It also pins the defect this mission found on its first run: every Drive
// comment write advances the Docs revisionId while Drive's modifiedTime stays
// put, so the read tracker's modifiedTime check passed and the next body write
// went out pinned to the pre-comment revision. Google refused it and the caller
// was told the document "changed since you last read it" when the only change
// was their own comment. The comment tools now re-arm the tracked revision, so
// a body write straight after addComment / replyToComment / resolveComment has
// to succeed with no re-read in between.
//
//   npm run live-mission -- live/missions/verify-comment-collateral.mjs
//
// A pass means: a reply is counted, a dry run and a real replace both name the
// anchor they remove, 'block' refuses before touching the document, and a body
// write after our own comment traffic is not refused as a revision conflict.
export const name = 'verify-comment-collateral';
export const goal =
    'Confirm listComments counts replies (#141), replaceDocumentWithMarkdown reports the comment anchors '
    + 'it is about to destroy and refuses under onCollateral=block (#142), and body writes after our own '
    + 'comment tools are not refused as revision conflicts.';

const ANCHOR = 'Anchor sentence for the comment probe.';

function parse(raw, what) {
    try { return JSON.parse(raw); } catch { throw new Error(`${what} did not return JSON: ${String(raw).slice(0, 200)}`); }
}

export async function run(ctx) {
    const doc = await ctx.createDoc('comment collateral probe', `${ANCHOR}\n\nA second paragraph that the replace also rewrites.\n`);

    // --- #141: a reply must be counted -------------------------------------
    const addedRaw = await ctx.call('addComment', {
        documentId: doc.id,
        startIndex: 1,
        endIndex: 1 + ANCHOR.length,
        content: 'Probe comment: does the replace warn about me?',
    });
    const commentId = (String(addedRaw).match(/[Cc]omment ID:\s*([A-Za-z0-9_-]+)/) || [])[1]
        || (() => { try { return JSON.parse(addedRaw).id; } catch { return null; } })();
    ctx.assert(commentId, `addComment reported no comment id: ${ctx.lastLine(addedRaw)}`);

    await ctx.call('replyToComment', { documentId: doc.id, commentId, content: 'Probe reply so replyCount has something to count.' });

    const before = parse(await ctx.call('listComments', { documentId: doc.id }), 'listComments');
    const mine = (before.comments || []).find((c) => c.id === commentId);
    ctx.assert(mine, 'listComments did not return the comment that was just created.');
    ctx.assert(
        mine.replyCount === 1 && Array.isArray(mine.replies) && mine.replies.length === 1,
        `listComments reported replyCount=${mine.replyCount} with ${mine.replies?.length ?? 'no'} replies on a thread `
        + 'that has exactly one reply (#141 regressed).',
    );
    ctx.assert(mine.resolved === false, 'A fresh comment reads as resolved; the resolved field is not trustworthy.');
    ctx.note(`#141: listComments reports replyCount=1 with the reply present on ${commentId}`);

    // --- a body write after our own comment traffic must not conflict ------
    // Each comment tool moves the Docs revision without moving modifiedTime;
    // the tracker is re-armed after every one, so no re-read is needed here.
    const conflict = (r) => (r.ok ? '' : ` (${ctx.lastLine(r.error?.message || '')})`);
    const expectWrite = (label, r) => ctx.assert(
        r.ok,
        `${label} was refused after our own comment tools ran, with no external edit${conflict(r)}. `
        + 'The tracked revisionId went stale on a comment write; that is the regression the comment tools re-arm against.',
    );

    await ctx.call('updateComment', { documentId: doc.id, commentId, content: 'Probe comment, edited in place: does the replace warn about me?' });
    expectWrite('appendText after addComment + replyToComment + updateComment',
        await ctx.tryCall('appendText', { documentId: doc.id, text: 'Appended after comment traffic, no re-read.' }));

    const secondRaw = await ctx.call('addComment', { documentId: doc.id, startIndex: 1, endIndex: 1 + ANCHOR.length, content: 'Second probe comment, resolved and deleted below.' });
    const secondId = (String(secondRaw).match(/[Cc]omment ID:\s*([A-Za-z0-9_-]+)/) || [])[1];
    ctx.assert(secondId, `second addComment reported no comment id: ${ctx.lastLine(secondRaw)}`);
    await ctx.call('resolveComment', { documentId: doc.id, commentId: secondId, note: 'Resolving the second probe.' });
    await ctx.call('deleteComment', { documentId: doc.id, commentId: secondId });
    expectWrite('appendText after resolveComment + deleteComment',
        await ctx.tryCall('appendText', { documentId: doc.id, text: 'Appended again after resolve and delete.' }));
    ctx.note('body writes after addComment, replyToComment, updateComment, resolveComment and deleteComment all went through without a re-read');

    // --- #142: the replace must name the anchor it is about to destroy -------
    const replacement = '# Rewritten\n\nEvery word of the old body is gone, and so is the anchor.\n';

    const dry = await ctx.call('replaceDocumentWithMarkdown', { documentId: doc.id, markdown: replacement, dryRun: true });
    ctx.assertIncludes(dry, 'unresolved comment anchor(s) will be removed', 'dryRun did not warn about the comment anchor (#142).');
    ctx.assertIncludes(dry, commentId, 'dryRun warned about comment anchors but did not name the affected thread.');
    ctx.note('#142: dryRun names the unresolved comment anchor the replace would remove');

    const blocked = await ctx.tryCall('replaceDocumentWithMarkdown', { documentId: doc.id, markdown: replacement, onCollateral: 'block' });
    ctx.assert(!blocked.ok, "onCollateral='block' let a replace through that destroys a comment anchor (#142).");
    ctx.assertIncludes(blocked.error?.message || '', 'refused because onCollateral', 'The replace failed for some reason other than the collateral block.');
    ctx.assertIncludes(blocked.error?.message || '', commentId, 'The block message does not name the affected thread.');

    const still = parse(await ctx.call('listComments', { documentId: doc.id }), 'listComments');
    ctx.assert((still.comments || []).some((c) => c.id === commentId), 'The blocked replace should not have touched the document, but the comment is gone.');
    ctx.note("#142: onCollateral='block' refuses and names the thread; the document is untouched");

    const real = await ctx.call('replaceDocumentWithMarkdown', { documentId: doc.id, markdown: replacement });
    ctx.assertIncludes(real, 'unresolved comment anchor(s) will be removed', 'The real replace did not warn about the comment anchor it removed (#142).');
    ctx.assertIncludes(real, commentId, 'The real replace warned but did not name the thread.');
    ctx.note('#142: the real replace reports the anchor it removed, with the thread id');

    // What Drive says afterwards is recorded, not asserted: the record outliving
    // its anchor is Drive API behaviour, and the point of the warning above is
    // that an agent does not have to discover it from here.
    const after = parse(await ctx.call('listComments', { documentId: doc.id }), 'listComments');
    const survivor = (after.comments || []).find((c) => c.id === commentId);
    ctx.note(survivor
        ? `after the replace, Drive still lists ${commentId} (quotedText ${JSON.stringify(survivor.quotedText)}); the push-time warning is the signal`
        : `after the replace, Drive no longer lists ${commentId}`);
}
