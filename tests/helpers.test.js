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

    it('caps undecoded html base64 payloads in full mode', () => {
        const rawBase64 = Buffer.from('<html>' + 'x'.repeat(500) + '</html>').toString('base64');
        const part = {
            mimeType: 'text/html',
            body: { data: rawBase64 },
        };
        const result = processMessagePart(part, false, 100);
        expect(result.body.data).toHaveLength(100);
        expect(result.body).toMatchObject({
            bodyTruncated: true,
            totalChars: rawBase64.length,
        });
    });

    it('leaves undecoded html payloads alone when maxBodyChars is 0', () => {
        const rawBase64 = Buffer.from('<html>hello</html>').toString('base64');
        const part = { mimeType: 'text/html', body: { data: rawBase64 } };
        const result = processMessagePart(part, false, 0);
        expect(result.body.data).toBe(rawBase64);
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

    it('strips a block beginning with prefixed quote lines', () => {
        expect(stripQuotedHistory('Answer\n\n   > quoted one\n> quoted two')).toBe('Answer');
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
        const body = 'Answer\n> quoted';
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
