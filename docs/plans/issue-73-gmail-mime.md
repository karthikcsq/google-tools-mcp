# Plan: standards-compliant Gmail MIME header generation (#73)

Issue: [#73](https://github.com/karthikcsq/google-tools-mcp/issues/73) (canonical for closed #54) · Verified against `main` @ 8640240.

## Root causes

The message builders assemble RFC 5322 headers by string interpolation, and only the *folding* half of the problem was ever fixed (PR #38). Verified current state:

1. **No RFC 2047 encoding exists anywhere.** Non-ASCII Subjects and display names are emitted as raw UTF-8 octets. The folder (`dist/helpers.js:169-194`) explicitly refuses to split unbreakable tokens, so a wordless CJK/emoji subject ships as a single line that can blow the 998-octet hard limit — there is even a test *asserting* that overflow (`tests/helpers.test.js:88-105`). The folder was built to safely handle already-encoded words (`helpers.js:141-165` cites RFC 2047 §2) but nothing ever *produces* them.
2. **Attachment headers bypass every safety layer.** `Content-Type: ${att.mimeType}; name="${att.filename}"` and `Content-Disposition: attachment; filename="${att.filename}"` are raw template literals in three places (`helpers.js:279-281`, `gmail/messages.js:137-139` reply, `:253-255` forward). No RFC 2047/2231 encoding, no quoting of `"` or `\`, no length folding, and — unlike every folded header — **no CR/LF stripping**, so a crafted filename is a header-injection vector.
3. **(Found in verification) The declared body encoding is a lie.** Single-part bodies declare `Content-Transfer-Encoding: quoted-printable` (`helpers.js:226`) but `wrapTextBody` (`:135-139`) only inserts soft breaks `=\n` — it never QP-escapes 8-bit octets or literal `=`, uses bare `\n` in a CRLF message, and chunks by UTF-16 code units. Multipart base64 bodies are emitted as one unbroken line (`:273`), violating RFC 2045 §6.8's 76-char limit.
4. The reply/forward paths in `gmail/messages.js` duplicate the builders inline (`:122-152`, `:238-268`) instead of calling the helpers, so every fix must land in multiple places — the same duplication disease #74 addresses.

The root cause under all four: header/body construction has no single encoding-aware layer; each header is hand-assembled at each call site. The fix is to build that layer once and route everything through it.

## Design decisions

- **Write the encoder in-repo, no new dependency.** The needed surface (encoded-words, RFC 2231 parameters, QP body encoding) is small and well-specified; a dependency like `nodemailer`'s MIME builder would also change envelope behavior. Keep the existing `foldHeader` as the last-stage folder — it is correct and well-tested.
- **Encode selectively, stay byte-compatible for ASCII.** ASCII-only values that fit the line pass through untouched (existing tests pin this). Encoding triggers on: any octet > 0x7E, or leading/trailing WSP, or a value that cannot fold legally otherwise.
- **Chunked encoded-words.** Emit `=?UTF-8?B?...?=` words chunked so each encoded-word ≤ 75 chars (RFC 2047 §2) with chunk boundaries on UTF-8 character boundaries; adjacent words separated by folding WSP so `foldHeader` can fold between them legally. This turns today's "unbreakable 998+ octet CJK line" into a sequence of foldable tokens — the direct fix for symptom 1.
- **Address headers need structure-awareness.** For To/Cc/Bcc, encode only the display-name part (`encodeDisplayName("名前") <a@b.c>`), never the addr-spec. That requires splitting each mailbox on the last `<`; keep it simple and documented rather than writing a full 5322 parser.
- **Filenames: RFC 2047 in `Content-Disposition`? No — RFC 2231.** Use `filename*=UTF-8''percent-encoded` (plus a plain ASCII `filename=` fallback for legacy readers) and the same for `Content-Type`'s `name`. Always strip CR/LF and quote/escape the plain form — closing the injection hole even for ASCII names.
- **Fix the body encodings truthfully.** Single-part: actually QP-encode (escape 8-bit + `=`, hard CRLF, soft breaks at ≤76). Multipart base64: split at 76 chars. This changes emitted bytes for non-ASCII bodies — that is the point; Gmail decodes either way, but downstream standards-compliance is the issue's goal.

## Implementation

1. New `dist/mime.js` (or a section of `helpers.js` if a new module feels heavy — prefer a new module so tests can target it purely): `encodeHeaderValue(value)`, `encodeDisplayName(mailbox)`, `encodeContentDispositionFilename(filename)`, `encodeContentTypeParams(mimeType, {name})`, `qpEncodeBody(text)`, `wrapBase64(data)`. Each function documented with the RFC section it implements.
2. Route the single-part builder (`helpers.js:207-238`) through it: Subject (`:220,222`), To/Cc/Bcc (`:214-216`), thread headers (`getThreadHeaders` `:112-133` — Subject `Re:` composition must encode *after* prefixing), Content-Type (`:225`), body (`:229,234`).
3. Route the multipart builder (`helpers.js:240-294`): attachment part headers (`:277-285`), base64 wrapping (`:273`).
4. Reply/forward in `gmail/messages.js`: after #74's dedup, these should call the shared builders; if #74 hasn't landed, fix all inline copies (`:114-152`, `:232-268`) — another reason to sequence #74 first.
5. Keep `foldHeader` unchanged; it already handles encoded-words correctly (`tests/helpers.test.js:132-142`).

## Tests

Extend `tests/helpers.test.js` (encode layer is pure — no mocking):

- Long CJK subject: every physical line ≤ 78 octets soft / 998 hard; round-trips through decode (use a small decode helper in the test) to the original string. **Replace** the current test that asserts a >998-octet line is emitted (`:88-105`) — that documented defect becomes a regression assertion in the other direction.
- Emoji, mixed ASCII+Unicode, encoded-word chunk boundaries not splitting surrogate pairs / multibyte sequences.
- Unicode display names: addr-spec untouched, display name encoded.
- Filenames: Unicode and >78-char names produce `filename*=`; `"`/`\`/CR/LF in names are neutralized in the plain fallback (injection test: `evil"\r\nBcc: x@y.z.pdf` yields no new header line).
- QP body: 8-bit octets escaped, `=` escaped, CRLF normalized, decodes byte-identically.
- Base64 bodies wrapped at 76.
- ASCII-only messages byte-identical to today's output **except** the QP body fix (assert exact diffs deliberately, per the issue's "unless a standards fix requires otherwise").
- All four callers (send, draft, reply, forward) produce parseable structure — parse the built raw message in-test (split headers/parts) rather than regexing.

## Acceptance criteria

- No emitted physical header line exceeds 998 octets for any input; ≤78 preserved where achievable.
- Non-ASCII Subject/display names/filenames arrive intact in a real Gmail round-trip (one manual send/receive verification, since renderers are the ultimate judge).
- Declared `Content-Transfer-Encoding` matches actual body encoding in every path.
- Filename header injection is impossible; a test proves it.
- ASCII-only regression suite green.

## Sequencing

After #74 (dead forks deleted, dispatch dedup done) so each builder exists exactly once.
