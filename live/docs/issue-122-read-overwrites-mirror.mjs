// Issue #122 -- readDocument overwrites the local mirror file, silently
// destroying pending edits.
//
// Reporter's steps, in their order:
//   1. readDocument(docId, format='markdown') -- mirror file is written.
//   2. Edit the mirror file locally, do not push.
//   3. readDocument(docId, format='markdown', diffFromLastRead=true).
//   4. The mirror file is back to the live content. The local edits are gone.
//
// This is the trap the report names: the tool tells you to edit the mirror, and
// the safe pre-push check destroys what you edited. The report offers several
// acceptable fixes, so the assertion accepts either of the two that are
// observable from outside the process -- the local edit survives, or a .bak
// exists AND the result says so.
export const name = 'issue-122-read-overwrites-mirror';
export const issue = 122;
export const description = 'The pre-push staleness check must not silently destroy unpushed edits in the local mirror.';
export const expectedOnBase = 'fail';

const LOCAL_ONLY = '## Locally added section';

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#122 mirror overwrite'), ctx.fixture('issue-122-mirror-edit.md'));

    // 1.
    const first = await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });
    const mirror = ctx.rememberMirror(first);
    ctx.assert(mirror, 'readDocument(format="markdown") did not report a local working-copy path.');

    // 2. A fully written new section, not pushed.
    const original = await ctx.readMirror(mirror);
    await ctx.writeMirror(
        mirror,
        original + '\n\n' + LOCAL_ONLY + '\n\nThis paragraph exists only in the mirror and has never been pushed.\n',
    );
    ctx.assertIncludes(await ctx.readMirror(mirror), LOCAL_ONLY, 'Setup failed: the local edit was not written to the mirror.');

    // 3. The safe pre-push check the documented workflow requires.
    const diff = await ctx.call('readDocument', { documentId: doc.id, format: 'markdown', diffFromLastRead: true });

    // 4.
    const after = await ctx.readMirror(mirror);
    const backupExists = await ctx.mirrorExists(mirror + '.bak');
    const backupMentioned = typeof diff === 'string' && diff.includes('.bak');

    ctx.assert(
        after.includes(LOCAL_ONLY) || (backupExists && backupMentioned),
        'diffFromLastRead rewrote the mirror and destroyed the unpushed local edit, with no backup and no mention of one in the result (#122).',
    );
}
