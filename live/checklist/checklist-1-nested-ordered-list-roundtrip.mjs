// Post-merge manual checklist item 1 (docs/plans/SESSION-STATE.md on
// dev/live-testing): "Round-trip a nested ordered list: read as markdown,
// re-import, confirm nesting survives."
//
// The fixture is three levels deep, because two-level nesting can survive by
// accident when a converter treats any indent as one level.
export const name = 'checklist-1-nested-ordered-list-roundtrip';
export const issue = '';
export const description = 'Manual checklist 1: a three-level ordered list must survive a markdown read/re-import round trip.';
export const expectedOnBase = 'fail';

const LEVEL_2 = 'First sub-item under one.';
const LEVEL_3 = 'A third-level item.';

function indentOf(markdown, needle) {
    const line = markdown.split('\n').find((l) => l.includes(needle));
    if (!line) return null;
    const match = /^(\s*)/.exec(line);
    return match ? match[1].length : 0;
}

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('checklist-1 nested ordered list'), ctx.fixture('checklist-1-nested-ordered-list.md'));

    const exported = await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });
    const mirror = ctx.rememberMirror(exported);
    ctx.assert(mirror, 'readDocument(format="markdown") did not report a local working-copy path.');

    const before = await ctx.readMirror(mirror);
    const beforeLevel2 = indentOf(before, LEVEL_2);
    const beforeLevel3 = indentOf(before, LEVEL_3);
    ctx.assert(beforeLevel2 !== null && beforeLevel3 !== null, 'Setup failed: the nested items are missing from the export.');
    ctx.assert(
        beforeLevel3 > beforeLevel2 && beforeLevel2 > 0,
        'The markdown export already flattened the nesting before any re-import: level-2 indent ' + beforeLevel2
        + ', level-3 indent ' + beforeLevel3 + '.',
    );

    // Re-import, unmodified.
    await ctx.call('replaceDocumentWithMarkdown', { documentId: doc.id, filePath: mirror });

    const after = await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });
    const afterLevel2 = indentOf(after, LEVEL_2);
    const afterLevel3 = indentOf(after, LEVEL_3);

    ctx.assert(afterLevel2 !== null && afterLevel3 !== null, 'The nested items are missing after the round trip.');
    ctx.assertEqual(afterLevel2, beforeLevel2, 'The level-2 indent changed across the round trip, so nesting did not survive.');
    ctx.assertEqual(afterLevel3, beforeLevel3, 'The level-3 indent changed across the round trip, so nesting did not survive.');
}
