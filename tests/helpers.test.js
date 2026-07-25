// Tests for dist/helpers.js — Gmail message processing helpers (pure functions)
import { describe, it, expect } from '@jest/globals';
import {
    processMessagePart,
    findHeader,
    formatEmailList,
    wrapTextBody,
    foldHeader,
    isHtmlBody,
    constructRawMessage,
    getPlainTextBody,
    getNestedHistory,
    stripQuotedHistory,
    formatMessageClean,
    capArrayByResponseBudget,
} from '../dist/helpers.js';

// ---------------------------------------------------------------------------
// Header folding
// ---------------------------------------------------------------------------
describe('header folding', () => {
    it('folds a multi-address Cc header without quoted-printable breaks', async () => {
        const cc = Array.from({ length: 7 }, (_, index) =>
            `recipient-${index + 1}@example-domain.com`
        );
        const raw = await constructRawMessage(null, {
            to: ['sender@example.com'],
            cc,
            subject: 'Test',
            body: 'Hello',
        });
        const decoded = Buffer.from(raw, 'base64url').toString('utf8');
        const headerBlock = decoded.split('\r\n\r\n')[0];
        const lines = headerBlock.split('\r\n');
        const ccStart = lines.findIndex(line => line.startsWith('Cc:'));
        const ccLines = [lines[ccStart]];
        for (let index = ccStart + 1; lines[index]?.startsWith(' '); index++) {
            ccLines.push(lines[index]);
        }
        const unfoldedCc = ccLines.join('\r\n').replace(/\r\n[ \t]+/g, ' ');

        expect(headerBlock).not.toContain('=\n');
        expect(unfoldedCc).toBe(`Cc: ${cc.join(', ')}`);
        expect(ccLines.length).toBeGreaterThan(1);
        expect(ccLines.slice(1).every(line => line.startsWith(' '))).toBe(true);
    });

    it('leaves short headers unchanged', () => {
        expect(foldHeader('Subject', 'Short subject')).toBe('Subject: Short subject');
    });

    it('neutralizes embedded line breaks, including a lone CR', () => {
        expect(foldHeader('Subject', 'Hello\rBcc: evil@x.com')).toBe('Subject: Hello Bcc: evil@x.com');
        expect(foldHeader('Subject', 'Hello\r\n  world\nagain')).toBe('Subject: Hello world again');
    });

    // RFC 5322 line limits are octets, not UTF-16 code units. These cases would
    // slip past a `string.length` check because each glyph is 1 code unit (or 2,
    // for emoji) but 3-4 UTF-8 octets.
    it('keeps every physical line within the 998-octet hard limit for a long CJK subject', () => {
        // 400 CJK words -> ~2600 octets, well past 998, but folded at spaces.
        const subject = Array.from({ length: 400 }, (_, i) => `件名${i}`).join(' ');
        const folded = foldHeader('Subject', subject);
        const lines = folded.split('\r\n');

        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) {
            expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(998);
        }
        // No corruption: the serialized bytes decode cleanly (no U+FFFD), and the
        // header unfolds back to the exact original value.
        const decoded = Buffer.from(folded, 'utf8').toString('utf8');
        expect(decoded).not.toContain('�');
        const unfolded = folded.replace(/\r\n[ \t]+/g, ' ');
        expect(unfolded).toBe(`Subject: ${subject}`);
    });

    // RFC 5322 §2.2.3 defines unfolding as removing the CRLF only - the WSP
    // that follows is NOT removed. So a fold inserted inside a token that had
    // no original whitespace leaves a permanent extra space in the decoded
    // value: that is corruption, not folding. §3.6.4 additionally says a
    // msg-id "does not have internal CFWS anywhere", so the same operation is
    // flatly illegal for Message-ID/In-Reply-To/References. The only
    // RFC-legal move for a wordless, over-length token is to leave it whole
    // on one (possibly >998-octet) line rather than mutate it.
    it('leaves an unbreakable over-length token whole instead of injecting a corrupting fold', () => {
        // 300 emoji, no whitespace -> ~1200 octets on one token. There is no
        // FWS-legal place to fold inside it, so it must survive as one line.
        const run = '😀'.repeat(300);
        const folded = foldHeader('Subject', run);

        // No fold was injected: exactly one line, and it legitimately
        // exceeds the 998-octet hard limit because it cannot be split.
        expect(folded.split('\r\n')).toHaveLength(1);
        expect(Buffer.byteLength(folded, 'utf8')).toBeGreaterThan(998);

        // True RFC unfolding (remove CRLF only - there isn't one here, so
        // this is a no-op) reproduces the original byte-for-byte, with no
        // manual space-stripping required.
        expect(folded).toBe(`Subject: ${run}`);
        const decoded = Buffer.from(folded, 'utf8').toString('utf8');
        expect(decoded).not.toContain('�');
    });

    it('does not split a multi-byte character straddling the old hard limit', () => {
        // Fill to 1 octet short of the old 998 cutoff with ASCII, then place
        // an emoji, so a naive byte-count cut at 998 would land mid-character.
        // The whole thing is one token (no whitespace), so it must stay whole.
        const subject = 'a'.repeat(987) + '😀' + 'b'.repeat(10);
        const folded = foldHeader('Subject', subject);

        expect(folded.split('\r\n')).toHaveLength(1);
        expect(folded).toBe(`Subject: ${subject}`);
        const decoded = Buffer.from(folded, 'utf8').toString('utf8');
        expect(decoded).not.toContain('�');
    });

    it('never folds inside a message-id atom (RFC 5322 §3.6.4: no internal CFWS)', () => {
        // A single, absurdly long msg-id with no internal whitespace. Even
        // though it blows past both the soft and (old) hard limits, folding
        // inside '<local@domain>' would produce a token that no longer
        // matches the Message-ID it references, breaking threading.
        const msgId = `<${'a'.repeat(1100)}@example.com>`;
        const folded = foldHeader('In-Reply-To', msgId);

        expect(folded.split('\r\n')).toHaveLength(1);
        expect(folded).toBe(`In-Reply-To: ${msgId}`);
    });

    it('never fragments an RFC 2047 encoded-word (RFC 2047 §2: encoded-text MUST NOT continue across encoded-words)', () => {
        // A caller-supplied, already-encoded value with a single very long
        // encoded-word token (no internal whitespace). Splitting inside the
        // base64 encoded-text would produce two syntactically invalid
        // encoded-words and corrupt the decoded characters.
        const encodedWord = `=?UTF-8?B?${'QQ=='.repeat(300)}?=`;
        const folded = foldHeader('Subject', encodedWord);

        expect(folded.split('\r\n')).toHaveLength(1);
        expect(folded).toBe(`Subject: ${encodedWord}`);
    });

    it('still folds a normal multi-word header at existing whitespace, unfolding back exactly', () => {
        // Ordinary ASCII words separated by real spaces: there IS a
        // FWS-legal point between every word, so this should fold normally
        // across multiple lines, each within the recommended 78-octet limit.
        const subject = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
        const folded = foldHeader('Subject', subject);
        const lines = folded.split('\r\n');

        expect(lines.length).toBeGreaterThan(1);
        expect(lines.slice(1).every(line => line.startsWith(' '))).toBe(true);
        for (const line of lines) {
            expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(78);
        }
        // True RFC unfolding: remove the CRLF only. Because each continuation
        // line's leading space is the fold marker that replaces the single
        // space trimmed off the end of the previous line, this reconstructs
        // the original exactly.
        const unfolded = folded.replace(/\r\n/g, '');
        expect(unfolded).toBe(`Subject: ${subject}`);
    });
});

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

    it('always keeps at least one item even if it alone exceeds the budget', () => {
        const items = [{ pad: 'x'.repeat(1000) }, { pad: 'x'.repeat(1000) }];
        const result = capArrayByResponseBudget(items, 10, 'start');
        expect(result.items.length).toBe(1);
        expect(result.truncated).toBe(true);
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
        expect(stripQuotedHistory(body)).toBe('Current reply');
        expect(formatMessageClean(message(body))).toMatchObject({
            body: 'Current reply',
            quotedHistoryStripped: true,
        });
    });

    it('keeps a trailing ">" block the sender authored (no attribution marker)', () => {
        const body = 'Here is a quote I like:\n> To be or not to be';
        expect(stripQuotedHistory(body)).toBe(body);
    });

    it('keeps a trailing block of bare header-like lines (pasted invite)', () => {
        const body = "Let's meet. Details below:\nFrom: Conf Room A\nSent: Projector\nTo: All staff\nSubject: Q3\nDate: Tuesday";
        expect(stripQuotedHistory(body)).toBe(body);
    });

    it('does not strip when a quote block is not preceded by an attribution', () => {
        const body = '> old quoted\nFrom: Me\nTo: Team\nSubject: Weekly Update';
        expect(stripQuotedHistory(body)).toBe(body);
    });

    it('keeps a wrapped attribution whose quote it cannot safely attribute', () => {
        const body = 'Thanks!\nOn Mon, Jul 1, 2024 at 9:00 AM John Smith\n<john@example.com> wrote:\n> previous message';
        expect(stripQuotedHistory(body)).toBe(body);
    });

    it('strips everything after an Original Message delimiter, prefixed or not', () => {
        // "-----Original Message-----" is an unambiguous hard delimiter: Outlook
        // emits it on its own line, and the quoted original commonly runs to the
        // end of the message with no ">" prefixes.
        const prefixed = 'Reply here\n-----Original Message-----\n> the original text';
        expect(stripQuotedHistory(prefixed)).toBe('Reply here');
        const unprefixed = 'Reply here\n-----Original Message-----\nFrom: A\nSent: B\nUnquoted original body';
        expect(stripQuotedHistory(unprefixed)).toBe('Reply here');
    });

    it('strips a multi-line Outlook quoted body with no trailing content', () => {
        // The quoted body itself can span several lines with no blank-line gap;
        // as long as nothing follows it, the whole tail is still quoted history.
        const body = 'Reply\n-----Original Message-----\nFrom: A\nSent: B\nTo: C\nSubject: D\nLine one of body\nLine two of body\nLine three of body';
        expect(stripQuotedHistory(body)).toBe('Reply');
    });

    // -------------------------------------------------------------------
    // Hard delimiter (Outlook "-----Original Message-----") table.
    //
    // An earlier version of this fix tried to detect a genuine trailing
    // reply after the delimiter by treating the body's first paragraph as
    // quoted and anything past a following blank line as authored. That
    // heuristic broke on the single most common real shape: a top-posted
    // reply where Outlook puts a blank line directly after the header
    // block. Because the "first paragraph" scan starts on that blank line
    // and finds it immediately, it consumes zero lines of quoted body, so
    // the entire original (all of it, not just extra paragraphs) came back
    // as "authored" and leaked into the clean output. That is worse than
    // the bug it was meant to fix: it happens silently on every top-posted
    // Outlook reply, not just the rare bottom-posted one.
    //
    // Outlook's pasted original has no ">" prefix, so there is no reliable
    // marker to tell quoted body from authored text after the delimiter.
    // We therefore strip the tail unconditionally and accept that a rare
    // bottom-posted reply is lost the same way a soft-marker false
    // negative would be; callers who need the untouched body can pass
    // includeQuoted: true.
    // -------------------------------------------------------------------

    it('strips a single-paragraph top-posted original with a blank line after the header block', () => {
        const body = 'Sounds good, will do.\n-----Original Message-----\nFrom: Alice\nSent: Monday\nTo: Bob\nSubject: Q3 planning\n\nHi Bob, can you confirm the Q3 numbers?';
        expect(stripQuotedHistory(body)).toBe('Sounds good, will do.');
    });

    it('strips a multi-paragraph top-posted original in full, not just its first paragraph (regression)', () => {
        // This is the exact shape that broke the earlier "preserve trailing
        // paragraph" heuristic: a blank line after the headers, then a
        // quoted body spanning several paragraphs. Every paragraph must be
        // stripped, not just the first one.
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
        expect(stripQuotedHistory(body)).toBe('Sounds good, shipping today.');
    });

    it('strips a top-posted original with no blank line after the header block', () => {
        const body = 'Reply\n-----Original Message-----\nFrom: A\nSent: B\nTo: C\nSubject: D\nLine one of body\nLine two of body\nLine three of body';
        expect(stripQuotedHistory(body)).toBe('Reply');
    });

    it('drops a bottom-posted reply typed after the delimiter (accepted tradeoff, use includeQuoted to recover it)', () => {
        const body = 'Intro\n-----Original Message-----\nFrom: Alice\nOriginal body\n\nMy reply below the quote';
        expect(stripQuotedHistory(body)).toBe('Intro');
        const result = formatMessageClean(message(body), 3000, true);
        expect(result.body).toBe(body);
        expect(result.quotedHistoryStripped).toBeUndefined();
    });

    it('strips a prefixed hard delimiter body ("> "-quoted original) the same as the unprefixed case', () => {
        const body = 'Reply here\n-----Original Message-----\n> the original text';
        expect(stripQuotedHistory(body)).toBe('Reply here');
    });

    it('keeps inline replies written between quoted blocks', () => {
        const body = '> question one\nAnswer one\n> question two\nAnswer two';
        expect(stripQuotedHistory(body)).toBe(body);
    });

    it('keeps bottom-posted replies below a quoted block', () => {
        const body = 'On Mon, Jul 1, 2024 at 9:00 AM Alice <a@example.com> wrote:\n> Earlier message\n\nMy reply comes after the quote';
        expect(stripQuotedHistory(body)).toBe(body);
    });

    it('keeps quoted history when includeQuoted is true', () => {
        // Use a strip-eligible block (attribution + quoted line) so this proves
        // the opt-out actually suppresses a strip that would otherwise happen.
        const body = 'Answer\n\nOn Mon, Jul 1, 2024 at 9:00 AM Alice <a@example.com> wrote:\n> quoted';
        expect(stripQuotedHistory(body)).toBe('Answer'); // would strip by default
        const result = formatMessageClean(message(body), 3000, true);
        expect(result.body).toBe(body);
        expect(result.quotedHistoryStripped).toBeUndefined();
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
