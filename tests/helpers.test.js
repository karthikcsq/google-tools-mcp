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

    it('hard-splits an unbreakable emoji run on code-point boundaries without corruption', () => {
        // 300 emoji, no whitespace -> 1200 octets on one token, forcing an
        // emergency cut. A naive UTF-16 or raw-byte slice would sever a surrogate
        // pair / multi-byte sequence and yield replacement characters.
        const run = '😀'.repeat(300);
        const folded = foldHeader('Subject', run);
        const lines = folded.split('\r\n');

        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) {
            expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(998);
        }
        // Round-trip through UTF-8 bytes to prove no split produced a lone
        // surrogate or truncated code point.
        const decoded = Buffer.from(folded, 'utf8').toString('utf8');
        expect(decoded).not.toContain('�');
        // The run has no internal whitespace, so removing each injected CRLF+space
        // continuation reconstructs the original exactly.
        const reconstructed = folded.replace(/^Subject: /, '').replace(/\r\n /g, '');
        expect(reconstructed).toBe(run);
    });

    it('does not split a multi-byte character straddling the hard limit', () => {
        // Fill to 1 octet short of the limit with ASCII, then place an emoji so a
        // byte-count cut at 998 would land mid-character.
        // "Subject: " is 9 octets; 987 'a' puts the emoji at octets 996-1000, so a
        // byte cut at 998 must stop before it rather than slicing it in half.
        const subject = 'a'.repeat(987) + '😀' + 'b'.repeat(10);
        const folded = foldHeader('Subject', subject);
        for (const line of folded.split('\r\n')) {
            expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(998);
        }
        const decoded = Buffer.from(folded, 'utf8').toString('utf8');
        expect(decoded).not.toContain('�');
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
