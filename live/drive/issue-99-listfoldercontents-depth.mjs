// Issue #99 -- listFolderContents needs a depth/recursive option.
//
// The reporter mapped a Drive subtree with 14 sequential listFolderContents
// calls, one per folder, each waiting on the previous result to learn the next
// folderId. Every call succeeded; this is a missing capability, not a bug.
//
// Acceptance criteria from the report, the ones a live run can check:
//   * depth: 1 (or omitted) returns exactly what it returns today.
//   * depth: 2 on a folder with subfolders returns their contents in one call.
//   * Each entry carries enough parent information (path or parentId) to
//     reconstruct the tree.
//
// The tree is built inside the test folder by this scenario, so the assertion
// compares against what was created rather than against pre-existing Drive
// state.
export const name = 'issue-99-listfoldercontents-depth';
export const issue = 99;
export const description = 'listFolderContents must support a depth option that returns a nested tree in one call.';
export const expectedOnBase = 'fail';

export async function run(ctx) {
    // A 3-deep tree: root/level1/level2, with one document at each level.
    const level1 = await ctx.createFolder('#99 level1 ' + ctx.runId);
    const level2 = await ctx.createFolder('#99 level2 ' + ctx.runId, level1.id);
    const level3 = await ctx.createFolder('#99 level3 ' + ctx.runId, level2.id);

    const docs = [];
    for (const [label, parent] of [['l1', level1.id], ['l2', level2.id], ['l3', level3.id]]) {
        const raw = await ctx.call('createDocument', {
            title: '[live-smoke] #99 ' + label + ' ' + ctx.runId,
            parentFolderId: parent,
            initialContent: 'Depth probe ' + label + '.',
        });
        const parsed = JSON.parse(raw);
        ctx.track(parsed.id, 'drive');
        docs.push({ label, id: parsed.id, parent });
    }

    // depth: 1 must still behave exactly as today.
    const shallow = JSON.parse(await ctx.call('listFolderContents', { folderId: level1.id }));
    ctx.assertEqual(shallow.folders?.length, 1, 'depth-1 listing of level1 should show exactly the one subfolder it contains.');
    ctx.assertEqual(shallow.files?.length, 1, 'depth-1 listing of level1 should show exactly the one document it contains.');

    // The ask: one call for the whole subtree.
    const deep = JSON.parse(await ctx.call('listFolderContents', { folderId: level1.id, depth: 3 }));
    const flat = JSON.stringify(deep);

    const missing = docs.filter((doc) => !flat.includes(doc.id));
    ctx.assert(
        missing.length === 0,
        'listFolderContents(depth: 3) did not reach ' + missing.map((m) => m.label).join(', ')
        + '; mapping this 3-deep tree still takes one call per folder (#99).',
    );

    // Each entry has to carry enough parent information to rebuild the tree.
    ctx.assertMatch(
        flat,
        /"(path|parentId|parents)"/,
        'listFolderContents(depth: 3) returned entries with no path or parentId, so the tree cannot be reconstructed (#99).',
    );
}
