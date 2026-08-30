// Encoding-aware MIME/RFC 5322 construction layer for the Gmail message
// builders (issue #73, which subsumes #54).
//
// Everything that turns caller-supplied text into wire bytes lives here so the
// rules are stated once instead of re-derived at each call site. The builders in
// dist/helpers.js and dist/tools/gmail/messages.js compose headers from these
// primitives and never interpolate a raw value into a header line again.
//
// RFCs implemented, by name so a reader can check the behavior against the text:
//   RFC 5322 §2.1.1, §2.2.3, §3.2.2  line limits and folding
//   RFC 2045 §5.1, §6.7, §6.8        media types, quoted-printable, base64
//   RFC 2046 §5.1.1                  multipart boundary syntax
//   RFC 2047 §2, §5                  encoded-words in header values
//   RFC 2231 §3, §4                  parameter continuations and charset
//   RFC 5987 / RFC 6266 §4.1, §4.3   attr-char set and the filename* pairing
import { createHash } from 'node:crypto';
import { publicError } from './errors.js';

// ---------------------------------------------------------------------------
// Line limits
// ---------------------------------------------------------------------------

// RFC 5322 §2.1.1: 78 octets is the recommended maximum for a line including
// CRLF; 998 is the hard maximum. Both are measured in OCTETS, not UTF-16 code
// units, and the raw message is serialized as UTF-8, so every measurement here
// goes through Buffer.byteLength.
export const SOFT_LINE_LIMIT = 78;
export const HARD_LINE_LIMIT = 998;

const byteLen = (str) => Buffer.byteLength(str, 'utf8');

// Folding (a CRLF followed by WSP) is only legal at a point where folding
// white space is already allowed (RFC 5322 §2.2.3, §3.2.2). A run of
// characters with no internal whitespace has no such point: a message-id
// atom "does not have internal CFWS anywhere in the message identifier"
// (§3.6.4), an address atom is likewise unbreakable, and an RFC 2047
// encoded-word's encoded-text "MUST NOT be continued from one encoded-word
// to another" (RFC 2047 §2). Even for a plain unstructured run (e.g. a CJK
// or emoji subject with no spaces), inserting a fold is not safe: §2.2.3
// defines unfolding as "simply removing any CRLF that is immediately
// followed by WSP" - the CRLF is removed, but the WSP is NOT, so an
// injected fold leaves a permanent extra space in the decoded value that
// was never in the original. The only RFC-safe behavior for a wordless,
// over-length token is to leave it unfolded on its own line, even if that
// line then exceeds the 998-octet hard limit: an overlong line is a
// robustness concern (§2.1.1, "Individual implementations MAY choose to
// include higher limits"), whereas splitting the token would corrupt a
// structured value (breaking Message-ID/References matching, or DKIM
// signatures over the raw header bytes) or silently change an unstructured
// one.
//
// That is why this folder is the LAST stage, never the only stage: values
// composed from user text are first turned into foldable tokens by
// encodeHeaderValue / encodeParameter above, so the wordless-run escape hatch
// only ever applies to protocol atoms this server copies verbatim.
//
// Moved here from dist/helpers.js unchanged (issue #73). helpers.js re-exports
// it so every existing importer and test keeps working.
export const foldHeader = (name, value) => {
    const prefix = `${name}: `;
    const normalizedValue = String(value).replace(/(?:\r\n?|\n)[ \t]*/g, ' ');
    const unfolded = prefix + normalizedValue;
    if (byteLen(unfolded) <= SOFT_LINE_LIMIT) return unfolded;

    const lines = [];
    let line = prefix;
    const segments = normalizedValue.match(/\S+|[ \t]+/g) || [];
    for (const segment of segments) {
        if (/^[ \t]+$/.test(segment)) {
            // Fold BEFORE existing whitespace, never by dropping it. RFC 5322
            // unfolding removes CRLF but retains WSP, so this preserves every
            // byte of a caller's whitespace run.
            if (line !== prefix
                && byteLen(segment) <= SOFT_LINE_LIMIT
                && byteLen(line) + byteLen(segment) > SOFT_LINE_LIMIT) {
                lines.push(line);
                line = segment;
            } else if (byteLen(line) + byteLen(segment) > SOFT_LINE_LIMIT) {
                // A whitespace run may itself be wider than a physical line.
                // Split it only at its own existing WSP bytes. This is still a
                // legal fold and means the next token never has to move an
                // all-whitespace line into an empty physical line.
                let remaining = segment;
                while (remaining) {
                    const capacity = SOFT_LINE_LIMIT - byteLen(line);
                    if (capacity === 0) {
                        lines.push(line);
                        line = '';
                        continue;
                    }
                    const chunk = remaining.slice(0, capacity);
                    line += chunk;
                    remaining = remaining.slice(chunk.length);
                }
            } else {
                line += segment;
            }
            continue;
        }

        if (line !== prefix && byteLen(line) + byteLen(segment) > SOFT_LINE_LIMIT) {
            const whitespace = line.match(/[ \t]+$/)?.[0];
            if (whitespace) {
                // The word does not fit after whitespace that did. Move that
                // same whitespace to the continuation rather than replacing
                // it with one generated space.
                const beforeWhitespace = line.slice(0, -whitespace.length);
                if (beforeWhitespace) {
                    lines.push(beforeWhitespace);
                    line = whitespace;
                } else if (line.length > 1) {
                    // The line is entirely an existing whitespace run. Keep
                    // one byte with the token so its continuation is nonempty,
                    // and emit the rest as its own legal whitespace line.
                    lines.push(line.slice(0, -1));
                    line = line.slice(-1);
                }
            } else {
                lines.push(line);
                line = ' ';
            }
        }
        // A single word that is itself over-length is never split here. Values
        // composed from unstructured user text are encoded into fixed-size RFC
        // 2047 words by encodeHeaderValue before reaching this last stage.
        line += segment;
    }
    lines.push(line);
    return lines.join('\r\n');
};

