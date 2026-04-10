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
