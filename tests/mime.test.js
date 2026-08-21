// Tests for dist/mime.js and the four Gmail message-building surfaces that
// route through it (issue #73, which subsumes #54).
//
// These are byte-level tests on purpose: the whole point of the change is what
// lands on the wire, so every assertion decodes the base64url `raw` field the
// tool actually sends and inspects the exact header bytes.
import { jest, describe, it, expect, beforeAll } from '@jest/globals';
import { createHash } from 'node:crypto';

import {
    asciiFallbackParameter,
    assembleMultipart,
    assembleSinglePart,
    buildContentDispositionHeader,
    buildContentTypeHeader,
    encodeAddressList,
    encodeDisplayName,
    encodeEncodedWords,
    encodeHeaderValue,
    encodeParameter,
    foldHeader,
    makeBoundary,
    needsEncoding,
    normalizeBase64,
    qpEncodeBody,
    toBase64Url,
    validateMimeType,
    wrapBase64,
    HARD_LINE_LIMIT,
    SOFT_LINE_LIMIT,
} from '../dist/mime.js';
import { constructRawMessage, constructRawMessageWithAttachments } from '../dist/helpers.js';
import { isPublicError, getPublicErrorMessage } from '../dist/errors.js';

// ---------------------------------------------------------------------------
// Shared decoders. Nothing here reuses production code — a test that decodes
// with the same helper that encoded would prove nothing.
// ---------------------------------------------------------------------------

/** Decode an RFC 2047 encoded-word run back to the original text. */
const decodeEncodedWords = (value) => value
    // RFC 2047 §6.2: whitespace between two adjacent encoded-words is not
    // part of the value and is removed by the decoder.
    .replace(/\?=[ \t]+=\?/g, '?==?')
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_match, payload) => Buffer.from(payload, 'base64').toString('binary'))
    .replace(/[\s\S]*/, (text) => Buffer.from(text, 'binary').toString('utf8'));

/** RFC 5322 §2.2.3 unfolding: remove the CRLF, keep the WSP that follows. */
const unfold = (header) => header.replace(/\r\n(?=[ \t])/g, '');

/** Split a decoded raw message into its header block and body. */
const splitMessage = (raw) => {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const separator = decoded.indexOf('\r\n\r\n');
    return {
        decoded,
        headerBlock: decoded.slice(0, separator),
        body: decoded.slice(separator + 4),
    };
};