// ---------------------------------------------------------------------------
// RFC 2047 encoded-words
// ---------------------------------------------------------------------------

/**
 * True when a header value cannot ride the wire as literal bytes: anything
 * outside printable US-ASCII (RFC 5322 header field values are US-ASCII only,
 * §2.2), which covers control characters, CR/LF, and every non-ASCII octet.
 * Pure printable-ASCII values are deliberately left byte-identical so an
 * ASCII-only message is unchanged by this layer.
 */
export const needsEncoding = (value) => /[^\x20-\x7E]/.test(String(value ?? ''));

// RFC 2047 §2 caps an encoded-word at 75 characters including charset,
// encoding, encoded-text, and delimiters. The fixed part here is "=?UTF-8?B?"
// (10) plus "?=" (2) = 12 characters, so 63 remain for the base64 text and, in
// whole 4-character quanta, 60 — 45 source octets.
//
// The tighter budget below is the RFC 5322 §2.1.1 soft limit, not RFC 2047: an
// encoded-word is an unbreakable token, so the FIRST one has to share its line
// with the field name. "Subject: " costs 9 characters, which leaves 69 for the
// word, hence 56 base64 characters and 42 source octets (a 68-character word,
// 77 with the field name). Sizing to 45 instead would put the first line at 81
// octets, over the recommendation, for every non-ASCII subject.
const ENCODED_WORD_PREFIX = '=?UTF-8?B?';
const ENCODED_WORD_SUFFIX = '?=';
const MAX_ENCODED_WORD_SOURCE_OCTETS = 42;

/**
 * Encode arbitrary text as a whitespace-separated run of base64 encoded-words.
 *
 * Chunk boundaries fall on whole Unicode code points (iteration is over code
 * points, so an astral character's surrogate pair is never split), which means
 * no encoded-word ever contains a truncated UTF-8 sequence — RFC 2047 §5 rule
 * 2 requires each encoded-word to be independently decodable.
 *
 * The separator is a single space, which is a legal FWS point, so foldHeader
 * can fold BETWEEN words without ever folding inside one. That is what turns a
 * wordless CJK or emoji subject (previously one unbreakable over-length token)
 * into a legally foldable header. RFC 2047 §6.2 requires a decoder to drop the
 * whitespace between two adjacent encoded-words, so the round trip is exact.
 */
