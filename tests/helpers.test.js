// Tests for dist/helpers.js — Gmail message processing helpers (pure functions)
import { describe, it, expect } from '@jest/globals';
import {
    processMessagePart,
    findHeader,
    formatEmailList,
    wrapTextBody,
    isHtmlBody,
    getPlainTextBody,
    getNestedHistory,
    stripQuotedHistory,
    formatMessageClean,
    capArrayByResponseBudget,
    capToResponseBudget,
    makeOmissionStub,
} from '../dist/helpers.js';

// ---------------------------------------------------------------------------
// findHeader
// ---------------------------------------------------------------------------
describe('findHeader', () => {
    const headers = [
        { name: 'From', value: 'alice@example.com' },
        { name: 'To', value: 'bob@example.com' },
        { name: 'Subject', value: 'Test Subject' },
        { name: 'Date', value: 'Mon, 1 Jan 2024 00:00:00 +0000' },
    ];

    it('finds header by exact name', () => {
        expect(findHeader(headers, 'From')).toBe('alice@example.com');
    });

    it('is case-insensitive', () => {
        expect(findHeader(headers, 'from')).toBe('alice@example.com');
        expect(findHeader(headers, 'SUBJECT')).toBe('Test Subject');
    });

    it('returns undefined for missing header', () => {
        expect(findHeader(headers, 'Bcc')).toBeUndefined();
    });

    it('returns undefined for null/empty inputs', () => {
        expect(findHeader(null, 'From')).toBeUndefined();
        expect(findHeader([], 'From')).toBeUndefined();
        expect(findHeader(headers, null)).toBeUndefined();
        expect(findHeader(headers, '')).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// formatEmailList
// ---------------------------------------------------------------------------
describe('formatEmailList', () => {
    it('splits comma-separated emails', () => {
        expect(formatEmailList('a@x.com, b@x.com')).toEqual(['a@x.com', 'b@x.com']);
    });

    it('trims whitespace', () => {
        expect(formatEmailList('  a@x.com ,  b@x.com  ')).toEqual(['a@x.com', 'b@x.com']);
    });

    it('handles single email', () => {
        expect(formatEmailList('a@x.com')).toEqual(['a@x.com']);
    });

    it('returns empty array for null/undefined', () => {
        expect(formatEmailList(null)).toEqual([]);
        expect(formatEmailList(undefined)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// wrapTextBody
// ---------------------------------------------------------------------------
describe('wrapTextBody', () => {
    it('does not wrap lines <= 76 chars', () => {
        const short = 'Hello, world!';
        expect(wrapTextBody(short)).toBe(short);
    });

    it('wraps long lines at 76-char boundaries', () => {
        const long = 'A'.repeat(200);
        const wrapped = wrapTextBody(long);
        // Should contain soft line breaks
        expect(wrapped).toContain('=\n');
        // First chunk should be 76 chars
        const firstChunk = wrapped.split('=\n')[0];
        expect(firstChunk.length).toBe(76);
    });

    it('preserves existing newlines', () => {
        const input = 'line1\nline2\nline3';
        const result = wrapTextBody(input);
        expect(result.split('\n').length).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// isHtmlBody
// ---------------------------------------------------------------------------
describe('isHtmlBody', () => {
    it('detects HTML tags', () => {
        expect(isHtmlBody('<p>Hello</p>')).toBe(true);
        expect(isHtmlBody('<div>Content</div>')).toBe(true);
        expect(isHtmlBody('<br/>')).toBe(true);
    });

    it('returns false for plain text', () => {
        expect(isHtmlBody('Hello, world!')).toBe(false);
        expect(isHtmlBody('No HTML here')).toBe(false);
    });

    it('handles edge cases', () => {
        expect(isHtmlBody('')).toBe(false);
        expect(isHtmlBody('5 < 10 and 20 > 15')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// getPlainTextBody
// ---------------------------------------------------------------------------
describe('getPlainTextBody', () => {
    it('extracts text/plain body from simple part', () => {
        const part = {
            mimeType: 'text/plain',
            body: { data: Buffer.from('Hello world').toString('base64') },
        };
        expect(getPlainTextBody(part)).toBe('Hello world');
    });

    it('extracts text/plain from nested parts', () => {
        const part = {
            mimeType: 'multipart/alternative',
            parts: [
                {
                    mimeType: 'text/plain',
                    body: { data: Buffer.from('Plain text').toString('base64') },
                },
                {
                    mimeType: 'text/html',
                    body: { data: Buffer.from('<p>HTML</p>').toString('base64') },
                },
            ],
        };
        expect(getPlainTextBody(part)).toBe('Plain text');
    });

    it('returns empty string when no text/plain found', () => {
        const part = {
            mimeType: 'text/html',
            body: { data: Buffer.from('<p>Only HTML</p>').toString('base64') },
        };
        expect(getPlainTextBody(part)).toBe('');
    });

    it('returns empty string for missing body', () => {
        expect(getPlainTextBody({ mimeType: 'text/plain' })).toBe('');
    });

    it('does not throw on malformed base64 (untrusted input safety)', () => {
        const part = { mimeType: 'text/plain', body: { data: 'not!!valid$$base64%%' } };
        expect(() => getPlainTextBody(part)).not.toThrow();
        expect(typeof getPlainTextBody(part)).toBe('string');
    });
});

// ---------------------------------------------------------------------------
// processMessagePart
// ---------------------------------------------------------------------------
describe('processMessagePart', () => {
    it('decodes base64 body for text/plain parts', () => {
        const part = {
            mimeType: 'text/plain',
            body: { data: Buffer.from('Hello').toString('base64') },
        };
        const result = processMessagePart(part);
        expect(result.body.data).toBe('Hello');
    });

    it('filters headers to standard response set', () => {
        const part = {
            mimeType: 'text/plain',
            body: { data: Buffer.from('test').toString('base64') },
            headers: [
                { name: 'From', value: 'a@b.com' },
                { name: 'X-Custom-Header', value: 'custom' },
                { name: 'Subject', value: 'Test' },
            ],
        };
        const result = processMessagePart(part);
        expect(result.headers).toHaveLength(2);
        expect(result.headers.map(h => h.name)).toEqual(['From', 'Subject']);
    });

    it('does not decode HTML body by default', () => {
        const htmlData = Buffer.from('<p>Hello</p>').toString('base64');
        const part = {
            mimeType: 'text/html',
            body: { data: htmlData },
        };
        const result = processMessagePart(part, false);
        // HTML body should be left as-is (not decoded) by default
        expect(result.body.data).toBe(htmlData);
    });

    it('decodes HTML body when includeBodyHtml is true', () => {
        const part = {
            mimeType: 'text/html',
            body: { data: Buffer.from('<p>Hello</p>').toString('base64') },
        };
        const result = processMessagePart(part, true);
        expect(result.body.data).toBe('<p>Hello</p>');
    });

    it('processes nested parts recursively', () => {
        const part = {
            mimeType: 'multipart/mixed',
            parts: [
                {
                    mimeType: 'text/plain',
                    body: { data: Buffer.from('Text').toString('base64') },
                },
            ],
        };
        const result = processMessagePart(part);
        expect(result.parts[0].body.data).toBe('Text');
    });

    it('truncates decoded text bodies in full mode with original size metadata', () => {
        const part = {
            mimeType: 'text/plain',
            body: { data: Buffer.from('abcdefghij').toString('base64') },
        };
        const result = processMessagePart(part, false, 4);
        expect(result.body).toMatchObject({
            data: 'abcd',
            bodyTruncated: true,
            totalChars: 10,
        });
    });

    it('omits oversized undecoded html payloads and reports decoded totalChars', () => {
        const decoded = '<html>' + 'x'.repeat(500) + '</html>';
        const rawBase64 = Buffer.from(decoded).toString('base64');
        const part = {
            mimeType: 'text/html',
            body: { data: rawBase64, size: decoded.length },
        };
        const result = processMessagePart(part, false, 100);
        // Payload is dropped entirely — never sliced into invalid base64.
        expect(result.body.data).toBeUndefined();
        expect(result.body).toMatchObject({
            bodyOmitted: true,
            totalChars: decoded.length,
        });
    });

    it('omits undecoded payloads even when the cap falls mid-base64 (no corruption)', () => {
        // Cap of 7 lands inside a base64 quantum; the old slice-at-offset path
        // would have emitted invalid base64 and an encoded-char totalChars.
        const decoded = 'x'.repeat(40);
        const rawBase64 = Buffer.from(decoded).toString('base64');
        const part = { mimeType: 'text/html', body: { data: rawBase64 } };
        const result = processMessagePart(part, false, 7);
        expect(result.body.data).toBeUndefined();
        expect(result.body.bodyOmitted).toBe(true);
        expect(result.body.totalChars).toBe(decoded.length); // decoded, not encoded
    });

    it('keeps an undecoded html payload whose decoded length is within the cap', () => {
        const decoded = '<html>hello</html>';
        const rawBase64 = Buffer.from(decoded).toString('base64');
        const part = { mimeType: 'text/html', body: { data: rawBase64 } };
        const result = processMessagePart(part, false, 100);
        expect(result.body.data).toBe(rawBase64);
    });

    it('omits an undecoded payload whose base64 exceeds the cap even when its decoded text does not', () => {
        // Non-ASCII is the case the decoded-only check missed: these characters
        // are three bytes each, so 3,000 of them decode to 3,000 characters
        // (under a 10,000 cap) but return roughly 12,000 characters of base64.
        const decoded = '漢'.repeat(3000);
        const rawBase64 = Buffer.from(decoded).toString('base64');
        expect(decoded.length).toBeLessThan(10000);
        expect(rawBase64.length).toBeGreaterThan(10000);
        const part = { mimeType: 'text/html', body: { data: rawBase64 } };
        const result = processMessagePart(part, false, 10000);
        expect(result.body.data).toBeUndefined();
        expect(result.body).toMatchObject({
            bodyOmitted: true,
            totalChars: decoded.length,
            encodedChars: rawBase64.length,
        });
    });

    it('leaves undecoded html payloads alone when maxBodyChars is 0', () => {
        const rawBase64 = Buffer.from('<html>hello</html>').toString('base64');
        const part = { mimeType: 'text/html', body: { data: rawBase64 } };
        const result = processMessagePart(part, false, 0);
        expect(result.body.data).toBe(rawBase64);
    });

    it('caps each text part independently — maxBodyChars is per-part, not a total budget', () => {
        // A multipart message with several oversized text parts: every part is
        // capped to maxBodyChars on its own, so the summed body can exceed the
        // cap. This documents the per-part contract (not a whole-response cap).
        const textPart = (n) => ({
            mimeType: 'text/plain',
            body: { data: Buffer.from('y'.repeat(n)).toString('base64') },
        });
        const part = {
            mimeType: 'multipart/mixed',
            parts: [textPart(50), textPart(50), textPart(50)],
        };
        const result = processMessagePart(part, false, 10);
        for (const child of result.parts) {
            expect(child.body.data).toHaveLength(10);
            expect(child.body).toMatchObject({ bodyTruncated: true, totalChars: 50 });
        }
        const totalKept = result.parts.reduce((sum, c) => sum + c.body.data.length, 0);
        expect(totalKept).toBe(30); // 3 parts * 10 > the 10-char per-part cap
    });
});

// ---------------------------------------------------------------------------
// capArrayByResponseBudget — whole-response character budget (merge-blocking
// review finding on PR #63: maxBodyChars only caps each message/part
// independently, so total response size across many messages/threads was
// unbounded).
// ---------------------------------------------------------------------------
describe('capArrayByResponseBudget', () => {
    it('leaves the array untouched when it is already under budget', () => {
        const items = [{ a: 1 }, { a: 2 }];
        const result = capArrayByResponseBudget(items, 10000, 'start');
        expect(result).toMatchObject({ items, truncated: false, totalCount: 2, includedCount: 2 });
    });

    it('drops from the start (oldest-first) when dropFrom is "start"', () => {
        const items = [{ id: 1, pad: 'x'.repeat(50) }, { id: 2, pad: 'x'.repeat(50) }, { id: 3, pad: 'x'.repeat(50) }];
        const fullSize = JSON.stringify(items).length;
        const result = capArrayByResponseBudget(items, fullSize - 1, 'start');
        expect(result.truncated).toBe(true);
        expect(result.totalCount).toBe(3);
        expect(result.items[result.items.length - 1].id).toBe(3);
        expect(result.items.some(i => i.id === 1)).toBe(false);
        expect(JSON.stringify(result.items).length).toBeLessThanOrEqual(fullSize - 1);
    });

    it('drops from the end (lowest-priority-last) when dropFrom is "end"', () => {
        const items = [{ id: 1, pad: 'x'.repeat(50) }, { id: 2, pad: 'x'.repeat(50) }, { id: 3, pad: 'x'.repeat(50) }];
        const fullSize = JSON.stringify(items).length;
        const result = capArrayByResponseBudget(items, fullSize - 1, 'end');
        expect(result.truncated).toBe(true);
        expect(result.items[0].id).toBe(1);
        expect(result.items.some(i => i.id === 3)).toBe(false);
    });

    it('without a makeStub function, keeps the oversized last item as-is (low-level primitive, opt-in only)', () => {
        // This is the behavior a merge-blocking review flagged: on its own,
        // capArrayByResponseBudget cannot guarantee the array fits maxChars,
        // because a lone oversized item is kept unbounded. That is still true
        // here, deliberately: this primitive has no way to build a stub for
        // an arbitrary item shape. Every production call site now always
        // passes a makeStub (see the tests below and in gmailThreads.test.js
        // for the actual end-to-end guarantee); this test just documents the
        // low-level floor when a caller does not.
        const items = [{ pad: 'x'.repeat(1000) }, { pad: 'x'.repeat(1000) }];
        const result = capArrayByResponseBudget(items, 10, 'start');
        expect(result.items.length).toBe(1);
        expect(result.truncated).toBe(true);
        expect(JSON.stringify(result.items).length).toBeGreaterThan(10);
    });

    it('with a makeStub function, replaces an oversized last item with its bounded stub instead of keeping it unbounded', () => {
        const items = [{ id: 'a', pad: 'x'.repeat(1000) }, { id: 'b', pad: 'x'.repeat(1000) }];
        const makeStub = (item, maxChars) => makeOmissionStub(item, maxChars, id => `omitted: ${id}`);
        const result = capArrayByResponseBudget(items, 60, 'start', makeStub);
        expect(result.items).toHaveLength(1);
        expect(result.items[0]).toMatchObject({ id: 'b', responseOmitted: true });
        expect(result.items[0].pad).toBeUndefined();
        expect(JSON.stringify(result.items).length).toBeLessThanOrEqual(60);
    });

    it('treats maxChars <= 0 as unlimited (opt-out)', () => {
        const items = [{ pad: 'x'.repeat(1000) }, { pad: 'x'.repeat(1000) }];
        expect(capArrayByResponseBudget(items, 0, 'start')).toMatchObject({ truncated: false, includedCount: 2 });
        expect(capArrayByResponseBudget(items, undefined, 'start')).toMatchObject({ truncated: false, includedCount: 2 });
    });

    it('handles an empty array without throwing', () => {
        expect(capArrayByResponseBudget([], 100, 'start')).toMatchObject({ items: [], truncated: false, totalCount: 0, includedCount: 0 });
    });
});

// ---------------------------------------------------------------------------
// makeOmissionStub
// ---------------------------------------------------------------------------
describe('makeOmissionStub', () => {
    it('includes the id and a reason that fits within maxChars', () => {
        const stub = makeOmissionStub({ id: 'msg-1' }, 500, id => `This item (${id}) was too large to include.`);
        expect(stub.id).toBe('msg-1');
        expect(stub.responseOmitted).toBe(true);
        expect(stub.omittedReason).toBe('This item (msg-1) was too large to include.');
        expect(JSON.stringify(stub).length).toBeLessThanOrEqual(500);
    });

    it('truncates the reason to whatever room remains instead of exceeding maxChars', () => {
        const longReason = 'x'.repeat(1000);
        const stub = makeOmissionStub({ id: 'msg-1' }, 80, () => longReason);
        expect(JSON.stringify(stub).length).toBeLessThanOrEqual(80);
        expect(stub.omittedReason.length).toBeLessThan(longReason.length);
    });

    it('drops the reason entirely, keeping only the bare skeleton, when there is no room for it at all', () => {
        const stub = makeOmissionStub({ id: 'msg-1' }, 10, () => 'anything');
        expect(stub).toEqual({ id: 'msg-1', responseOmitted: true });
    });

    it('caps an unreasonably long id so the id itself cannot blow the budget', () => {
        const stub = makeOmissionStub({ id: 'x'.repeat(10000) }, 300, id => `omitted: ${id}`);
        expect(JSON.stringify(stub).length).toBeLessThanOrEqual(300);
    });
});

// ---------------------------------------------------------------------------
// capToResponseBudget
// ---------------------------------------------------------------------------
describe('capToResponseBudget', () => {
    // capToResponseBudget returns { ok, payload } on success, or
    // { ok: false, minimumViableChars, payload } when no payload that both
    // fits maxChars and means anything can be produced (a second
    // merge-blocking review finding on PR #63: the prior version silently
    // returned the full, unbounded item once the internal per-attempt budget
    // was squeezed to 0, because capArrayByResponseBudget treats <= 0 as its
    // own "caller opted out" sentinel and the two meanings collided).
    const attach = (state) => (items, truncated, totalCount, includedCount, maxChars) => {
        state.items = items;
        state.truncated = truncated;
        state.totalCount = totalCount;
        state.includedCount = includedCount;
        state.maxChars = maxChars;
        return { items, truncated, totalCount, includedCount };
    };

    it('returns the untouched payload when it already fits, with no metadata attached', () => {
        const state = {};
        const items = [{ id: 1 }, { id: 2 }];
        const result = capToResponseBudget(items, 10000, 'start', undefined, attach(state));
        expect(result.ok).toBe(true);
        expect(result.payload.truncated).toBe(false);
        expect(result.payload.items).toBe(items);
    });

    it('guarantees the final payload (items plus metadata) fits maxChars, not just the array alone', () => {
        // Each item alone is small, but the metadata this attach function
        // adds is deliberately large relative to maxChars, so capping the
        // array to the full budget and adding metadata afterward (the old
        // bug) would overshoot. capToResponseBudget must shrink the array
        // further to leave room for it, and this stays airtight down to the
        // single-item floor because a makeStub is supplied.
        const items = Array.from({ length: 10 }, (_, i) => ({ id: i, pad: 'y'.repeat(20) }));
        const bigNote = 'z'.repeat(150);
        const makeStub = (item, maxChars) => makeOmissionStub(item, maxChars, id => `omitted: ${id}`);
        const attachWithBigNote = (capped, truncated, totalCount, includedCount) => ({
            items: capped,
            truncated,
            totalCount,
            includedCount,
            ...(truncated ? { note: bigNote } : {}),
        });
        const maxChars = 400;
        const result = capToResponseBudget(items, maxChars, 'start', makeStub, attachWithBigNote);
        expect(result.ok).toBe(true);
        expect(JSON.stringify(result.payload).length).toBeLessThanOrEqual(maxChars);
        expect(result.payload.truncated).toBe(true);
        // Fewer items survive than would fit the array alone against the full
        // 400-char budget, proving room was actually reserved for `note`.
        const arrayOnlyFit = capArrayByResponseBudget(items, maxChars, 'start', makeStub).includedCount;
        expect(result.payload.includedCount).toBeLessThan(arrayOnlyFit);
    });

    it('replaces a single oversized item with a bounded stub via the provided makeStub, keeping the final payload within maxChars', () => {
        const items = [{ id: 'only', pad: 'x'.repeat(1000) }];
        const makeStub = (item, maxChars) => makeOmissionStub(item, maxChars, id => `omitted: ${id}`);
        const maxChars = 200;
        const result = capToResponseBudget(items, maxChars, 'start', makeStub, (capped, truncated, totalCount, includedCount) => ({
            items: capped,
            truncated,
            totalCount,
            includedCount,
        }));
        expect(result.ok).toBe(true);
        expect(JSON.stringify(result.payload).length).toBeLessThanOrEqual(maxChars);
        expect(result.payload.items[0].responseOmitted).toBe(true);
    });

    it('treats maxChars <= 0 as unlimited and returns the untouched payload', () => {
        const items = [{ pad: 'x'.repeat(1000) }];
        const result = capToResponseBudget(items, 0, 'start', undefined, (capped, truncated) => ({ items: capped, truncated }));
        expect(result.ok).toBe(true);
        expect(result.payload.truncated).toBe(false);
        expect(result.payload.items).toBe(items);
    });

    it('never lets the internal per-attempt budget collide with capArrayByResponseBudget\'s own <= 0 opt-out sentinel', () => {
        // Regression test for the exact inversion a second review found: a
        // single 50,000 char item whose metadata note costs more than tiny
        // budgets, at every budget from 1 through 2000, must never come back
        // as the full unstubbed item (which is what happens if an internal
        // budget of 0 gets reinterpreted as "caller opted out").
        const bigItem = { id: 'oversized', body: 'y'.repeat(50000) };
        const makeStub = (item, maxChars) => makeOmissionStub(item, maxChars, id => `omitted: ${id}`);
        const noteFor = (includedCount, totalCount) => `Showing ${includedCount} of ${totalCount}. `.padEnd(120, 'z');
        const attach = (capped, truncated, totalCount, includedCount, maxChars) => {
            const withoutNote = { items: capped, truncated, totalCount, includedCount };
            if (!truncated) return withoutNote;
            const baseSize = JSON.stringify(withoutNote).length;
            const room = Math.max(0, (maxChars || 0) - baseSize - 20);
            const note = noteFor(includedCount, totalCount).slice(0, room);
            return note ? { ...withoutNote, note } : withoutNote;
        };
        for (let maxChars = 1; maxChars <= 2000; maxChars += 37) {
            const result = capToResponseBudget([bigItem], maxChars, 'start', makeStub, attach);
            if (result.ok) {
                // The invariant the review demanded: whatever comes back
                // actually fits, and is not the raw 50,000 char item.
                expect(JSON.stringify(result.payload).length).toBeLessThanOrEqual(maxChars);
                expect(JSON.stringify(result.payload)).not.toContain('yyyyyyyyyy');
            } else {
                // Honest refusal: a concrete, larger-than-maxChars minimum is
                // reported instead of a silently oversized payload.
                expect(result.minimumViableChars).toBeGreaterThan(maxChars);
                expect(JSON.stringify(result.payload)).not.toContain('yyyyyyyyyy');
            }
        }
    });
});

describe('quoted history stripping', () => {
    const message = (body) => ({
        id: 'm1',
        threadId: 't1',
        payload: {
            mimeType: 'text/plain',
            headers: [],
            body: { data: Buffer.from(body).toString('base64') },
        },
    });

    it('strips Gmail On ... wrote attribution and quoted lines', () => {
        const body = 'Current reply\n\nOn Mon, Jul 1, 2024 at 9:00 AM Alice <a@example.com> wrote:\n> Earlier message';
        expect(stripQuotedHistory(body)).toMatchObject({ text: 'Current reply', quotedHistoryAmbiguous: false });
        const result = formatMessageClean(message(body));
        expect(result).toMatchObject({ body: 'Current reply', quotedHistoryStripped: true });
        expect(result.quotedHistoryAmbiguous).toBeUndefined();
    });

    it('keeps a trailing ">" block the sender authored (no attribution marker)', () => {
        const body = 'Here is a quote I like:\n> To be or not to be';
        expect(stripQuotedHistory(body)).toMatchObject({ text: body, quotedHistoryAmbiguous: false });
    });

    it('keeps a trailing block of bare header-like lines (pasted invite)', () => {
        const body = "Let's meet. Details below:\nFrom: Conf Room A\nSent: Projector\nTo: All staff\nSubject: Q3\nDate: Tuesday";
        expect(stripQuotedHistory(body)).toMatchObject({ text: body, quotedHistoryAmbiguous: false });
    });

    it('does not strip when a quote block is not preceded by an attribution', () => {
        const body = '> old quoted\nFrom: Me\nTo: Team\nSubject: Weekly Update';
        expect(stripQuotedHistory(body)).toMatchObject({ text: body, quotedHistoryAmbiguous: false });
    });

    it('keeps a wrapped attribution whose quote it cannot safely attribute', () => {
        const body = 'Thanks!\nOn Mon, Jul 1, 2024 at 9:00 AM John Smith\n<john@example.com> wrote:\n> previous message';
        expect(stripQuotedHistory(body)).toMatchObject({ text: body, quotedHistoryAmbiguous: false });
    });

    // -------------------------------------------------------------------
    // Hard delimiter (Outlook "-----Original Message-----") table.
    //
    // Two earlier attempts at this got it wrong in opposite directions:
    // stripping the tail unconditionally silently deleted a real reply typed
    // below the delimiter, and a later heuristic that tried to preserve a
    // trailing paragraph instead leaked whole multi-paragraph quotes into the
    // clean body, because Outlook puts a blank line right after the header
    // block, so the "first paragraph is quoted" scan matched nothing and the
    // entire original came back as "authored".
    //
    // The fix asks a different, answerable question: can quotedness be
    // established at all, the same way the soft-marker path already
    // requires at least one ">"-quoted line before it strips anything? If
    // the tail after the delimiter has no ">" prefixes, quotedness cannot be
    // established (Outlook's pasted original never has them), so nothing is
    // stripped, the full body is preserved, and the response says so via
    // quotedHistoryAmbiguous/quotedHistoryNote instead of silently guessing
    // in either direction. Only a tail that positively verifies as quoted
    // (blank/attribution/">"-quoted lines only, with at least one ">" line)
    // is stripped, exactly like the soft-marker path.
    // -------------------------------------------------------------------

    it('strips a hard delimiter body once quotedness is established by a ">" prefix', () => {
        const body = 'Reply here\n-----Original Message-----\n> the original text';
        expect(stripQuotedHistory(body)).toMatchObject({ text: 'Reply here', quotedHistoryAmbiguous: false });
    });

    it('leaves a single-paragraph top-posted original in place when it has no ">" prefixes (quotedness not established)', () => {
        const body = 'Sounds good, will do.\n-----Original Message-----\nFrom: Alice\nSent: Monday\nTo: Bob\nSubject: Q3 planning\n\nHi Bob, can you confirm the Q3 numbers?';
        expect(stripQuotedHistory(body)).toMatchObject({ text: body, quotedHistoryAmbiguous: true });
    });

    it('leaves a multi-paragraph top-posted original in place rather than leak or guess (regression repro)', () => {
        // This is the exact shape that broke the earlier "preserve trailing
        // paragraph" heuristic: a blank line after the headers, then a quoted
        // body spanning several paragraphs, no ">" prefixes anywhere. We can no
        // longer tell where the quote ends, so nothing is stripped and the
        // full body, including every paragraph, comes back unchanged.
        const body = [
            'Sounds good, shipping today.',
            '-----Original Message-----',
            'From: Alice <alice@example.com>',
            'Sent: Monday, July 20, 2026 9:00 AM',
            'To: Bob',
            'Subject: Q3 planning',
            '',
            'Hi Bob,',
            'Can you confirm the Q3 numbers?',
            '',
            'I also need the headcount plan by Friday.',
            '',
            'Thanks,',
            'Alice',
        ].join('\n');
        expect(stripQuotedHistory(body)).toMatchObject({ text: body, quotedHistoryAmbiguous: true });
    });

    it('leaves a top-posted original in place when there is no blank line after the header block either', () => {
        const body = 'Reply\n-----Original Message-----\nFrom: A\nSent: B\nTo: C\nSubject: D\nLine one of body\nLine two of body\nLine three of body';
        expect(stripQuotedHistory(body)).toMatchObject({ text: body, quotedHistoryAmbiguous: true });
    });

    it('default clean mode never deletes a bottom-posted reply typed after an Outlook delimiter (required regression test)', () => {
        // The reviewer's core requirement: a caller using the default clean
        // mode must never have this authored line silently removed. It comes
        // back as part of the full, unstripped body, flagged as ambiguous.
        const body = 'Intro\n-----Original Message-----\nFrom: Alice\nOriginal body\n\nMy reply below the quote';
        const stripped = stripQuotedHistory(body);
        expect(stripped.text).toBe(body);
        expect(stripped.text).toContain('My reply below the quote');
        expect(stripped.quotedHistoryAmbiguous).toBe(true);

        const result = formatMessageClean(message(body));
        expect(result.body).toBe(body);
        expect(result.body).toContain('My reply below the quote');
        expect(result.quotedHistoryStripped).toBeUndefined();
        expect(result.quotedHistoryAmbiguous).toBe(true);
        expect(typeof result.quotedHistoryNote).toBe('string');
    });

    it('keeps inline replies written between quoted blocks', () => {
        const body = '> question one\nAnswer one\n> question two\nAnswer two';
        expect(stripQuotedHistory(body)).toMatchObject({ text: body, quotedHistoryAmbiguous: false });
    });

    it('keeps bottom-posted replies below a Gmail-style quoted block (soft marker, unaffected by the hard-delimiter path)', () => {
        const body = 'On Mon, Jul 1, 2024 at 9:00 AM Alice <a@example.com> wrote:\n> Earlier message\n\nMy reply comes after the quote';
        expect(stripQuotedHistory(body)).toMatchObject({ text: body, quotedHistoryAmbiguous: false });
    });

    it('keeps quoted history when includeQuoted is true, and never reports ambiguity when the check is skipped', () => {
        // Use a strip-eligible block (attribution + quoted line) so this proves
        // the opt-out actually suppresses a strip that would otherwise happen.
        const body = 'Answer\n\nOn Mon, Jul 1, 2024 at 9:00 AM Alice <a@example.com> wrote:\n> quoted';
        expect(stripQuotedHistory(body)).toMatchObject({ text: 'Answer', quotedHistoryAmbiguous: false }); // would strip by default
        const result = formatMessageClean(message(body), 3000, true);
        expect(result.body).toBe(body);
        expect(result.quotedHistoryStripped).toBeUndefined();
        expect(result.quotedHistoryAmbiguous).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// getNestedHistory
// ---------------------------------------------------------------------------
describe('getNestedHistory', () => {
    it('quotes text/plain body lines', () => {
        const part = {
            mimeType: 'text/plain',
            body: { data: Buffer.from('Line 1\nLine 2').toString('base64') },
        };
        const result = getNestedHistory(part);
        expect(result).toBe('> Line 1\n> Line 2');
    });

    it('handles already-quoted lines (no extra space)', () => {
        const part = {
            mimeType: 'text/plain',
            body: { data: Buffer.from('> Already quoted').toString('base64') },
        };
        const result = getNestedHistory(part);
        // Should not add extra space before '>'
        expect(result).toBe('>> Already quoted');
    });

    it('returns empty for non-text parts with no sub-parts', () => {
        const part = { mimeType: 'application/octet-stream' };
        expect(getNestedHistory(part)).toBe('');
    });
});
