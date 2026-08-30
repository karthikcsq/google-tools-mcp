// Issue #117 -- readDocument should surface link targets that disagree with
// their display text.
//
// The reporter hit this twice on the same partner-facing document:
//   Case 1: display text "tyler@rolltackventures.com", mailto pointing at
//           rolltrackventures.com (extra r, a domain that does not resolve).
//   Case 2: a teammate edited "Fortitude Fund Fred.nash@yahoo.com" and Docs
//           re-linked from after the period, so "Fred." fell outside the link.
//
// Both were caught by accident, because every readable surface said the right
// thing. The ask is detection only, in the spirit of the existing FORMATTING
// LOSS block. The narrow high-value version they name -- for any link whose
// display text parses as an email, compare it to the mailto target and warn
// when they differ -- is what this asserts on.
export const name = 'issue-117-mailto-mismatch';
export const issue = 117;
export const description = 'readDocument markdown output must flag a link whose mailto target disagrees with its email display text.';
export const expectedOnBase = 'fail';

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#117 mailto mismatch'), ctx.fixture('issue-117-mailto-mismatch.md'));

    const markdown = await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });

    // Setup check: the mismatching target has to have survived document
    // creation, otherwise a passing assertion below would mean nothing.
    ctx.assertIncludes(
        markdown,
        'mailto:tyler@rolltrackventures.com',
        'Setup failed: the mismatching mailto target is not in the document.',
    );
    ctx.assertIncludes(
        markdown,
        'tyler@rolltackventures.com',
        'Setup failed: the correct-looking display text is not in the document.',
    );

    ctx.assertMatch(
        markdown,
        /link mismatch/i,
        'readDocument reported nothing about a link whose display text (tyler@rolltackventures.com) disagrees with its '
        + 'mailto target (tyler@rolltrackventures.com); an agent reading this doc sees nothing unusual (#117).',
    );
}
