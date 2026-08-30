// Post-merge manual checklist item 5: "Forward a message carrying a real
// attachment; confirm it opens intact."
//
// NEVER SENT. forwardMessage calls gmail.users.messages.send unconditionally,
// so the runner blocks it outright -- this scenario asserts that block holds,
// then builds the same forward as a DRAFT and asserts on the assembled message.
// The draft goes to the authenticated account's own address and is deleted at
// the end of the run.
//
// The source message is found read-only in the mailbox (nothing in a smoke run
// can create an inbound message with an attachment without sending one). If the
// mailbox has no small attachment to work with, the scenario skips rather than
// inventing a weaker check.
export const name = 'checklist-5-forward-with-attachment-draft';
export const issue = '';
export const description = 'Manual checklist 5: a forward carrying a real attachment must assemble correctly, as a draft, never sent.';
export const expectedOnBase = 'pass';

const MAX_ATTACHMENT_BYTES = 512 * 1024;

function findAttachment(payload) {
    const stack = [payload];
    while (stack.length) {
        const part = stack.pop();
        if (!part) continue;
        if (part.filename && part.body?.attachmentId && (part.body.size ?? 0) > 0 && (part.body.size ?? 0) <= MAX_ATTACHMENT_BYTES) {
            return { filename: part.filename, mimeType: part.mimeType || 'application/octet-stream', attachmentId: part.body.attachmentId };
        }
        for (const child of part.parts || []) stack.push(child);
    }
    return null;
}

function headerValue(message, wanted) {
    const headers = message.payload?.headers || [];
    const found = headers.find((h) => (h.name || '').toLowerCase() === wanted.toLowerCase());
    return found ? found.value : '';
}

export async function run(ctx) {
    if (!ctx.self) ctx.skip('No authenticated Gmail address available, so there is no safe recipient for a draft.');

    // 1. The send path stays shut, and the runner is what shuts it.
    const blocked = await ctx.tryCall('forwardMessage', { messageId: 'live-smoke-never-runs', to: [ctx.self] });
    ctx.assert(!blocked.ok, 'forwardMessage was NOT blocked by the runner. It sends unconditionally; this must never run.');
    ctx.assertIncludes(
        blocked.error?.message || '',
        'never sends mail',
        'forwardMessage failed for some reason other than the runner blocking it.',
    );

    // 2. Find a real message carrying a small attachment. Read-only.
    const listed = JSON.parse(await ctx.call('listMessages', { q: 'has:attachment smaller:500000', maxResults: 10 }));
    const candidates = listed.messages || listed || [];
    let source = null;
    let attachment = null;
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const id = candidate.id ?? candidate;
        if (!id) continue;
        const message = JSON.parse(await ctx.call('getMessage', { id, format: 'full', maxBodyChars: 500 }));
        const found = findAttachment(message.payload);
        if (found) { source = message; attachment = found; break; }
    }
    if (!source) ctx.skip('No message with a small (<512KB) attachment was found in the mailbox, so there is nothing to forward.');

    const data = JSON.parse(await ctx.call('getAttachment', { messageId: source.id, id: attachment.attachmentId }));
    const base64url = data.data ?? data.body?.data;
    ctx.assert(base64url, 'getAttachment returned no data for the source attachment.');
    const base64 = String(base64url).replace(/-/g, '+').replace(/_/g, '/');

    // 3. Assemble the forward the way forwardMessage would, as a draft.
    const originalSubject = headerValue(source, 'subject');
    const subject = originalSubject.toLowerCase().startsWith('fwd:') ? originalSubject : 'Fwd: ' + originalSubject;
    const forwardedContent = [
        '---------- Forwarded message ---------',
        'From: ' + headerValue(source, 'from'),
        'Date: ' + headerValue(source, 'date'),
        'Subject: ' + originalSubject,
        'To: ' + headerValue(source, 'to'),
        '',
        'Live smoke forward assembly check ' + ctx.runId + '.',
    ].join('\n');

    const created = JSON.parse(await ctx.call('createDraft', {
        to: [ctx.self],
        subject,
        body: forwardedContent,
        attachments: [{ filename: attachment.filename, mimeType: attachment.mimeType, base64Data: base64 }],
    }));
    ctx.assert(created.id, 'createDraft returned no draft id.');
    ctx.track(created.id, 'draft');

    // 4. Assert on the assembled message.
    const draft = JSON.parse(await ctx.call('getDraft', { id: created.id }));
    const storedSubject = headerValue(draft.message, 'subject');
    ctx.assertMatch(storedSubject, /^Fwd: /i, 'The assembled forward does not carry a "Fwd: " subject (got "' + storedSubject + '").');

    const names = [];
    const sizes = [];
    const walk = (part) => {
        if (!part) return;
        if (part.filename) { names.push(part.filename); sizes.push(part.body?.size ?? 0); }
        for (const child of part.parts || []) walk(child);
    };
    walk(draft.message?.payload);

    ctx.assert(names.includes(attachment.filename), 'The forwarded attachment filename is missing from the assembled draft: ' + JSON.stringify(names));
    const index = names.indexOf(attachment.filename);
    ctx.assert(sizes[index] > 0, 'The forwarded attachment is present but empty in the assembled draft, so it would not open intact.');
}
