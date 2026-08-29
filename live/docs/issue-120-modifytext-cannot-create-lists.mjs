// Issue #120 -- modifyText cannot create bullets or numbered lists, so a
// mid-document insert cannot match the formatting of the section above it.
//
// The reporter's case: a doc with two parallel sections meant to look
// identical. Version A came from createDocument(initialContent=<markdown>) and
// has real bullets and a real numbered list. Version B had to be inserted
// mid-document via modifyText, so its bullet items are bare paragraphs and its
// numbered items are literal "1." text.
//
// The ask is a bulletPreset on modifyText's paragraphStyle. This scenario asks
// for it exactly as the report spells it, then checks the document structure
// for a real bullet on the inserted paragraph.
export const name = 'issue-120-modifytext-cannot-create-lists';
export const issue = 120;
export const description = 'modifyText must be able to give a mid-document insert real bullets (paragraphStyle.bulletPreset).';
export const expectedOnBase = 'fail';

const PLACEHOLDER = 'INSERT VERSION B HERE';
const FIRST_ITEM = 'First bullet of version B.';

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#120 mid-document list insert'), ctx.fixture('issue-120-list-insert.md'));
    await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });

    await ctx.call('modifyText', {
        documentId: doc.id,
        target: { textToFind: PLACEHOLDER },
        text: FIRST_ITEM + '\nSecond bullet of version B.',
        paragraphStyle: { bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' },
    });

    // Read the structure back and look for a real bullet on the inserted range.
    const structure = JSON.parse(await ctx.call('readDocument', { documentId: doc.id, format: 'json' }));
    const content = structure.body?.content || [];
    const paragraph = content.find((element) => (element.paragraph?.elements || [])
        .some((run) => (run.textRun?.content || '').includes(FIRST_ITEM)));

    ctx.assert(paragraph, 'Setup failed: the inserted paragraph is not in the document.');
    ctx.assert(
        Boolean(paragraph.paragraph?.bullet),
        'The paragraph modifyText inserted has no bullet, so a mid-document insert still cannot match the list formatting of the section above it (#120).',
    );
}
