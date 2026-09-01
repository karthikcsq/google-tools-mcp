// Live regression for the four defects the iteration-2 agent loop surfaced.
//
// Each one shipped with a fully green unit suite, because each lives at a
// boundary a mock cannot reach: the exported markdown string, the Docs index
// arithmetic, and the text of a validation failure.
export const name = 'agent-loop-2-fixes';
export const goal = 'Prove the four iteration-2 fixes hold against the real API.';

const DOC = `# Launch review

## Context

We shipped the pilot to a small cohort and watched activation for a week.

## Next steps

- old item one
- old item two

## Risks

Nothing blocking yet.
`;

const NEW_BODY = `1. Mina confirms the 25-person cohort by September 5.
2. Jon sends the launch checklist to Support by September 8.
`;

const parseIndex = (raw) => JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
const headings = (idx) => idx.elements.filter((e) => e.type === 'heading').map((e) => String(e.preview).trim());

/** readDocument(markdown) appends a local-mirror footer; only the body matters. */
const bodyOf = (markdown) => String(markdown).split('\n📄 Local file:')[0].trimEnd();

// 1. The default-black sentinel must not reach the exported markdown.
//    #14 stamps #000001 on every run this server writes. Echoing it back made
//    read-back verification impossible: an agent comparing its own source
//    against the read-back saw every line wrapped and concluded the write had
//    destroyed the document.
async function checkNoSentinelSpans(ctx) {
    const doc = await ctx.createDoc(ctx.title('sentinel'), DOC);
    const md = bodyOf(await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' }));

    if (md.includes('<span') || md.includes('#000001')) {
        ctx.friction('readDocument', `format='markdown' still emits the default-black sentinel span. Got:\n${md.slice(0, 400)}`);
        return;
    }
    for (const line of ['# Launch review', '## Context', '## Next steps', '## Risks']) {
        if (!md.includes(line)) {
            ctx.friction('readDocument', `format='markdown' lost "${line}" from a document created with it. Got:\n${md.slice(0, 400)}`);
            return;
        }
    }
    ctx.note('sentinel: markdown round-trips clean, no color spans, all four headings present.');
}

// 2. preserveHeading must keep the heading in the DOCUMENT and in the markdown
//    view, and must not eat the following section.
async function checkPreserveHeading(ctx) {
    const doc = await ctx.createDoc(ctx.title('preserve'), DOC);
    await ctx.call('replaceRangeWithMarkdown', {
        documentId: doc.id,
        target: { afterHeading: 'Next steps' },
        preserveHeading: true,
        markdown: NEW_BODY,
    });

    const after = parseIndex(await ctx.call('readDocument', { documentId: doc.id, format: 'index' }));
    const md = bodyOf(await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' }));
    const found = headings(after);

    if (!found.includes('Next steps')) {
        ctx.friction('replaceRangeWithMarkdown', `preserveHeading:true deleted the heading from the document. Headings now: ${found.join(' | ')}`);
    } else if (!/^#{1,6}\s*Next steps\s*$/m.test(md)) {
        ctx.friction('readDocument', `The heading survives in format='index' but format='markdown' does not render it. Markdown:\n${md.slice(0, 400)}`);
    } else if (!found.includes('Risks')) {
        ctx.friction('replaceRangeWithMarkdown', 'The replacement ran past the target section and destroyed the following one.');
    } else if (!md.includes('Mina confirms')) {
        ctx.friction('replaceRangeWithMarkdown', 'Reported success but the new body is not in the document.');
    } else {
        ctx.note(`preserve: heading kept in both views, section replaced, "Risks" intact. Headings: ${found.join(' | ')}`);
    }
}

// 3. documentEnd is one PAST the last addressable index. The README now says
//    to use `documentEnd - 1`; this proves that is actually true, in both
//    directions.
async function checkDocumentEndArithmetic(ctx) {
    const doc = await ctx.createDoc(ctx.title('docend'), DOC);
    const idx = parseIndex(await ctx.call('readDocument', { documentId: doc.id, format: 'index' }));
    const risks = idx.elements.find((e) => e.type === 'heading' && String(e.preview).trim() === 'Risks');

    const tooFar = await ctx.tryCall('replaceRangeWithMarkdown', {
        documentId: doc.id,
        target: { startIndex: risks.end, endIndex: idx.documentEnd },
        markdown: 'Replaced tail.\n',
        dryRun: true,
    });
    if (tooFar.ok) {
        ctx.friction('replaceRangeWithMarkdown', `endIndex: documentEnd (${idx.documentEnd}) was accepted, so the README's "documentEnd - 1" rule is wrong.`);
        return;
    }
    if (!/last addressable index/i.test(String(tooFar.error?.message))) {
        ctx.friction('replaceRangeWithMarkdown', `Rejected documentEnd, but the message does not name the last addressable index: ${tooFar.error?.message}`);
    }

    const exact = await ctx.tryCall('replaceRangeWithMarkdown', {
        documentId: doc.id,
        target: { startIndex: risks.end, endIndex: idx.documentEnd - 1 },
        markdown: 'Replaced tail.\n',
    });
    if (!exact.ok) {
        ctx.friction('replaceRangeWithMarkdown', `The README's documented "documentEnd - 1" rule was rejected: ${exact.error?.message}`);
        return;
    }
    const md = bodyOf(await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' }));
    if (!md.includes('Replaced tail.')) {
        ctx.friction('replaceRangeWithMarkdown', 'documentEnd - 1 was accepted but the replacement is not in the document.');
        return;
    }
    ctx.note(`docend: documentEnd (${idx.documentEnd}) correctly rejected, documentEnd - 1 addresses to the end of the body.`);
}

// 4. Two validation failures that a real agent has to act on with no source
//    access. Both used to be unreadable.
async function checkErrorMessagesAreActionable(ctx) {
    const doc = await ctx.createDoc(ctx.title('errors'), DOC);

    // The natural mistake: indices at the top level instead of inside target.
    const flat = await ctx.tryCall('modifyText', {
        documentId: doc.id,
        startIndex: 10,
        endIndex: 20,
        text: 'new',
    });
    if (flat.ok) {
        ctx.friction('modifyText', 'A top-level startIndex/endIndex call was accepted; the target union is not being enforced.');
    } else if (!/target must be a nested object/i.test(String(flat.error?.message))) {
        ctx.friction('modifyText', `The union failure is still not actionable: ${String(flat.error?.message).slice(0, 300)}`);
    } else {
        ctx.note('modifyText: the wrong-shape failure names all three accepted target shapes.');
    }

    const sheet = await ctx.call('createSpreadsheet', { title: ctx.title('errors-sheet'), parentFolderId: ctx.folderId });
    const sheetId = JSON.parse(typeof sheet === 'string' ? sheet : JSON.stringify(sheet)).id;

    // The natural mistake: the nested Google Sheets API CellFormat shape.
    const nested = await ctx.tryCall('formatCells', {
        spreadsheetId: sheetId,
        range: 'Sheet1!A1:C1',
        format: { backgroundColor: { red: 0.12, green: 0.31, blue: 0.47 }, textFormat: { bold: true } },
    });
    if (nested.ok) {
        ctx.friction('formatCells', 'The nested CellFormat shape was accepted but sets nothing, which is worse than rejecting it.');
    } else if (!/backgroundColor.*#|hex string/is.test(String(nested.error?.message))) {
        ctx.friction('formatCells', `The rejection does not show the flat shape to use instead: ${String(nested.error?.message).slice(0, 300)}`);
    } else {
        ctx.note('formatCells: the wrong-shape failure names the flat options and the hex-string form.');
    }

    // And the shape the message points at must actually work.
    const flatFormat = await ctx.tryCall('formatCells', {
        spreadsheetId: sheetId,
        range: 'Sheet1!A1:C1',
        backgroundColor: '#D9EAD3',
        bold: true,
        horizontalAlignment: 'CENTER',
    });
    if (!flatFormat.ok) {
        ctx.friction('formatCells', `The shape the error message recommends was itself rejected: ${flatFormat.error?.message}`);
    } else {
        ctx.note('formatCells: the recommended flat shape works.');
    }
}

export async function run(ctx) {
    await checkNoSentinelSpans(ctx);
    await checkPreserveHeading(ctx);
    await checkDocumentEndArithmetic(ctx);
    await checkErrorMessagesAreActionable(ctx);
}
