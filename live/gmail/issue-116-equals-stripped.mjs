// Issue #116 -- every literal "=" disappears from a draft body.
//
// Reporter's repro, in their order:
//   1. createDraft / updateDraft with an HTML body containing normal attributes
//      and URLs with query params.
//   2. Read the draft back with getDraft.
//   3. Every "=" is gone and "=NN" sequences have been decoded as hex bytes:
//        <a href="https://..."> becomes <a href"https://...">
//        ?tab=t.0#heading=h.abc becomes ?tabt.0#headingh.abc
//        ?actorCompanyId=106734664 becomes ?actorCompanyId 6734664
//
// The report guessed a double quoted-printable decode. It is not: 2.0.0
// declares "Content-Transfer-Encoding: quoted-printable" and then writes the
// body raw, so Gmail decodes escape sequences that were never encoded. Same
// visible damage, different mechanism -- so the assertions below are on the
// observable outcome the reporter saw (characters missing from the stored
// draft), not on the mechanism they inferred.
//
// Drafts only. The runner blocks all four send paths, and the draft is tracked
// for deletion at the end of the run.
export const name = 'issue-116-equals-stripped';
export const issue = 116;
export const description = 'A draft body must come back from getDraft with every "=" and both URLs intact.';
export const expectedOnBase = 'fail';

const URL_ONE = 'https://example.com/page?tab=t.0#heading=h.abc';
const URL_TWO = 'https://www.linkedin.com/feed/update/urn:li:share:7495913127058976769/?actorCompanyId=106734664';

function bodyOf(draft) {
    const parts = [];
    const walk = (part) => {
        if (!part) return;
        const data = part.body?.data;
        if (typeof data === 'string' && data.length) {
            // getDraft(includeBodyHtml) decodes text parts in place; anything
            // left encoded is still base64url.
            parts.push(/^[A-Za-z0-9_-]+$/.test(data) ? Buffer.from(data, 'base64').toString('utf8') : data);
        }
        for (const child of part.parts || []) walk(child);
    };
    walk(draft.message?.payload);
    return parts.join('\n');
}

function check(ctx, label, body, fixture) {
    const expected = (fixture.match(/=/g) || []).length;
    const actual = (body.match(/=/g) || []).length;
    ctx.assert(
        actual >= expected,
        label + ': the stored draft body has ' + actual + ' "=" characters where the body sent had ' + expected
        + '; every "=" in the body was consumed (#116).',
    );
    ctx.assertIncludes(body, URL_ONE, label + ': the first URL did not survive the round trip intact (#116).');
    ctx.assertIncludes(body, URL_TWO, label + ': the second URL did not survive the round trip intact (#116).');
    ctx.assertIncludes(body, 'class="gmail_quote"', label + ': an HTML attribute lost its "=" (#116).');
}

export async function run(ctx) {
    if (!ctx.self) ctx.skip('No authenticated Gmail address available, so there is no safe recipient for a draft.');

    const fixture = ctx.fixture('issue-116-body.html');

    const created = JSON.parse(await ctx.call('createDraft', {
        to: [ctx.self],
        subject: '[live-smoke] #116 equals stripped ' + ctx.runId,
        body: fixture,
    }));
    ctx.assert(created.id, 'createDraft returned no draft id.');
    ctx.track(created.id, 'draft');

    check(ctx, 'createDraft', bodyOf(JSON.parse(await ctx.call('getDraft', { id: created.id, includeBodyHtml: true }))), fixture);

    // The reporter hit this through updateDraft on an existing draft, so run
    // that path too with the identical body.
    await ctx.call('updateDraft', {
        id: created.id,
        to: [ctx.self],
        subject: '[live-smoke] #116 equals stripped ' + ctx.runId,
        body: fixture,
    });

    check(ctx, 'updateDraft', bodyOf(JSON.parse(await ctx.call('getDraft', { id: created.id, includeBodyHtml: true }))), fixture);
}