export const encodeEncodedWords = (text) => {
    const source = String(text ?? '');
    const words = [];
    let chunk = [];
    let chunkOctets = 0;
    for (const codePoint of source) {
        const size = byteLen(codePoint);
        if (chunkOctets + size > MAX_ENCODED_WORD_SOURCE_OCTETS && chunk.length) {
            words.push(chunk.join(''));
            chunk = [];
            chunkOctets = 0;
        }
        chunk.push(codePoint);
        chunkOctets += size;
    }
    if (chunk.length) words.push(chunk.join(''));
    if (!words.length) return '';
    return words
        .map((word) => `${ENCODED_WORD_PREFIX}${Buffer.from(word, 'utf8').toString('base64')}${ENCODED_WORD_SUFFIX}`)
        .join(' ');
};

/**
 * Encode an unstructured header value (Subject and friends). Printable-ASCII
 * values pass through byte-for-byte; anything else becomes encoded-words.
 */
export const encodeHeaderValue = (value) => {
    const text = String(value ?? '');
    // Subject is the only current caller. Its nine-octet field prefix means a
    // literal word longer than 989 octets would violate RFC 5322's 998-octet
    // physical-line limit because foldHeader cannot split a word safely.
    const hasUnfoldableLongRun = (text.match(/\S+/g) || [])
        .some((run) => byteLen(run) > HARD_LINE_LIMIT - byteLen('Subject: '));
    return needsEncoding(text) || hasUnfoldableLongRun ? encodeEncodedWords(text) : text;
};

/**
 * Encode the display-name half of a single address, leaving the addr-spec
 * untouched.
 *
 * Deliberately bounded parsing, not an RFC 5322 address parser. Two shapes are
 * supported, both documented in the Gmail tool descriptions:
 *
 *   1. `Display Name <addr@spec>` — split on the LAST '<'
 *   2. bare `addr@spec`           — nothing to encode
 *
 * Everything else (a quoted display-name containing '<', groups, comments) is
 * returned unchanged. An addr-spec is never encoded: RFC 2047 §5 forbids
 * encoded-words inside an addr-spec, so encoding one would produce an
 * undeliverable address. Passing an unsupported shape through means it is
 * folded but never corrupted, which is the safe direction.
 */
export const encodeDisplayName = (address) => {
    const entry = String(address ?? '').trim();
    if (!entry.endsWith('>')) return entry;
    const split = entry.lastIndexOf('<');
    if (split <= 0) return entry;
    const name = entry.slice(0, split).trim();
    const addrSpec = entry.slice(split);
    if (!name || name.includes('<')) return entry;
    // Address headers may be To, Cc, or Bcc. Bcc has the longest field-name,
    // so use its prefix for the conservative hard-line budget. A display-name
    // run can be safely represented as RFC 2047 encoded-words; the addr-spec
    // cannot, and remains literal below.
    const hasUnfoldableLongRun = (name.match(/\S+/g) || [])
        .some((run) => byteLen(run) > HARD_LINE_LIMIT - byteLen('Bcc: '));
    if (!needsEncoding(name) && !hasUnfoldableLongRun) return entry;
    // Strip a surrounding quoted-string and its backslash escapes before
    // encoding: an encoded-word is an atom and must not itself be quoted
    // (RFC 2047 §5 rule 1 — encoded-words are not valid inside a
    // quoted-string), so the quotes would end up as literal characters in the
    // decoded name.
    const unquoted = /^"(.*)"$/s.test(name)
        ? name.slice(1, -1).replace(/\\(.)/g, '$1')
        : name;
    return `${encodeEncodedWords(unquoted)} ${addrSpec}`;
};

