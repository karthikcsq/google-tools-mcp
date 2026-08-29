// Issue #73 (master) -- Gmail raw-message construction is not RFC-compliant for
// non-ASCII header values.
//
// ACCEPTANCE CHECK, not a repro. The report is a standards-compliance issue
// with a checklist rather than a walkthrough, and it says plainly that it is
// "not claimed as a reproduced Gmail API outage". The two items a live draft
// can check are:
//
//   * "Add an RFC 2047 encoder for non-ASCII/unsafe Subject values" -- a
//     non-ASCII subject has to come back decoding to what was sent.
//   * "Apply the same safe construction/folding path to Content-Type and
//     Content-Disposition, including long or Unicode attachment filenames" --
//     a long non-ASCII filename has to come back intact.
//
// This is also manual-checklist item 4, minus the send: the checklist asks to
// send such a message and confirm it renders in two mail clients, which a smoke
// run must not do. The draft is tracked for deletion at the end of the run.
export const name = 'issue-73-nonascii-headers';
export const issue = 73;
export const description = 'Acceptance: a non-ASCII subject and a long non-ASCII attachment filename must survive a draft round trip.';
export const expectedOnBase = 'fail';

function headerValue(draft, wanted) {
    const headers = draft.message?.payload?.headers || [];
    const found = headers.find((h) => (h.name || '').toLowerCase() === wanted.toLowerCase());
    return found ? found.value : null;
}

function attachmentFilenames(draft) {
    const names = [];
    const walk = (part) => {
        if (!part) return;
        if (part.filename) names.push(part.filename);
        for (const child of part.parts || []) walk(child);
    };
    walk(draft.message?.payload);
    return names.filter(Boolean);
}

export async function run(ctx) {
    if (!ctx.self) ctx.skip('No authenticated Gmail address available, so there is no safe recipient for a draft.');

    const subject = ctx.fixture('issue-73-subject.txt').trim();
    const filename = ctx.fixture('issue-73-filename.txt').trim();
    const payload = ctx.fixture('issue-73-attachment.txt');

    const created = JSON.parse(await ctx.call('createDraft', {
        to: [ctx.self],
        subject,
        body: 'Live smoke: non-ASCII subject and attachment filename check.',
        attachments: [{
            filename,
            mimeType: 'text/plain',
            base64Data: Buffer.from(payload, 'utf8').toString('base64'),
        }],
    }));
    ctx.assert(created.id, 'createDraft returned no draft id.');
    ctx.track(created.id, 'draft');

    const draft = JSON.parse(await ctx.call('getDraft', { id: created.id }));

    const storedSubject = headerValue(draft, 'Subject');
    ctx.assert(storedSubject !== null, 'The stored draft has no Subject header.');
    ctx.assertEqual(
        storedSubject,
        subject,
        'The non-ASCII subject did not survive the draft round trip; it was written as raw UTF-8 rather than RFC 2047 '
        + 'encoded-words (#73).',
    );

    const names = attachmentFilenames(draft);
    ctx.assert(names.length > 0, 'The stored draft carries no attachment part.');
    ctx.assert(
        names.includes(filename),
        'The long non-ASCII attachment filename came back as ' + JSON.stringify(names) + ' instead of '
        + JSON.stringify(filename) + '; Content-Type / Content-Disposition are still built as raw lines (#73).',
    );
}
