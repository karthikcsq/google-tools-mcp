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
        // emits it on its own line and never writes reply text below it, so the
        // whole tail is quoted history even without ">" prefixes.
        const prefixed = 'Reply here\n-----Original Message-----\n> the original text';
        expect(stripQuotedHistory(prefixed)).toBe('Reply here');
        const unprefixed = 'Reply here\n-----Original Message-----\nFrom: A\nSent: B\nUnquoted original body';
        expect(stripQuotedHistory(unprefixed)).toBe('Reply here');
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
