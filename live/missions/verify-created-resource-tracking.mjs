// Proves the cleanup registry catches the creating tool it used to drop on the
// floor, against the real Google API, and pins the guard rule that makes the
// other one unreachable.
//
// The bug: scripts/live-mission.mjs and scripts/live-smoke/call.mjs both read
// `JSON.parse(result).id` and nothing else. Two of the eight tools they listed
// as tracked never matched that:
//
//   createDocumentFromTemplate  answers in prose, so JSON.parse throws
//   createPresentation          answers with `presentationId`, not `id`
//
// Anything unregistered is never trashed, and the run still printed
// "cleanup N/N" because N counted only what the runner had noticed.
//
// Only the FIRST of those can actually leak here, and finding that out is the
// reason this runs live instead of against a mock. createDocumentFromTemplate
// goes through drive.files.copy, which the guard allows into the sandbox, so a
// dropped id is a real file left in a real Drive. createPresentation is denied
// outright by scripts/live-smoke/guard.mjs -- the Slides API creates in Drive
// root regardless of any parent given, so the guard refuses it before it can
// create anything. Its extraction is still fixed (live-call reaches other
// paths, and the guard is not the only thing that should be correct), but the
// containment claim for it is the guard, not the registry. This mission asserts
// both halves so neither can quietly regress.
//
//   npm run live-mission -- live/missions/verify-created-resource-tracking.mjs
//
// A pass means: the templated document was auto-registered without the mission
// tracking it by hand, the Slides deny still holds, and the runner trashes
// everything at the end.
export const name = 'verify-created-resource-tracking';
// Tripping the Slides deny on purpose is the only way to prove it still holds.
// Declared exactly, so one refusal beyond this still fails the run.
export const expectsSafetyRefusals = 1;
export const goal =
    'Confirm the runner auto-registers a document created from a template (whose result is prose, not JSON) '
    + 'without the mission tracking it by hand, and that the Slides creation deny still holds.';

/** The ids the runner has registered for cleanup so far. */
const registered = (ctx) => new Set(ctx.registryIds());

export async function run(ctx) {
    // --- The reachable leak: a result that is prose, not JSON --------------
    // createDoc() tracks by hand, but only for the template. The document under
    // test is created below and deliberately NOT tracked by this mission.
    const template = await ctx.createDoc('tracking probe template', '# {{TITLE}}\n\nBody for {{WHO}}.');

    const fromTemplateRaw = await ctx.call('createDocumentFromTemplate', {
        templateId: template.id,
        newTitle: ctx.title('[live-smoke] tracking probe from template'),
        parentFolderId: ctx.folderId,
        replacements: { '{{TITLE}}': 'Tracked', '{{WHO}}': 'the cleanup registry' },
    });

    ctx.assert(
        typeof fromTemplateRaw === 'string',
        'createDocumentFromTemplate returned a non-string; the prose path is what this probe covers.',
    );
    let parsedAnyway = null;
    try { parsedAnyway = JSON.parse(fromTemplateRaw); } catch { /* expected: it is prose */ }
    ctx.assert(
        parsedAnyway === null,
        'createDocumentFromTemplate now returns JSON. Good, but this probe covers the prose path specifically '
        + 'and would now be passing for the wrong reason. Re-point it before relaxing anything.',
    );

    const idMatch = fromTemplateRaw.match(/\(ID:\s*([A-Za-z0-9_-]{10,})\s*\)/);
    ctx.assert(idMatch, `No id found in createDocumentFromTemplate's result: ${ctx.lastLine(fromTemplateRaw)}`);
    const templatedId = idMatch[1];

    ctx.assert(
        registered(ctx).has(templatedId),
        `createDocumentFromTemplate succeeded but ${templatedId} was NOT registered for cleanup. `
        + 'That document is in the sandbox folder right now and nothing will trash it.',
    );
    ctx.note(`createDocumentFromTemplate auto-tracked from prose: ${templatedId}`);

    // --- The unreachable one: the guard is the containment, so pin it -------
    const deck = await ctx.tryCall('createPresentation', {
        name: ctx.title('[live-smoke] this must never be created'),
        slides: [{ title: 'Probe', content: 'If this exists, the guard stopped denying Slides creation.' }],
        parentFolderId: ctx.folderId,
    });
    ctx.assert(
        !deck.ok,
        'createPresentation SUCCEEDED. The Slides API creates in Drive root regardless of parentFolderId, so this '
        + "just wrote a file outside the sandbox, in Elliot's Drive. Restore the deny in guard.mjs.",
    );
    ctx.assertIncludes(
        deck.error?.message || '',
        'lands in Drive root',
        'createPresentation failed for some reason other than the guard denying it, so the deny is unproven.',
    );
    ctx.note('Slides creation is still denied by the guard, which is what keeps it out of the sandbox.');

    const ids = registered(ctx);
    ctx.assert(ids.has(template.id), `template ${template.id} missing from the cleanup registry.`);
    ctx.note(`registry holds ${ids.size} resource(s); the runner must trash every one of them.`);
}
