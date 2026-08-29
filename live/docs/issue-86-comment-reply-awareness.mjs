// Issue #86 (master) -- make the Google Docs comment workflow reliable,
// incremental and complete.
//
// ACCEPTANCE CHECK, not a repro. #86 is a master issue with verified root
// causes but no single reporter walkthrough, so this scripts the stated
// acceptance instead:
//
//   * "listComments does not request replies, so replyCount is structurally
//     zero even when getComment shows persisted replies." -> reply, then list,
//     and the count has to be right.
//   * "Add updateComment(documentId, commentId, content) so edits preserve
//     identity and timestamps." -> the tool has to exist.
//
// resolveComment is covered separately by checklist-3, which does the
// resolve-then-reopen round the manual checklist calls for.
export const name = 'issue-86-comment-reply-awareness';
export const issue = 86;
export const description = 'Acceptance: listComments must report real reply counts, and updateComment must exist.';
export const expectedOnBase = 'fail';

const ANCHOR = 'The first paragraph is the anchor a comment is attached to.';

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#86 comment reply awareness'), ctx.fixture('issue-86-comments.md'));

    // Anchor the comment on a real range rather than a guessed index.
    const structure = JSON.parse(await ctx.call('readDocument', { documentId: doc.id, format: 'json' }));
    const element = (structure.body?.content || []).find((el) => (el.paragraph?.elements || [])
        .some((run) => (run.textRun?.content || '').includes(ANCHOR)));
    ctx.assert(element, 'Setup failed: the anchor paragraph is not in the document.');

    const added = JSON.parse(await ctx.call('addComment', {
        documentId: doc.id,
        startIndex: element.startIndex,
        endIndex: element.endIndex - 1,
        content: 'Live smoke: does listComments know about replies?',
    }));
    const commentId = added.id ?? added.commentId ?? added.comment?.id;
    ctx.assert(commentId, 'Setup failed: addComment returned no comment id: ' + JSON.stringify(added).slice(0, 200));

    await ctx.call('replyToComment', { documentId: doc.id, commentId, content: 'Live smoke reply.' });

    const listed = JSON.parse(await ctx.call('listComments', { documentId: doc.id }));
    const comments = Array.isArray(listed) ? listed : (listed.comments || []);
    const mine = comments.find((c) => (c.id ?? c.commentId) === commentId);
    ctx.assert(mine, 'listComments did not return the comment that was just created.');

    const replyCount = mine.replyCount ?? (Array.isArray(mine.replies) ? mine.replies.length : 0);
    ctx.assert(
        replyCount >= 1,
        'listComments reported ' + replyCount + ' replies on a comment that has one, so a review loop cannot tell '
        + 'answered threads from unanswered ones (#86).',
    );

    ctx.assert(
        ctx.hasTool('updateComment'),
        'updateComment is not registered, so top-level comment text still cannot be edited in place (#86).',
    );
}
