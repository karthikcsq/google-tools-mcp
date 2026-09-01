// Orchestrator verification of the iteration-1 finding that
// readDocument(format:'index') fails with an opaque Google 400.
export const name = 'verify-index-format';
export const goal = 'Independently reproduce the format:index failure and isolate what triggers it.';

const TABLE_DOC = `# Title

## Context

Some intro text.

| Decision | Owner |
| --- | --- |
| Ship it | Priya |
| Wait | Mateo |

## Next steps

- one
- two
`;

const PLAIN_DOC = `# Title

## Context

Some intro text with no table at all.

## Next steps

- one
- two
`;

async function probe(ctx, label, markdown) {
    const doc = await ctx.createDoc(ctx.title(label), markdown);
    const r = await ctx.tryCall('readDocument', { documentId: doc.id, format: 'index' });
    if (r.ok) ctx.note(`${label}: format=index OK (${String(r.result).length} chars)`);
    else ctx.friction('readDocument', `${label}: format=index FAILED -> ${r.error?.message}`);
    return doc;
}

export async function run(ctx) {
    // Does a table trigger it, or is format=index broken for every document?
    await probe(ctx, 'with-table', TABLE_DOC);
    await probe(ctx, 'no-table', PLAIN_DOC);

    // An empty document is the simplest possible input.
    const empty = await ctx.createDoc(ctx.title('empty'), '');
    const r = await ctx.tryCall('readDocument', { documentId: empty.id, format: 'index' });
    if (r.ok) ctx.note(`empty: format=index OK (${String(r.result).length} chars)`);
    else ctx.friction('readDocument', `empty: format=index FAILED -> ${r.error?.message}`);

    // For contrast: do the other documented formats work on the same doc?
    for (const format of ['text', 'markdown', 'json']) {
        const other = await ctx.tryCall('readDocument', { documentId: empty.id, format });
        ctx.note(`empty: format=${format} -> ${other.ok ? 'ok' : `FAILED: ${other.error?.message}`}`);
    }
}
