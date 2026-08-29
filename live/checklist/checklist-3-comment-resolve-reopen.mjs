// Post-merge manual checklist item 3: "Resolve a real comment and confirm it
// shows resolved in the Docs UI; then check whether a reply with
// action: 'reopen' reopens it."
//
// The UI half cannot be automated, but the API half can, and it is the half
// that matters: issue #86 records that resolveComment sends resolved: true
// through comments.update, which is not a writable resolution mechanism, and
// the tool's own result hedges -- "the resolved status may not persist in the
// Google Docs UI due to API limitations". A result that reads as success while
// the thread is not resolved is worse than a clear failure, so this reads the
// state back rather than trusting the message.
export const name = 'checklist-3-comment-resolve-reopen';
export const issue = 86;
export const description = 'Manual checklist 3: resolveComment must actually resolve, and a reply must be able to reopen.';
export const expectedOnBase = 'fail';

const ANCHOR = 'The first paragraph is the anchor a comment is attached to.';

function isResolved(comment) {
    if (!comment) return false;
    if (comment.resolved === true) return true;
    return (comment.replies || []).some((reply) => reply.action === 'resolve');
}

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('checklist-3 resolve reopen'), ctx.fixture('issue-86-comments.md'));

    const structure = JSON.parse(await ctx.call('readDocument', { documentId: doc.id, format: 'json' }));
    const element = (structure.body?.content || []).find((el) => (el.paragraph?.elements || [])
        .some((run) => (run.textRun?.content || '').includes(ANCHOR)));
    ctx.assert(element, 'Setup failed: the anchor paragraph is not in the document.');

    // addComment and resolveComment both return text, not JSON.
    const added = await ctx.call('addComment', {
        documentId: doc.id,
        startIndex: element.startIndex,
        endIndex: element.endIndex - 1,
        content: 'Live smoke: resolve then reopen.',
    });
    const commentId = (/Comment ID:\s*(\S+)/.exec(String(added)) || [])[1];
    ctx.assert(commentId, 'Setup failed: addComment reported no comment id: ' + String(added).replace(/\s+/g, ' ').slice(0, 200));

    const resolveResult = await ctx.call('resolveComment', { documentId: doc.id, commentId });
    const afterResolve = JSON.parse(await ctx.call('getComment', { documentId: doc.id, commentId }));

    ctx.assert(
        isResolved(afterResolve),
        'resolveComment returned "' + String(resolveResult).replace(/\s+/g, ' ').slice(0, 120)
        + '" but the comment reads back unresolved, so a caller cannot tell whether the thread is actually resolved.',
    );

    // The reopen half of the checklist item.
    const reopen = await ctx.tryCall('replyToComment', {
        documentId: doc.id,
        commentId,
        content: 'Live smoke: reopening.',
        action: 'reopen',
    });
    ctx.assert(reopen.ok, 'The reopen reply failed: ' + (reopen.error?.message || '').replace(/\s+/g, ' ').slice(0, 200));

    const afterReopen = JSON.parse(await ctx.call('getComment', { documentId: doc.id, commentId }));
    ctx.assert(
        !isResolved(afterReopen),
        'A reply with action "reopen" did not reopen the thread, and there is no reopenComment tool to do it instead.',
    );
}