/** Encode every display-name in an address list and join it for one header. */
export const encodeAddressList = (addresses) =>
    (Array.isArray(addresses) ? addresses : [addresses])
        .filter((entry) => entry !== undefined && entry !== null && String(entry).trim() !== '')
        .map(encodeDisplayName)
        .join(', ');

// ---------------------------------------------------------------------------
// Media types
// ---------------------------------------------------------------------------

// RFC 2045 §5.1: type and subtype are `token`s — any US-ASCII character except
// SPACE, CTLs, and tspecials ()<>@,;:\"/[]?=
const MIME_TOKEN = String.raw`[A-Za-z0-9!#$%&'*+._^\`|~-]+`;
const MIME_TYPE_PATTERN = new RegExp(`^${MIME_TOKEN}/${MIME_TOKEN}$`);

/**
 * Validate a caller-supplied media type instead of escaping it.
 *
 * `mimeType` is a free-form string on the attachment schema and used to be
 * interpolated straight into a header line, which made a value like
 * "text/plain\r\nBcc: attacker@example.com" a header-injection vector. Escaping
 * would be the wrong fix: there is no legal media type that needs escaping, so
 * anything that fails the grammar is rejected at the boundary.
 *
 * The thrown message is a fixed template that never echoes the rejected value.
 */
export const validateMimeType = (mimeType) => {
    const value = String(mimeType ?? '').trim();
    if (!MIME_TYPE_PATTERN.test(value)) {
        throw publicError('Invalid attachment mimeType. It must be an RFC 2045 media type of the form "type/subtype", for example "application/pdf".');
    }
    return value;
};

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Normalize caller- or Gmail-supplied attachment payloads to standard base64.
 *
 * Gmail hands back base64url ('-' and '_'), callers commonly paste base64 with
 * embedded newlines, and both must become the plain alphabet before the part is
 * re-wrapped. Invalid data is rejected here rather than shipped to the API as a
 * corrupt attachment.
 */
export const normalizeBase64 = (data) => {
    const cleaned = String(data ?? '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!BASE64_PATTERN.test(cleaned)) {
        throw publicError('Invalid attachment base64Data. It must be base64 or base64url encoded content.');
    }
    const padding = cleaned.match(/=+$/)?.[0] || '';
    const payload = cleaned.slice(0, cleaned.length - padding.length);
    const remainder = payload.length % 4;
    // A base64 quantum can contain 0, 2, 3, or 4 data characters, never one.
    // Existing padding must agree with the final quantum; otherwise it is not
    // valid base64 even if its alphabet is valid.
    if (remainder === 1 || padding.length > 2
        || (padding.length && !((remainder === 2 && padding.length === 2) || (remainder === 3 && padding.length === 1)))) {
        throw publicError('Invalid attachment base64Data. It must be base64 or base64url encoded content.');
    }
    return padding ? cleaned : `${payload}${'='.repeat((4 - remainder) % 4)}`;
};

// ---------------------------------------------------------------------------
// RFC 2231 / RFC 5987 parameters (filenames and other MIME parameters)
// ---------------------------------------------------------------------------

