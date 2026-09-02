// Orchestrator verification of the iteration-2 finding that
// replaceRangeWithMarkdown removes the target heading even with
// preserveHeading: true.
//
// The agent read the document back as markdown and saw no "## Next steps".
// That is consistent with two very different bugs:
//   (a) the write really deleted the heading paragraph  -> data loss, blocker
//   (b) the write was fine and the markdown reader drops it -> reader bug
// So this probe never trusts markdown. It reads format='index' before and
// after and asks whether a heading element with that text still exists.
export const name = 'verify-preserve-heading';
export const goal = 'Determine whether replaceRangeWithMarkdown deletes the heading it is told to preserve.';

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
3. Sara reviews day-seven activation at the September 15 check-in.
`;

/** format='index' returns JSON: { documentEnd, elements: [{type, preview, start, end}] }. */
function parseIndex(raw) {
    return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
}

function findHeading(idx, text) {
    return idx.elements.find((e) => e.type === 'heading' && String(e.preview).trim() === text);
}

// expectHeadingGone flips the verdict for the one call whose documented job is
// to remove the heading (preserveHeading: false). Without it, probe 3 reported
// correct behaviour as "Real deletion", so the mission could never reach zero
// frictions on a fixed build.
async function probe(ctx, label, buildArgs, { expectHeadingGone = false } = {}) {
    const doc = await ctx.createDoc(ctx.title(label), DOC);

    const before = parseIndex(await ctx.call('readDocument', { documentId: doc.id, format: 'index' }));
    const target = findHeading(before, 'Next steps');
    if (!target) {
        ctx.friction('readDocument', `${label}: format=index does not report "Next steps" as a heading even before any edit, so this probe cannot measure anything.`);
        return;
    }
    ctx.note(`${label}: before -> heading "Next steps" at ${target.start}-${target.end}, documentEnd ${before.documentEnd}`);

    const write = await ctx.tryCall('replaceRangeWithMarkdown', buildArgs(doc, before, target));
    if (!write.ok) {
        ctx.friction('replaceRangeWithMarkdown', `${label}: write failed -> ${write.error?.message}`);
        return;
    }

    const after = parseIndex(await ctx.call('readDocument', { documentId: doc.id, format: 'index' }));
    const stillThere = Boolean(findHeading(after, 'Next steps'));
    const risksSurvived = Boolean(findHeading(after, 'Risks'));
    const contextSurvived = Boolean(findHeading(after, 'Context'));

    // The markdown view, purely as a second opinion. If index says the heading
    // is present and markdown says it is not, the reader is the bug.
    const md = String(await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' }));
    const mdHasHeading = /^#{1,6}\s*Next steps\s*$/m.test(md);

    ctx.note(`${label}: after -> index "Next steps" ${stillThere ? 'PRESENT' : 'GONE'}`
        + `; markdown heading ${mdHasHeading ? 'PRESENT' : 'GONE'}`
        + `; Context ${contextSurvived ? 'ok' : 'GONE'}; Risks ${risksSurvived ? 'ok' : 'GONE'}`
        + `; headings now: ${after.elements.filter((e) => e.type === 'heading').map((e) => e.preview).join(' | ')}`);

    if (expectHeadingGone) {
        if (stillThere) {
            ctx.friction('replaceRangeWithMarkdown', `${label}: preserveHeading:false was ignored; the heading is still in the document (format=index).`);
        } else {
            ctx.note(`${label}: heading removed as requested, and the body was replaced.`);
        }
    } else if (!stillThere) {
        ctx.friction('replaceRangeWithMarkdown', `${label}: the heading is gone from the DOCUMENT (format=index), not just from the markdown rendering. Real deletion.`);
    } else if (!mdHasHeading) {
        ctx.friction('readDocument', `${label}: the heading survives in the document (format=index) but format='markdown' does not render it. The write is fine; the reader drops it.`);
    } else {
        ctx.note(`${label}: heading preserved in both views.`);
    }

    if (!risksSurvived) {
        ctx.friction('replaceRangeWithMarkdown', `${label}: the FOLLOWING section ("Risks") was also destroyed. The range ran past the end of the target section.`);
    }
}

export async function run(ctx) {
    // 1. Exactly what the iteration-2 agent did, and the documented default.
    await probe(ctx, 'afterHeading-preserve-true', (doc) => ({
        documentId: doc.id,
        target: { afterHeading: 'Next steps' },
        preserveHeading: true,
        markdown: NEW_BODY,
    }));

    // 2. The same call with preserveHeading omitted. The schema says it
    //    defaults to true, so this must behave identically to probe 1.
    await probe(ctx, 'afterHeading-default', (doc) => ({
        documentId: doc.id,
        target: { afterHeading: 'Next steps' },
        markdown: NEW_BODY,
    }));

    // 3. preserveHeading: false is *supposed* to eat the heading. If probes 1
    //    and 2 look like this one, the flag is being ignored. Here the heading
    //    surviving is the defect, so the verdict is inverted.
    await probe(ctx, 'afterHeading-preserve-false', (doc) => ({
        documentId: doc.id,
        target: { afterHeading: 'Next steps' },
        preserveHeading: false,
        markdown: NEW_BODY,
    }), { expectHeadingGone: true });
}