/** Collect one logical header (first line plus its continuations). */
const logicalHeader = (headerBlock, name) => {
    const lines = headerBlock.split('\r\n');
    const start = lines.findIndex((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`));
    if (start === -1) return undefined;
    const collected = [lines[start]];
    for (let index = start + 1; lines[index]?.startsWith(' ') || lines[index]?.startsWith('\t'); index += 1) {
        collected.push(lines[index]);
    }
    return collected.join('\r\n');
};

/** Independent quoted-printable decoder (RFC 2045 §6.7). */
const qpDecode = (text) => {
    const joined = String(text).replace(/=\r\n/g, '');
    const octets = [];
    for (let index = 0; index < joined.length; index += 1) {
        const char = joined[index];
        if (char === '=' && /^[0-9A-F]{2}$/.test(joined.slice(index + 1, index + 3))) {
            octets.push(parseInt(joined.slice(index + 1, index + 3), 16));
            index += 2;
        } else {
            octets.push(...Buffer.from(char, 'utf8'));
        }
    }
    return Buffer.from(octets).toString('utf8');
};

/** Decode a full RFC 2231 parameter (with or without continuations). */
const decodeParameterValue = (headerValue, name) => {
    const sections = [];
    // The leading delimiter matters: without it, a search for "name" would also
    // match inside "filename*0*=".
    const extended = new RegExp(`(?:^|[;\\s])${name}\\*(?:(\\d+)\\*)?=(?:UTF-8'')?([^;\\r\\n]*)`, 'gi');
    for (const match of unfold(headerValue).matchAll(extended)) {
        sections.push({ index: match[1] === undefined ? 0 : Number(match[1]), value: match[2] });
    }
    if (!sections.length) return undefined;
    sections.sort((left, right) => left.index - right.index);
    const percent = sections.map((section) => section.value).join('');
    const octets = [];
    for (let index = 0; index < percent.length; index += 1) {
        if (percent[index] === '%') {
            octets.push(parseInt(percent.slice(index + 1, index + 3), 16));
            index += 2;
        } else {
            octets.push(percent.charCodeAt(index));
        }
    }
    return Buffer.from(octets).toString('utf8');
};

const octets = (value) => Buffer.byteLength(value, 'utf8');

// ---------------------------------------------------------------------------
// RFC 2047 encoded-words
// ---------------------------------------------------------------------------
describe('RFC 2047 encoded-words', () => {
    it('leaves a printable-ASCII header value byte-identical', () => {
        expect(needsEncoding('Quarterly report (Q3) - draft #2')).toBe(false);
        expect(encodeHeaderValue('Quarterly report (Q3) - draft #2')).toBe('Quarterly report (Q3) - draft #2');
    });

    it('encodes an overlong whitespace-free ASCII subject into foldable words without changing its decoded value', () => {
        const subject = 'A'.repeat(1000);
        const encoded = encodeHeaderValue(subject);
        const folded = foldHeader('Subject', encoded);

        expect(encoded).toMatch(/^=\?UTF-8\?B\?/);
        for (const line of folded.split('\r\n')) expect(octets(line)).toBeLessThanOrEqual(HARD_LINE_LIMIT);
        expect(decodeEncodedWords(unfold(folded))).toBe(`Subject: ${subject}`);
    });

    it('leaves an already-encoded caller value alone (it is pure ASCII)', () => {
        const preEncoded = '=?UTF-8?B?5pel?=';
        expect(encodeHeaderValue(preEncoded)).toBe(preEncoded);
    });

    it('emits base64 encoded-words no longer than the 75-character RFC 2047 ceiling', () => {
        const encoded = encodeEncodedWords('件名'.repeat(200));
        const words = encoded.split(' ');
        expect(words.length).toBeGreaterThan(1);
        for (const word of words) {
            expect(word.startsWith('=?UTF-8?B?')).toBe(true);
            expect(word.endsWith('?=')).toBe(true);
            expect(word.length).toBeLessThanOrEqual(75);
        }
    });

    it('never splits a multi-byte character across two encoded-words', () => {
        // 45 source octets per word divides evenly by 3-octet CJK but not by
        // the 4-octet emoji below, so both cases exercise a boundary.
        for (const glyph of ['漢', '😀']) {
            const encoded = encodeEncodedWords(glyph.repeat(120));
            for (const word of encoded.split(' ')) {
                const payload = word.slice('=?UTF-8?B?'.length, -2);
                const text = Buffer.from(payload, 'base64').toString('utf8');
                expect(text).not.toContain('�');
                expect([...text].every((character) => character === glyph)).toBe(true);
            }
            expect(decodeEncodedWords(encoded)).toBe(glyph.repeat(120));
        }
    });

    it('never splits a surrogate pair', () => {
        const astral = '𝔘𝔫𝔦𝔠𝔬𝔡𝔢'.repeat(20);
        expect(decodeEncodedWords(encodeEncodedWords(astral))).toBe(astral);
    });

    it('round-trips mixed ASCII and Unicode text exactly', () => {
        const mixed = 'Re: 会議 notes for 2026-08-20 — draft ✅';
        expect(decodeEncodedWords(encodeHeaderValue(mixed))).toBe(mixed);
    });

    it('keeps a wordless CJK subject inside both the 78-octet soft limit and the 998-octet hard limit once folded', () => {
        // The exact case the old code could not handle: no whitespace anywhere,
        // so foldHeader alone had no legal fold point and shipped one enormous
        // line. Encoding first turns it into space-separated encoded-words.
        const subject = '日本語'.repeat(400);
        const folded = foldHeader('Subject', encodeHeaderValue(subject));
        const lines = folded.split('\r\n');

        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) {
            expect(octets(line)).toBeLessThanOrEqual(SOFT_LINE_LIMIT);
            expect(octets(line)).toBeLessThanOrEqual(HARD_LINE_LIMIT);
        }
        expect(lines.slice(1).every((line) => line.startsWith(' '))).toBe(true);
        expect(decodeEncodedWords(unfold(folded))).toBe(`Subject: ${subject}`);
    });

    it('keeps a wordless emoji subject inside the limits too', () => {
        const subject = '😀'.repeat(300);
        const folded = foldHeader('Subject', encodeHeaderValue(subject));
        for (const line of folded.split('\r\n')) {
            expect(octets(line)).toBeLessThanOrEqual(SOFT_LINE_LIMIT);
        }
        expect(decodeEncodedWords(unfold(folded))).toBe(`Subject: ${subject}`);
    });
});

// ---------------------------------------------------------------------------
// Address display names
// ---------------------------------------------------------------------------
describe('address display names', () => {
    it('encodes the display name and never touches the addr-spec', () => {
        const encoded = encodeDisplayName('Éloïse Müller <eloise@example.com>');
        expect(encoded.endsWith(' <eloise@example.com>')).toBe(true);
        expect(encoded).toMatch(/^=\?UTF-8\?B\?/);
        expect(decodeEncodedWords(encoded)).toBe('Éloïse Müller <eloise@example.com>');
    });

    it('leaves an ASCII display name unchanged', () => {
        expect(encodeDisplayName('Alice Smith <alice@example.com>')).toBe('Alice Smith <alice@example.com>');
    });

    it('leaves a bare addr-spec unchanged, encoded or not', () => {
        expect(encodeDisplayName('alice@example.com')).toBe('alice@example.com');
        // An internationalized addr-spec must NOT become an encoded-word:
        // RFC 2047 §5 forbids encoded-words inside an addr-spec.
        expect(encodeDisplayName('日本@example.com')).toBe('日本@example.com');
    });

    it('passes unsupported RFC 5322 shapes through unchanged rather than corrupting them', () => {
        const group = 'Team: alice@example.com, bob@example.com;';
        expect(encodeDisplayName(group)).toBe(group);
        const quotedWithBracket = '"Wei <the boss>" <wei@example.com>';
        expect(encodeDisplayName(quotedWithBracket)).toBe(quotedWithBracket);
        expect(encodeDisplayName('<alice@example.com>')).toBe('<alice@example.com>');
    });

    it('strips a quoted-string wrapper before encoding, so the quotes are not in the decoded name', () => {
        const encoded = encodeDisplayName('"Ünal, Ayşe" <ayse@example.com>');
        expect(decodeEncodedWords(encoded)).toBe('Ünal, Ayşe <ayse@example.com>');
    });

    it('joins an address list with ", " and drops blank entries', () => {
        expect(encodeAddressList(['a@x.com', '', 'B <b@x.com>'])).toBe('a@x.com, B <b@x.com>');
    });
});

// ---------------------------------------------------------------------------
// Media type validation
// ---------------------------------------------------------------------------
describe('mimeType validation', () => {
    it('accepts well-formed RFC 2045 media types', () => {
        expect(validateMimeType('text/plain')).toBe('text/plain');
        expect(validateMimeType('application/pdf')).toBe('application/pdf');
        expect(validateMimeType(' application/vnd.ms-excel ')).toBe('application/vnd.ms-excel');
    });

    it('rejects a header-injection payload smuggled through mimeType', () => {
        expect(() => validateMimeType('text/plain\r\nBcc: attacker@example.com')).toThrow();
        expect(() => validateMimeType('text/plain\nX-Evil: 1')).toThrow();
    });

    it('rejects empty and non-token values', () => {
        for (const bad of ['', '   ', 'text', 'text/', '/plain', 'text/plain; name="x"', 'text plain', undefined, null]) {
            expect(() => validateMimeType(bad)).toThrow();
        }
    });

    it('throws a public error whose fixed message never echoes the rejected value', () => {
        let thrown;
        try {
            validateMimeType('text/plain\r\nBcc: attacker@example.com');
        } catch (error) {
            thrown = error;
        }
        expect(isPublicError(thrown)).toBe(true);
        const message = getPublicErrorMessage(thrown);
        expect(message).not.toContain('attacker@example.com');
        expect(message).not.toContain('\r');
        expect(message).toContain('RFC 2045');
    });

    it('rejects attachment payloads that are not valid base64', () => {
        expect(() => normalizeBase64('not!!valid$$')).toThrow();
        expect(isPublicError((() => { try { normalizeBase64('%%%'); } catch (e) { return e; } })())).toBe(true);
    });

    it('accepts base64url and whitespace-wrapped base64, normalizing both', () => {
        expect(normalizeBase64('--__')).toBe('++//');
        expect(normalizeBase64('QUJD\r\nREVG')).toBe('QUJDREVG');
    });

    it('restores omitted base64url padding and preserves the original attachment bytes', () => {
        for (const bytes of [Buffer.from([1]), Buffer.from([1, 2])]) {
            const unpadded = bytes.toString('base64url');
            const normalized = normalizeBase64(unpadded);
            expect(normalized).toBe(bytes.toString('base64'));
            expect(Buffer.from(normalized, 'base64').equals(bytes)).toBe(true);
        }
    });

    it('rejects impossible base64 quantum lengths without exposing caller data', () => {
        for (const invalid of ['A', 'A=']) {
            let thrown;
            try { normalizeBase64(invalid); } catch (error) { thrown = error; }
            expect(isPublicError(thrown)).toBe(true);
            expect(getPublicErrorMessage(thrown)).not.toContain(invalid);
        }
    });

    it('leaves valid already-padded base64 byte-identical', () => {
        expect(normalizeBase64('AQI=')).toBe('AQI=');
    });
});

describe('header folding', () => {
    it('preserves a multi-space run exactly when folding before it', () => {
        const value = `${'A'.repeat(65)}${' '.repeat(5)}${'B'.repeat(10)}`;
        const folded = foldHeader('Subject', value);

        expect(folded).toBe(`Subject: ${'A'.repeat(65)}\r\n${' '.repeat(5)}${'B'.repeat(10)}`);
        expect(unfold(folded)).toBe(`Subject: ${value}`);
    });

    it('keeps a long whitespace run with its following token out of a blank physical line', async () => {
        const subject = `abc${' '.repeat(100)}def`;
        const folded = foldHeader('Subject', subject);
        const raw = await constructRawMessage(null, { to: ['a@b.com'], subject, body: 'body' });
        const { headerBlock, body } = splitMessage(raw);

        expect(folded.split('\r\n')).not.toContain('');
        expect(unfold(folded)).toBe(`Subject: ${subject}`);
        expect(unfold(logicalHeader(headerBlock, 'Subject'))).toBe(`Subject: ${subject}`);
        expect(headerBlock).toContain('Content-Type: text/plain; charset="UTF-8"');
        expect(headerBlock).toContain('Content-Transfer-Encoding: quoted-printable');
        expect(headerBlock).toContain('MIME-Version: 1.0');
        expect(body).toBe('body');
    });

    it('keeps adversarial whitespace and encoded unbreakable values fold-safe', () => {
        const values = [
            ' leading whitespace',
            'trailing whitespace ',
            ...[1, 2, 78, 100, 999].map((count) => `left${' '.repeat(count)}right`),
            'left\t\tright',
            '\t'.repeat(100),
            ' '.repeat(999),
            'A'.repeat(1200),
            'A'.repeat(SOFT_LINE_LIMIT - octets('Subject: ')),
        ];

        for (const value of values) {
            const encoded = encodeHeaderValue(value);
            const folded = foldHeader('Subject', encoded);

            for (const line of folded.split('\r\n')) {
                expect(line).not.toBe('');
                expect(octets(line)).toBeLessThanOrEqual(HARD_LINE_LIMIT);
            }
            expect(unfold(folded)).toBe(`Subject: ${encoded}`);
            expect(decodeEncodedWords(unfold(folded))).toBe(`Subject: ${value}`);
        }
    });
});

// ---------------------------------------------------------------------------
// RFC 2231 parameters
// ---------------------------------------------------------------------------
describe('RFC 2231 / RFC 6266 parameters', () => {
    it('emits only the quoted form for a short, plain ASCII filename', () => {
        expect(encodeParameter('filename', 'report.pdf')).toEqual(['filename="report.pdf"']);
        expect(buildContentTypeHeader('application/pdf', 'report.pdf'))
            .toBe('Content-Type: application/pdf; name="report.pdf"');
        expect(buildContentDispositionHeader('attachment', 'report.pdf'))
            .toBe('Content-Disposition: attachment; filename="report.pdf"');
    });

    it('emits filename* for a Unicode filename and round-trips it exactly', () => {
        const filename = '添付_Q3_✅.pdf';
        const header = buildContentDispositionHeader('attachment', filename);
        expect(header).toContain("filename*=UTF-8''");
        expect(decodeParameterValue(header, 'filename')).toBe(filename);
        // The legacy quoted fallback is still there for pre-2231 clients.
        expect(unfold(header)).toMatch(/filename="[^"]*"/);
    });

    it('splits a long filename into numbered continuations, none of which blows a line limit', () => {
        const filename = `${'très-long-nom-de-fichier-'.repeat(12)}final.pdf`;
        const header = buildContentDispositionHeader('attachment', filename);
        expect(header).toContain("filename*0*=UTF-8''");
        expect(header).toContain('filename*1*=');
        for (const line of header.split('\r\n')) {
            expect(octets(line)).toBeLessThanOrEqual(SOFT_LINE_LIMIT);
            expect(octets(line)).toBeLessThanOrEqual(HARD_LINE_LIMIT);
        }
        expect(decodeParameterValue(header, 'filename')).toBe(filename);
    });

    it('never splits a percent triplet across two continuations', () => {
        const header = buildContentDispositionHeader('attachment', '報告書'.repeat(40) + '.pdf');
        for (const match of unfold(header).matchAll(/filename\*\d+\*=(?:UTF-8'')?([^;\r\n]*)/g)) {
            // A section that ended mid-triplet would leave a trailing '%' or
            // '%X', or start with an orphaned hex pair.
            expect(match[1]).not.toMatch(/%[0-9A-F]?$/);
            expect((match[1].match(/%/g) || []).length * 3).toBeLessThanOrEqual(match[1].length + 2);
        }
        expect(decodeParameterValue(header, 'filename')).toBe('報告書'.repeat(40) + '.pdf');
    });

    it('neutralizes quotes, backslashes, CR and LF in the ASCII fallback', () => {
        const fallback = asciiFallbackParameter('evil"name\\with\r\nbreaks.pdf');
        expect(fallback).not.toContain('\r');
        expect(fallback).not.toContain('\n');
        expect(fallback).toContain('\\"');
        expect(fallback).toContain('\\\\');
    });

    it('caps the ASCII fallback while preserving the extension, so it can never be an over-length token', () => {
        const fallback = asciiFallbackParameter(`${'a'.repeat(400)}.pdf`);
        expect(fallback.length).toBeLessThanOrEqual(64);
        expect(fallback.endsWith('.pdf')).toBe(true);
    });

    it('falls back to a usable name when the whole filename sanitizes away', () => {
        expect(asciiFallbackParameter('\r\n')).toBe('attachment');
    });

    it('header injection through a filename produces no new header (issue #54 regression)', () => {
        const filename = 'evil"\r\nBcc: attacker@example.com.pdf';
        const contentType = buildContentTypeHeader('application/pdf', filename);
        const disposition = buildContentDispositionHeader('attachment', filename);
        for (const header of [contentType, disposition]) {
            // Any CRLF that survives must be a fold (CRLF + WSP), never the
            // start of a new header field.
            for (const line of header.split('\r\n').slice(1)) {
                expect(/^[ \t]/.test(line)).toBe(true);
            }
            expect(unfold(header)).not.toMatch(/\r|\n/);
            expect(unfold(header).toLowerCase()).not.toMatch(/(^|\r\n)bcc:/);
        }
        // And the real filename still survives intact in the extended form, CRLF
        // and all — percent-encoded as %0D%0A, so it can never be a line break
        // on the wire but still decodes back to exactly what the caller passed.
        expect(unfold(disposition)).toContain('%0D%0A');
        expect(decodeParameterValue(disposition, 'filename')).toBe(filename);
    });
});

// ---------------------------------------------------------------------------
// Quoted-printable
// ---------------------------------------------------------------------------
describe('quoted-printable bodies', () => {
    it('escapes 8-bit octets, "=", control bytes, and trailing whitespace', () => {
        expect(qpEncodeBody('héllo')).toBe('h=C3=A9llo');
        expect(qpEncodeBody('a = b')).toBe('a =3D b');
        expect(qpEncodeBody('trailing space ')).toBe('trailing space=20');
        expect(qpEncodeBody('trailing tab\t')).toBe('trailing tab=09');
        expect(qpEncodeBody('bellhere')).toBe('bell=07here');
    });

    it('normalizes CR-only and CRLF input to CRLF hard breaks', () => {
        expect(qpEncodeBody('a\rb')).toBe('a\r\nb');
        expect(qpEncodeBody('a\r\nb')).toBe('a\r\nb');
        expect(qpEncodeBody('a\nb')).toBe('a\r\nb');
    });

    it('preserves empty lines', () => {
        expect(qpEncodeBody('one\n\ntwo')).toBe('one\r\n\r\ntwo');
    });

    it('keeps every physical line within 76 characters counting the soft-break "="', () => {
        const body = `${'x'.repeat(500)}\n${'é'.repeat(300)}\n${'='.repeat(120)}`;
        for (const line of qpEncodeBody(body).split('\r\n')) {
            expect(line.length).toBeLessThanOrEqual(76);
        }
    });

    it('never ends a physical line with unescaped whitespace', () => {
        const body = `${'word '.repeat(60)}end`;
        for (const line of qpEncodeBody(body).split('\r\n')) {
            expect(/[ \t]$/.test(line.replace(/=$/, ''))).toBe(false);
        }
    });

    it('decodes byte-identically for text and HTML bodies', () => {
        const cases = [
            'Plain ASCII body.',
            'héllo wörld — em dash, ✅ emoji, 日本語',
            'a = b; c == d',
            `${'long line without any spaces '.repeat(20)}`,
            '<p>HTML <b>bödy</b> with a very long attribute string ' + 'z'.repeat(300) + '</p>',
            'trailing space \nand a tab\t\nplus a blank line\n\ndone',
        ];
        for (const source of cases) {
            expect(qpDecode(qpEncodeBody(source))).toBe(source.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'));
        }
    });
});

// ---------------------------------------------------------------------------
// Base64 wrapping and boundaries
// ---------------------------------------------------------------------------
describe('base64 wrapping', () => {
    it('wraps at 76 characters per RFC 2045 §6.8', () => {
        const data = Buffer.from('x'.repeat(1000)).toString('base64');
        const wrapped = wrapBase64(data);
        const lines = wrapped.split('\r\n');
        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) expect(line.length).toBeLessThanOrEqual(76);
        expect(lines.join('')).toBe(data);
    });

    it('returns an empty string for empty input', () => {
        expect(wrapBase64('')).toBe('');
    });
});

describe('multipart boundaries', () => {
    it('is deterministic for the same content', () => {
        expect(makeBoundary(['a', 'b'])).toBe(makeBoundary(['a', 'b']));
        expect(makeBoundary(['a', 'b'])).not.toBe(makeBoundary(['a', 'c']));
    });

    it('is valid RFC 2046 boundary syntax and under the 70-character maximum', () => {
        const boundary = makeBoundary(['payload']);
        expect(boundary.length).toBeLessThanOrEqual(70);
        expect(boundary).toMatch(/^[0-9A-Za-z'()+_,\-./:=? ]*[^ ]$/);
    });

    // The bump loop cannot be forced directly: the candidate is a hash of the
    // very content it is checked against, so there is no input that provably
    // contains its own first candidate. What is testable, and what RFC 2046
    // §5.1.1 actually requires, is the invariant — assert it over content
    // deliberately built to look like a boundary, including a previously
    // returned boundary fed straight back in.
    it('never occurs inside the content it delimits', () => {
        const seed = makeBoundary(['payload']);
        const digest = createHash('sha256').update('payload', 'utf8').digest('hex').slice(0, 32);
        const adversarial = [
            ['payload', seed],
            ['----=_Part_', `----=_Part_${digest}`, `----=_Part_${digest}_1`],
            [seed, seed, seed],
            ['--', '='.repeat(200)],
        ];
        for (const contents of adversarial) {
            const boundary = makeBoundary(contents);
            expect(contents.some((entry) => entry.includes(boundary))).toBe(false);
        }
    });

    it('assembleMultipart never emits a delimiter that appears in a part', () => {
        const raw = assembleMultipart(['To: a@b.com'], '----=_Part_ looks like a boundary', false, []);
        const boundary = raw.match(/boundary="([^"]+)"/)[1];
        const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
        const delimiterCount = body.split(`--${boundary}`).length - 1;
        // Exactly two: the opening delimiter for the single body part and the
        // closing delimiter. Nothing in the content collides with either.
        expect(delimiterCount).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// Builders — byte-level output
// ---------------------------------------------------------------------------
describe('constructRawMessage', () => {
    it('keeps an ASCII-only message byte-compatible apart from the quoted-printable body fix', async () => {
        const raw = await constructRawMessage(null, {
            to: ['alice@example.com'],
            subject: 'Hello',
            body: 'Hi there',
        });
        expect(Buffer.from(raw, 'base64url').toString('utf8')).toBe([
            'To: alice@example.com',
            'Subject: Hello',
            'Content-Type: text/plain; charset="UTF-8"',
            'Content-Transfer-Encoding: quoted-printable',
            'MIME-Version: 1.0',
            '',
            'Hi there',
        ].join('\r\n'));
    });

    it('declares a transfer encoding that matches the actual encoding (the body is really quoted-printable)', async () => {
        const body = 'Coût = 12 €\nligne deux avec un espace final \n';
        const raw = await constructRawMessage(null, { to: ['a@b.com'], subject: 'S', body });
        const { headerBlock, body: wireBody } = splitMessage(raw);
        expect(headerBlock).toContain('Content-Transfer-Encoding: quoted-printable');
        expect(wireBody).toContain('=C3=BB');
        expect(wireBody).toContain('=3D');
        expect(qpDecode(wireBody)).toBe(body.replace(/\n/g, '\r\n'));
    });

    it('encodes an HTML body as quoted-printable too, not raw 8-bit', async () => {
        const body = '<p>Bönjour — <b>gras</b></p>';
        const raw = await constructRawMessage(null, { to: ['a@b.com'], subject: 'S', body });
        const { headerBlock, body: wireBody } = splitMessage(raw);
        expect(headerBlock).toContain('Content-Type: text/html; charset="UTF-8"');
        expect(headerBlock).toContain('Content-Transfer-Encoding: quoted-printable');
        expect(wireBody).not.toContain('ö');
        expect(qpDecode(wireBody)).toBe(body);
    });

    it('holds every composed header line to 78 octets soft / 998 hard for a long CJK subject and Unicode recipients', async () => {
        const subject = '重要なお知らせ'.repeat(60);
        const to = Array.from({ length: 6 }, (_, index) => `受信者${index} <recipient-${index}@example-domain.com>`);
        const raw = await constructRawMessage(null, { to, subject, body: 'body' });
        const { headerBlock } = splitMessage(raw);

        for (const line of headerBlock.split('\r\n')) {
            expect(octets(line)).toBeLessThanOrEqual(SOFT_LINE_LIMIT);
            expect(octets(line)).toBeLessThanOrEqual(HARD_LINE_LIMIT);
        }
        expect(decodeEncodedWords(unfold(logicalHeader(headerBlock, 'Subject')))).toBe(`Subject: ${subject}`);
        expect(decodeEncodedWords(unfold(logicalHeader(headerBlock, 'To')))).toBe(`To: ${to.join(', ')}`);
    });

    it('never lets a subject introduce a new header field', async () => {
        const raw = await constructRawMessage(null, {
            to: ['a@b.com'],
            subject: 'ok\r\nBcc: attacker@example.com',
            body: 'x',
        });
        const { headerBlock } = splitMessage(raw);
        expect(headerBlock.toLowerCase()).not.toContain('bcc:');
    });
});

describe('constructRawMessageWithAttachments', () => {
    const attachment = {
        filename: '四半期レポート.pdf',
        mimeType: 'application/pdf',
        base64Data: Buffer.from('x'.repeat(400)).toString('base64'),
    };

    it('produces a well-formed multipart message with wrapped base64 and encoded filenames', async () => {
        const raw = await constructRawMessageWithAttachments(null, {
            to: ['Éloïse <eloise@example.com>'],
            subject: '添付ファイル',
            body: 'See attached',
            attachments: [attachment],
        });
        const { decoded, headerBlock } = splitMessage(raw);
        const boundary = headerBlock.match(/boundary="([^"]+)"/)[1];

        // Every physical line is legal, including the part headers.
        for (const line of decoded.split('\r\n')) {
            expect(octets(line)).toBeLessThanOrEqual(HARD_LINE_LIMIT);
        }

        const parts = decoded.split(`--${boundary}`);
        expect(parts).toHaveLength(4); // preamble, body part, attachment part, closing "--"
        const attachmentPart = parts[2];
        expect(decodeParameterValue(attachmentPart, 'filename')).toBe(attachment.filename);
        expect(decodeParameterValue(attachmentPart, 'name')).toBe(attachment.filename);

        // Payload is base64-wrapped at 76, not one unbroken line.
        const payload = attachmentPart.split('\r\n\r\n')[1].trim();
        const payloadLines = payload.split('\r\n');
        expect(payloadLines.length).toBeGreaterThan(1);
        for (const line of payloadLines) expect(line.length).toBeLessThanOrEqual(76);
        expect(Buffer.from(payloadLines.join(''), 'base64').toString('utf8')).toBe('x'.repeat(400));
    });

    it('wraps the multipart body part at 76 as well', async () => {
        const raw = await constructRawMessageWithAttachments(null, {
            to: ['a@b.com'],
            subject: 'S',
            body: 'y'.repeat(1000),
            attachments: [attachment],
        });
        const { decoded, headerBlock } = splitMessage(raw);
        const boundary = headerBlock.match(/boundary="([^"]+)"/)[1];
        const bodyPart = decoded.split(`--${boundary}`)[1];
        const payload = bodyPart.split('\r\n\r\n')[1].trim();
        expect(payload.split('\r\n').length).toBeGreaterThan(1);
        for (const line of payload.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
        expect(Buffer.from(payload.split('\r\n').join(''), 'base64').toString('utf8')).toBe('y'.repeat(1000));
    });

    it('rejects a mimeType carrying a header-injection payload before anything is sent', async () => {
        await expect(constructRawMessageWithAttachments(null, {
            to: ['a@b.com'],
            subject: 'S',
            body: 'b',
            attachments: [{ ...attachment, mimeType: 'application/pdf\r\nBcc: attacker@example.com' }],
        })).rejects.toThrow();
    });

    it('produces no extra header field for an injected filename', async () => {
        const raw = await constructRawMessageWithAttachments(null, {
            to: ['a@b.com'],
            subject: 'S',
            body: 'b',
            attachments: [{ ...attachment, filename: 'evil"\r\nBcc: attacker@example.com.pdf' }],
        });
        const decoded = Buffer.from(raw, 'base64url').toString('utf8');
        for (const line of decoded.split('\r\n')) {
            expect(line.toLowerCase().startsWith('bcc:')).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// assembleSinglePart / assembleMultipart (shared by reply and forward)
// ---------------------------------------------------------------------------
describe('shared assemblers', () => {
    it('assembleSinglePart emits headers, a blank line, and a quoted-printable body', () => {
        expect(assembleSinglePart(['To: a@b.com'], 'héllo', false)).toBe([
            'To: a@b.com',
            'Content-Type: text/plain; charset="UTF-8"',
            'Content-Transfer-Encoding: quoted-printable',
            'MIME-Version: 1.0',
            '',
            'h=C3=A9llo',
        ].join('\r\n'));
    });

    it('toBase64Url round-trips the raw message', () => {
        const raw = assembleSinglePart(['To: a@b.com'], 'body', false);
        expect(Buffer.from(toBase64Url(raw), 'base64url').toString('utf8')).toBe(raw);
        expect(toBase64Url(raw)).not.toMatch(/[+/=]/);
    });
});

// ---------------------------------------------------------------------------
// Tool-execution tests: the raw payload each of the four surfaces actually
// sends through the Gmail client.
// ---------------------------------------------------------------------------
const sent = [];

jest.unstable_mockModule('../dist/clients.js', () => ({
    getGmailClient: async () => gmailStub,
}));

// Deliberately chosen so its base64 contains '+' and '/', which become '-' and
// '_' in the base64url Gmail hands back — the normalization the forward path
// must undo before re-attaching.
const ORIGINAL_ATTACHMENT_BYTES = Buffer.from(Array.from({ length: 300 }, (_, index) => (index * 7) % 256));

const ORIGINAL_MESSAGE = {
    id: 'msg-1',
    threadId: 'thread-1',
    payload: {
        mimeType: 'multipart/mixed',
        headers: [
            { name: 'From', value: 'Sénder Ünicode <sender@example.com>' },
            { name: 'To', value: 'me@example.com' },
            { name: 'Subject', value: '会議のご案内' },
            { name: 'Date', value: 'Mon, 1 Jan 2024 00:00:00 +0000' },
            { name: 'Message-ID', value: '<original@example.com>' },
        ],
        parts: [
            { mimeType: 'text/plain', body: { data: Buffer.from('original bödy').toString('base64') } },
            {
                mimeType: 'application/pdf',
                filename: '添付.pdf',
                body: { attachmentId: 'att-1' },
            },
        ],
    },
};

const gmailStub = {
    users: {
        getProfile: async () => ({ data: { emailAddress: 'me@example.com' } }),
        messages: {
            get: async () => ({ data: JSON.parse(JSON.stringify(ORIGINAL_MESSAGE)) }),
            send: async (request) => {
                sent.push(request);
                return { data: { id: 'sent-1' } };
            },
            attachments: {
                get: async () => ({ data: { data: ORIGINAL_ATTACHMENT_BYTES.toString('base64url') } }),
            },
        },
        drafts: {
            create: async (request) => {
                sent.push(request);
                return { data: { id: 'draft-1' } };
            },
            update: async (request) => {
                sent.push(request);
                return { data: { id: 'draft-1' } };
            },
        },
        threads: {
            get: async () => ({ data: { messages: [] } }),
        },
    },
};

const createMockServer = () => {
    const tools = new Map();
    return {
        addTool(tool) { tools.set(tool.name, tool); },
        getTools() { return tools; },
    };
};

let tools;

beforeAll(async () => {
    const server = createMockServer();
    const messages = await import('../dist/tools/gmail/messages.js');
    const drafts = await import('../dist/tools/gmail/drafts.js');
    messages.register(server);
    drafts.register(server);
    tools = server.getTools();
});

const lastRaw = () => {
    const request = sent[sent.length - 1];
    return request.requestBody.raw ?? request.requestBody.message.raw;
};

describe('tool execution: raw payload on the wire', () => {
    it('sendMessage encodes a Unicode subject and display name', async () => {
        await tools.get('sendMessage').execute({
            to: ['Éloïse <eloise@example.com>'],
            subject: '日本語'.repeat(200),
            body: 'body',
        });
        const { headerBlock } = splitMessage(lastRaw());
        for (const line of headerBlock.split('\r\n')) {
            expect(octets(line)).toBeLessThanOrEqual(SOFT_LINE_LIMIT);
        }
        expect(decodeEncodedWords(unfold(logicalHeader(headerBlock, 'Subject')))).toBe(`Subject: ${'日本語'.repeat(200)}`);
    });

    it('createDraft routes through the same encoder', async () => {
        await tools.get('createDraft').execute({
            to: ['Éloïse <eloise@example.com>'],
            subject: 'Bönjour',
            body: 'corps héllo',
        }, { log: { info() {} } });
        const { headerBlock, body } = splitMessage(lastRaw());
        expect(decodeEncodedWords(unfold(logicalHeader(headerBlock, 'Subject')))).toBe('Subject: Bönjour');
        expect(qpDecode(body)).toBe('corps héllo');
    });

    it('updateDraft routes through the same encoder', async () => {
        await tools.get('updateDraft').execute({
            id: 'draft-1',
            to: ['a@b.com'],
            subject: 'Ünicode',
            body: 'x',
        });
        const { headerBlock } = splitMessage(lastRaw());
        expect(decodeEncodedWords(unfold(logicalHeader(headerBlock, 'Subject')))).toBe('Subject: Ünicode');
    });

    it('replyMessage encodes the Re: subject, encodes the sender display name, and leaves the addr-spec and Message-ID alone', async () => {
        await tools.get('replyMessage').execute({ messageId: 'msg-1', body: 'réponse' });
        const { headerBlock, body } = splitMessage(lastRaw());

        expect(decodeEncodedWords(unfold(logicalHeader(headerBlock, 'Subject')))).toBe('Subject: Re: 会議のご案内');
        expect(decodeEncodedWords(unfold(logicalHeader(headerBlock, 'To')))).toBe('To: Sénder Ünicode <sender@example.com>');
        expect(logicalHeader(headerBlock, 'In-Reply-To')).toBe('In-Reply-To: <original@example.com>');
        expect(headerBlock).toContain('Content-Transfer-Encoding: quoted-printable');
        expect(qpDecode(body)).toContain('réponse');
        for (const line of headerBlock.split('\r\n')) {
            expect(octets(line)).toBeLessThanOrEqual(HARD_LINE_LIMIT);
        }
    });

    it('replyMessage encodes attachment filenames and wraps their base64', async () => {
        await tools.get('replyMessage').execute({
            messageId: 'msg-1',
            body: 'avec pièce jointe',
            attachments: [{
                filename: '請求書_2026_très_long_nom_de_fichier.pdf',
                mimeType: 'application/pdf',
                base64Data: Buffer.from('q'.repeat(500)).toString('base64'),
            }],
        });
        const { decoded, headerBlock } = splitMessage(lastRaw());
        const boundary = headerBlock.match(/boundary="([^"]+)"/)[1];
        const attachmentPart = decoded.split(`--${boundary}`)[2];
        expect(decodeParameterValue(attachmentPart, 'filename')).toBe('請求書_2026_très_long_nom_de_fichier.pdf');
        for (const line of decoded.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
    });

    it('replyMessage rejects an injected mimeType', async () => {
        await expect(tools.get('replyMessage').execute({
            messageId: 'msg-1',
            body: 'x',
            attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf\r\nBcc: e@x.com', base64Data: 'QQ==' }],
        })).rejects.toThrow();
    });

    it('forwardMessage encodes the Fwd: subject and re-attaches originals with wrapped base64', async () => {
        await tools.get('forwardMessage').execute({
            messageId: 'msg-1',
            to: ['Reçipient <r@example.com>'],
            body: 'FYI — voir ci-dessous',
        });
        const { decoded, headerBlock } = splitMessage(lastRaw());
        expect(decodeEncodedWords(unfold(logicalHeader(headerBlock, 'Subject')))).toBe('Subject: Fwd: 会議のご案内');
        expect(decodeEncodedWords(unfold(logicalHeader(headerBlock, 'To')))).toBe('To: Reçipient <r@example.com>');

        const boundary = headerBlock.match(/boundary="([^"]+)"/)[1];
        const attachmentPart = decoded.split(`--${boundary}`)[2];
        expect(decodeParameterValue(attachmentPart, 'filename')).toBe('添付.pdf');
        const payload = attachmentPart.split('\r\n\r\n')[1].trim();
        expect(payload.split('\r\n').length).toBeGreaterThan(1);
        for (const line of payload.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
        // The forwarded payload arrives from Gmail as base64url and must be
        // normalized to standard base64 before it goes back out.
        expect(ORIGINAL_ATTACHMENT_BYTES.toString('base64')).toMatch(/[+/]/); // the case actually exercised
        expect(payload).not.toMatch(/[-_]/);
        expect(Buffer.from(payload.split('\r\n').join(''), 'base64').equals(ORIGINAL_ATTACHMENT_BYTES)).toBe(true);
    });

    it('forwardMessage without attachments still declares quoted-printable truthfully', async () => {
        await tools.get('forwardMessage').execute({
            messageId: 'msg-1',
            to: ['r@example.com'],
            body: 'note',
            includeAttachments: false,
        });
        const { headerBlock, body } = splitMessage(lastRaw());
        expect(headerBlock).toContain('Content-Transfer-Encoding: quoted-printable');
        expect(qpDecode(body)).toContain('original bödy');
        expect(body).not.toContain('ö');
    });
});