// RFC 5987 §3.2.1 attr-char: ALPHA / DIGIT / "!" / "#" / "$" / "&" / "+" /
// "-" / "." / "^" / "_" / "`" / "|" / "~". Note that '*', '\'' and '%' are
// excluded from token for extended values, because they are the delimiters of
// the extended-value syntax itself.
const ATTR_CHAR = /^[A-Za-z0-9!#$&+.^_`|~-]$/;

// Each continuation section becomes its own header token, so the section value
// has to leave room for the fold space, the parameter name, the section index,
// and the "UTF-8''" charset prefix inside the 78-octet soft limit. 50 leaves
// comfortable headroom for a long parameter name.
const PARAMETER_SECTION_LENGTH = 50;

// A quoted ASCII parameter is kept small so it can never become an unbreakable
// over-length header token. It is only used for filenames that are already
// plain ASCII; non-ASCII values use the RFC 2231 form exclusively, because
// Gmail's draft parser can otherwise select this lossy fallback over filename*.
const MAX_FALLBACK_LENGTH = 64;

const percentEncode = (value) => {
    let out = '';
    for (const octet of Buffer.from(String(value), 'utf8')) {
        const char = String.fromCharCode(octet);
        out += ATTR_CHAR.test(char) ? char : `%${octet.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    return out;
};

/** Split a percent-encoded string without ever cutting a %XX triplet in half. */
const chunkPercentEncoded = (encoded, size) => {
    const chunks = [];
    let current = '';
    for (let index = 0; index < encoded.length;) {
        const atom = encoded[index] === '%' ? encoded.slice(index, index + 3) : encoded[index];
        if (current.length + atom.length > size) {
            chunks.push(current);
            current = '';
        }
        current += atom;
        index += atom.length;
    }
    if (current.length || !chunks.length) chunks.push(current);
    return chunks;
};

/**
 * Build the quoted ASCII fallback for a parameter value.
 *
 * CR and LF are removed outright (they are the injection vector, and there is
 * no escape for them inside a quoted-string), other control characters and
 * every non-ASCII octet collapse to '_', the value is capped with its extension
 * preserved, and only then are '"' and '\' backslash-escaped so a cap can never
 * land between a backslash and the character it escapes.
 */
export const asciiFallbackParameter = (value) => {
    let sanitized = String(value ?? '')
        .replace(/[\r\n]+/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1F\x7F]/g, '_')
        .replace(/[^\x20-\x7E]/g, '_')
        .trim();
    if (!sanitized) sanitized = 'attachment';
    if (sanitized.length > MAX_FALLBACK_LENGTH) {
        const dot = sanitized.lastIndexOf('.');
        const extension = dot > 0 && sanitized.length - dot <= 12 ? sanitized.slice(dot) : '';
        const base = extension ? sanitized.slice(0, dot) : sanitized;
        sanitized = base.slice(0, Math.max(1, MAX_FALLBACK_LENGTH - extension.length)) + extension;
    }
    return sanitized.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
};

/**
 * Encode one MIME parameter as the list of parameter strings it needs.
 *
 * A short, plain, printable-ASCII value produces just `name="value"` so ASCII
 * messages stay byte-compatible. Non-ASCII values use the RFC 2231 extended
 * form exclusively, split into `name*0*`, `name*1*`… continuations when the
 * encoded value is long enough that a single parameter would be an unbreakable
 * over-length token:
 *
 *   filename="report.pdf"; filename*0*=UTF-8''%E5%A0%B1%E5%91%8A; filename*1*=...
 *
 * Long plain-ASCII values use unencoded RFC 2231 continuations (`name*0=`,
 * `name*1=`) rather than percent-encoding bytes that do not need encoding.
 */
export const encodeParameter = (name, value) => {
    const raw = String(value ?? '');
    const fallback = asciiFallbackParameter(raw);
    const requiresExtended = needsEncoding(raw) || /[\x00-\x1F\x7F"\\]/.test(raw);
    const encoded = requiresExtended ? percentEncode(raw) : raw;
    const sections = chunkPercentEncoded(encoded, PARAMETER_SECTION_LENGTH);
    if (!requiresExtended && sections.length === 1) return [`${name}="${fallback}"`];
    const parameters = [];
    if (sections.length === 1) {
        parameters.push(`${name}*=UTF-8''${sections[0]}`);
    } else {
        sections.forEach((section, index) => {
            parameters.push(`${name}*${index}${requiresExtended ? '*' : ''}=${index === 0 && requiresExtended ? "UTF-8''" : ''}${section}`);
        });
    }
    return parameters;
};

/** `Content-Type: <type>; name="…"; name*=…`, validated and folded. */
export const buildContentTypeHeader = (mimeType, filename) => {
    const type = validateMimeType(mimeType);
    const parameters = filename === undefined || filename === null || filename === ''
        ? []
        : encodeParameter('name', filename);
    return foldHeader('Content-Type', [type, ...parameters].join('; '));
};

/** `Content-Disposition: attachment; filename="…"; filename*=…`, folded. */
export const buildContentDispositionHeader = (disposition, filename) => {
    const parameters = filename === undefined || filename === null || filename === ''
        ? []
        : encodeParameter('filename', filename);
    return foldHeader('Content-Disposition', [disposition, ...parameters].join('; '));
};

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

const escapeOctet = (octet) => `=${octet.toString(16).toUpperCase().padStart(2, '0')}`;

// A quoted-printable line may not exceed 76 characters INCLUDING the trailing
// soft-break '=' (RFC 2045 §6.7 rule 5). Packing stops at 73 so that escaping a
// trailing space or tab (rule 3: whitespace must not end an encoded line) can
// grow the line by two characters and still leave room for the '='.
const QP_PACK_LIMIT = 73;

// Rule 3 again, for the soft-break case: a physical line produced by a soft
// break must not end in whitespace either, or a transport that strips trailing
// whitespace silently deletes it.
const softBreakSafe = (line) => (
    /[ \t]$/.test(line)
        ? line.slice(0, -1) + escapeOctet(line.charCodeAt(line.length - 1))
        : line
);

/**
 * Real quoted-printable encoding (RFC 2045 §6.7).
 *
 * Single-part bodies have always declared `Content-Transfer-Encoding:
 * quoted-printable` while only inserting soft line breaks, so the declaration
 * was a lie for any body containing '=', an 8-bit octet, or trailing
 * whitespace. This implements the encoding the header claims:
 *
 *   - rule 1: every octet outside the literal range becomes =XX (uppercase hex)
 *   - rule 2: printable ASCII except '=' is literal
 *   - rule 3: a space or tab at the end of an encoded line is escaped
 *   - rule 4: input line breaks are normalized to CRLF hard breaks
 *   - rule 5: no line exceeds 76 characters counting the soft-break '='
 *
 * Applies to text and HTML alike — an HTML body is 8-bit text with exactly the
 * same problem.
 */
export const qpEncodeBody = (text) => {
    const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
    const output = [];
    for (const line of normalized.split('\n')) {
        const atoms = [];
        const octets = Buffer.from(line, 'utf8');
        for (let index = 0; index < octets.length; index += 1) {
            const octet = octets[index];
            const isLast = index === octets.length - 1;
            if (octet === 9 || octet === 32) {
                atoms.push(isLast ? escapeOctet(octet) : String.fromCharCode(octet));
            } else if (octet >= 33 && octet <= 126 && octet !== 61) {
                atoms.push(String.fromCharCode(octet));
            } else {
                atoms.push(escapeOctet(octet));
            }
        }
        let current = '';
        for (const atom of atoms) {
            if (current.length + atom.length > QP_PACK_LIMIT) {
                output.push(`${softBreakSafe(current)}=`);
                current = '';
            }
            current += atom;
        }
        output.push(current);
    }
    return output.join('\r\n');
};

/**
 * Wrap base64 at 76 characters per line (RFC 2045 §6.8: "the encoded output
 * stream must be represented in lines of no more than 76 characters each").
 * The previous builders emitted base64 as one unbroken line of arbitrary
 * length.
 */
export const wrapBase64 = (data, width = 76) => {
    const value = String(data ?? '');
    if (!value) return '';
    return (value.match(new RegExp(`.{1,${width}}`, 'g')) || []).join('\r\n');
};

// ---------------------------------------------------------------------------
// Multipart assembly
// ---------------------------------------------------------------------------

const BOUNDARY_PREFIX = '----=_Part_';

/**
 * Derive a multipart boundary that provably does not occur anywhere in the
 * content it delimits (RFC 2046 §5.1.1: "the boundary delimiter must not appear
 * inside any of the encapsulated parts").
 *
 * The previous `boundary_${Date.now()}_${Math.random()}` was neither: it is
 * short, guessable, non-deterministic (so it could not be asserted in a test),
 * and nothing ever checked it against the payload. This hashes the actual
 * content, then verifies non-occurrence and bumps a counter until it holds — so
 * collision is impossible rather than improbable, and the same message always
 * produces the same bytes.
 *
 * The alphabet ('-', '=', '_', hex) is a subset of RFC 2046 bchars, and the
 * length (44, or 46 with a disambiguating suffix) is under the 70-character
 * maximum.
 */
export const makeBoundary = (contents) => {
    const parts = (Array.isArray(contents) ? contents : [contents]).map((entry) => String(entry ?? ''));
    const digest = createHash('sha256').update(parts.join('\x00'), 'utf8').digest('hex').slice(0, 32);
    for (let attempt = 0; ; attempt += 1) {
        const candidate = `${BOUNDARY_PREFIX}${digest}${attempt ? `_${attempt}` : ''}`;
        if (!parts.some((entry) => entry.includes(candidate))) return candidate;
    }
};

/** Serialize the raw RFC 5322 message as the base64url string Gmail's `raw` field expects. */
export const toBase64Url = (rawMessage) => Buffer.from(String(rawMessage), 'utf8').toString('base64url');

/**
 * Assemble a single-part message from already-encoded, already-folded header
 * lines plus a body. The declared transfer encoding and the actual encoding
 * match, which they previously did not.
 */
export const assembleSinglePart = (headerLines, bodyText, htmlMode) => {
    const message = [...headerLines];
    message.push(`Content-Type: ${htmlMode ? 'text/html' : 'text/plain'}; charset="UTF-8"`);
    message.push('Content-Transfer-Encoding: quoted-printable');
    message.push('MIME-Version: 1.0');
    message.push('');
    message.push(qpEncodeBody(bodyText));
    return message.join('\r\n');
};

/**
 * Assemble a multipart/mixed message: a text or HTML body part plus one part
 * per attachment. Every attachment's media type is validated, every filename
 * goes through RFC 2231 encoding, and every base64 payload is wrapped at 76.
 */
export const assembleMultipart = (headerLines, bodyText, htmlMode, attachments) => {
    // RFC 2046 \u00a74.1.1 requires MIME text parts to use CRLF line endings
    // before transfer encoding. Base64 preserves every source byte verbatim,
    // so normalize before encoding rather than after decoding at the receiver.
    const canonicalBodyText = String(bodyText ?? '').replace(/(?:\r\n?|\n)/g, '\r\n');
    const bodyBase64 = Buffer.from(canonicalBodyText, 'utf8').toString('base64');
    const parsedAttachments = (attachments || []).map((attachment) => ({
        filename: attachment.filename,
        mimeType: validateMimeType(attachment.mimeType),
        data: normalizeBase64(attachment.base64Data),
    }));
    const boundary = makeBoundary([
        ...headerLines,
        canonicalBodyText,
        bodyBase64,
        ...parsedAttachments.map((attachment) => attachment.data),
        ...parsedAttachments.map((attachment) => String(attachment.filename ?? '')),
    ]);

    const parts = [[
        `--${boundary}`,
        `Content-Type: ${htmlMode ? 'text/html' : 'text/plain'}; charset="UTF-8"`,
        'Content-Transfer-Encoding: base64',
        '',
        wrapBase64(bodyBase64),
    ].join('\r\n')];

    for (const attachment of parsedAttachments) {
        parts.push([
            `--${boundary}`,
            buildContentTypeHeader(attachment.mimeType, attachment.filename),
            'Content-Transfer-Encoding: base64',
            buildContentDispositionHeader('attachment', attachment.filename),
            '',
            wrapBase64(attachment.data),
        ].join('\r\n'));
    }

    const head = [
        ...headerLines,
        'MIME-Version: 1.0',
        foldHeader('Content-Type', `multipart/mixed; boundary="${boundary}"`),
    ];
    return [head.join('\r\n'), '', parts.join('\r\n'), `--${boundary}--`].join('\r\n');
};
