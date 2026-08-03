# Plan: standards-compliant Gmail MIME header generation (#73)

Issue: [#73](https://github.com/karthikcsq/google-tools-mcp/issues/73) (canonical for closed #54) · Verified against `main` @ 8640240. Revised after adversarial review.

## Root causes

The message builders assemble RFC 5322 headers by string interpolation, and only the *folding* half of the problem was ever fixed (PR #38). Verified current state:

1. **No RFC 2047 encoding exists anywhere.** Non-ASCII Subjects and display names are emitted as raw UTF-8 octets. The folder (`dist/helpers.js:169-194`) explicitly refuses to split unbreakable tokens, so a wordless CJK/emoji subject ships as a single line that can blow the 998-octet hard limit — there is even a test *asserting* that overflow (`tests/helpers.test.js:88-105`). The folder was built to safely handle already-encoded words (`helpers.js:141-165` cites RFC 2047 §2) but nothing ever *produces* them.
2. **Attachment headers bypass every safety layer.** `Content-Type: ${att.mimeType}; name="${att.filename}"` and `Content-Disposition: attachment; filename="${att.filename}"` are raw template literals in the live builders (`dist/helpers.js:279-281`; `dist/tools/gmail/messages.js:137-139` reply, `:253-255` forward — plus two more copies in the dead fork `dist/tools/messages.js`, which #74 deletes first). No RFC 2047/2231 encoding, no quoting of `"` or `\`, no length folding, and — unlike every folded header — **no CR/LF stripping**, so both a crafted filename *and a crafted `mimeType`* (also raw-interpolated, schema accepts any string) are header-injection vectors.
3. **(Found in verification) The declared body encoding is a lie.** Single-part bodies declare `Content-Transfer-Encoding: quoted-printable` (`helpers.js:226`) but `wrapTextBody` (`:135-139`) only inserts soft breaks — no QP escaping of 8-bit octets or `=`, bare `\n` in a CRLF message, UTF-16 chunking. This applies to **both text and HTML** single-part bodies (`helpers.js:224-229`; reply `gmail/messages.js:147-151`; forward `:263-267`). Multipart base64 is emitted unbroken — for the **body part and every attachment part** (`helpers.js:273`, `:277-285`; `gmail/messages.js:134-145`, `:250-260`) — violating RFC 2045 §6.8.
4. Reply/forward duplicate the builders inline instead of calling helpers — the duplication #74 removes.

Root cause: header/body construction has no single encoding-aware layer; each header is hand-assembled at each call site. Build that layer once and route everything through it.

## Design decisions

- **Write the encoder in-repo, no new dependency.** The surface (encoded-words, RFC 2231 parameters, QP, base64 wrapping) is small and well-specified. Keep `foldHeader` as the last-stage folder — correct and well-tested.
- **Encode selectively; ASCII stays byte-compatible** except where a standards fix requires otherwise (QP bodies, base64 wrapping). Encoding triggers on any octet > 0x7E, leading/trailing WSP, or a value that cannot fold legally otherwise.
- **Chunked encoded-words:** `=?UTF-8?B?...?=`, each word ≤ 75 chars, chunk boundaries on UTF-8 character boundaries (never splitting a multibyte sequence or surrogate pair), separated by folding WSP so `foldHeader` folds between them. This converts today's unbreakable CJK line into foldable tokens.
- **Address headers, bounded parsing:** for To/Cc/Bcc mailboxes, encode only the display-name. Supported syntax, stated in the tool description: `Display Name <addr@spec>` (split on last `<`) or bare `addr@spec`. Anything else (quoted-string names with embedded `<`, groups, comments) passes through **unchanged apart from folding** — never corrupted, never encoded. This is a deliberate floor, not a full RFC 5322 parser; `formatEmailList` (`gmail/messages.js:91-97`) already normalizes the common reply-all shapes upstream.
- **Filenames: RFC 2231 with continuations.** `filename*=UTF-8''…` percent-encoded, split into `filename*0*=`, `filename*1*=`… continuations when the encoded value would make a parameter token unfoldable past line limits; plus an ASCII `filename=` fallback (quoted, `"`/`\` escaped, CR/LF stripped). Same treatment for `Content-Type`'s `name`.
- **`mimeType` is validated, not trusted:** must match RFC 2045 `token "/" token`; anything else → `UserError`. That closes the second injection vector at the schema/build boundary rather than by escaping.
- **Bodies become truthful:** real QP encoding (escape 8-bit and `=`, encode trailing WSP on a line, normalize to CRLF, soft breaks so no line exceeds 76 octets including the `=`) for text *and* HTML single parts; base64 wrapped at 76 for multipart bodies *and attachment payloads*.
- **Scope of the 998-octet guarantee:** applies to all headers whose values this server *composes from user text* (Subject, display names, attachment parameters). Protocol atoms copied verbatim from Gmail (Message-IDs in `In-Reply-To`/`References`, addr-specs) remain unbreakable by design — the existing tests pinning that behavior (`tests/helpers.test.js:120-130`) stay. State this boundary in the acceptance criteria instead of claiming "any input".

## Implementation

1. New `dist/mime.js`: `encodeHeaderValue`, `encodeDisplayName`, `encodeContentDispositionFilename` (with continuations), `validateMimeType`, `encodeContentTypeParams`, `qpEncodeBody`, `wrapBase64`. Each documented with its RFC section.
2. Route the single-part builder (`helpers.js:207-238`): Subject (`:220,222`), To/Cc/Bcc (`:214-216`), thread headers (`getThreadHeaders` `:112-133` — encode after the `Re:` prefix is applied), body via `qpEncodeBody` (`:229,234`).
3. Route the multipart builder (`helpers.js:240-294`): part headers (`:277-285`), `wrapBase64` for body and attachments.
4. Reply/forward in `gmail/messages.js`: after #74's dedup these call the shared builders; the encoder lands in exactly one copy of each path. (#74 is a hard prerequisite — see Sequencing.)
5. Keep `foldHeader` unchanged.

## Tests

Pure-layer tests in `tests/helpers.test.js`/new `tests/mime.test.js`, **plus mocked tool-execution tests** for all four surfaces — `sendMessage` and `createDraft` exercise the helpers (`gmail/messages.js:25-33`, `gmail/drafts.js:26-35`), but `replyMessage` and `forwardMessage` have their own inline paths today, so their tests must capture the exact `raw` payload sent through the mocked Gmail client, including attachment and HTML branches:

- Long CJK subject: every composed-header line ≤ 78 octets soft / 998 hard; decodes back to the original. **Replace** the test asserting >998-octet output (`tests/helpers.test.js:88-105`) with its inverse.
- Encoded-word chunking at multibyte/surrogate boundaries; mixed ASCII+Unicode.
- Display names: encoded for the two supported shapes; unsupported shapes pass through unmodified; addr-spec never touched.
- Filenames: Unicode and long names produce `filename*` (continuations when long — assert each physical line ≤ 998 including the parameter split); plain fallback neutralizes `"`, `\`, CR, LF (injection test: `evil"\r\nBcc: x@y.z.pdf` yields no new header).
- `mimeType` validation: `text/plain` passes; `text/plain\r\nX-Evil: 1`, empty, and non-token values throw `UserError`.
- QP: 8-bit escaped, `=` escaped, trailing space/tab on a line encoded, control bytes escaped, CR-only/LF-only input normalized to CRLF, empty lines survive, no line > 76 octets counting the soft-break `=`; decodes byte-identically. HTML body path included.
- Base64: body and attachment payloads wrapped at 76; forwarded re-attached originals (`gmail/messages.js:227`) wrapped too.
- ASCII-only send/draft byte-compatibility: assert exact expected diffs (QP body changes only) rather than blanket equality.

## Acceptance criteria

- No header line composed from user-supplied text exceeds 998 octets; ≤ 78 where achievable; protocol atoms exempt (documented).
- Non-ASCII Subject/display names/filenames arrive intact in one manual Gmail round-trip (send + view raw via `gmail.users.messages.get(format=raw)`).
- Declared `Content-Transfer-Encoding` matches actual encoding in every path (text, HTML, multipart, attachments).
- Header injection via filename or mimeType is impossible; tests prove both.
- Reply and forward provably use the shared encoder (tool-execution tests capture their raw output).

## Sequencing

**Hard dependency on #74** (dead forks deleted, reply/forward dedup done) so each builder exists exactly once before it is made encoding-aware.
