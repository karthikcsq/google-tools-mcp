# PR #111 (Gmail cluster) — close out review findings and issue #116

You are working on branch `feat/gmail-cluster` in this worktree. The PR introduced a
dependency-free MIME builder at `dist/mime.js` plus Gmail send/draft/forward paths. Three
adversarial-review findings and one unresolved reviewer thread landed AFTER the last commit
(86057c2) and have never been addressed. There is also a new user-reported bug, issue #116.

Work through them in order. Findings 1-4 are the review findings and the unresolved thread;
finding 5 is issue #116.

## Standing constraints (apply to every task below)

- You are working in the worktree you were launched in (`-C`). Stay in it. Do NOT `git
  checkout`, `git switch`, `git rebase`, `git merge`, `git push`, or touch any other branch.
- **Commit your work** in logical commits with real messages. Do not push.
- **`dist/*.js` is hand-written runtime source.** There is no `src/`, no TypeScript, and no
  build step. Edit `dist/` directly.
- **Tests are Jest ESM.** Run `npm test` or `npm test -- <path>`. Bare `npx jest` FAILS.
  Read the **`Test Suites:`** line, not just `Tests:` — a suite that fails to *load* reports
  zero failed tests, so a broken suite otherwise looks green.
- The registered tool count is **160**, pinned in `tests/toolRegistration.test.js`,
  `tests/mcpSdkV2Compatibility.test.js`, `tests/mcpServerFacade.test.js`,
  `tests/entrypointSmoke.test.js`. If you add a tool you must update all of them.
- After changing any tracked file under `dist/` or `tests/`, regenerate the inventory:
  `node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json`
  Line shifts alone fail `tests/mcpMigrationInventory.test.js`.
- **Stdout purity is absolute** on stdio transport: only protocol messages may reach stdout.
  A stray `console.log` corrupts the protocol. Use the logger, which writes to stderr.
- **Error-boundary rule:** never interpolate a caught error's message into `publicError()`.
  Use `wrapOperationError()` or a validated field via `getApiErrorDetail()` from
  `dist/errors.js`. Caller-supplied text must never reach persisted diagnostics.
- You have **no network access**. `gh`, `npm install`, and any HTTP call will fail. Do not
  try. Everything you need is inlined in this brief or already in the worktree.
- Do not make unrelated changes, do not reformat untouched code, do not bump versions.
- Add or extend tests for every behavioural fix. A fix without a test that fails before it
  and passes after it is not done.

## How to report

For EVERY numbered finding, end your run with one line of the form:

    FINDING <n>: FIXED <commit-sha> — <one sentence on what changed>
    FINDING <n>: ALREADY-CORRECT — <the code and reasoning that disprove it>
    FINDING <n>: INVALID — <why the report is wrong>

Verify each finding against the actual code BEFORE fixing it. Some reports are wrong or
already fixed; saying so with evidence is a correct outcome and is more useful than a
defensive change. Never silently skip one.

---

# The findings


## Finding 1 (posted 2026-08-21T16:54:28Z)

**Adversarial Review — issue**

`assembleMultipart` base64-encodes the text/HTML body before canonicalizing line breaks, so any multipart message whose source body contains normal `\n` line endings produces a MIME `text/*` part that decodes to bare LF bytes.

The current code does:

```js
const bodyBase64 = Buffer.from(String(bodyText ?? ''), 'utf8').toString('base64');
```

and then declares that part as `Content-Type: text/plain` or `text/html`. RFC 2046 §4.1.1 requires the canonical form of every MIME `text` subtype to represent line breaks as CRLF and forbids bare CR/LF. The single-part path already does this correctly in `qpEncodeBody`, but the multipart path does not.

Concrete failure: send/reply with an attachment and `body: 'line one\nline two'`. Decoding the emitted body part yields bytes for `line one\nline two`, not `line one\r\nline two`. Reply/forward multipart paths are especially exposed because their generated quoted/forwarded text itself contains `\n` separators.

This is not covered by the multipart tests: they verify base64 wrapping and Unicode bytes, but their body fixtures contain no line breaks.

Smallest fix / acceptance criteria: normalize `bodyText` to canonical CRLF before UTF-8/base64 encoding in `assembleMultipart` (and use that canonical value consistently for boundary collision inputs). Add multiline text and HTML multipart tests that decode the body part and assert there are no bare CR or LF bytes.

Spec: https://www.rfc-editor.org/rfc/rfc2046#section-4.1.1


## Finding 2 (posted 2026-08-21T16:55:59Z)

**Adversarial Review — issue**

Long printable-ASCII display names can still produce an illegal >998-octet recipient header even though this PR protects long Subjects.

`encodeDisplayName()` only switches to RFC 2047 when `needsEncoding(name)` is true. A supported address such as:

```text
AAAAAAAA... (1000 As) ... <alice@example.com>
```

contains only printable ASCII, so it is returned unchanged. `foldHeader('To', ...)` deliberately never splits an unbreakable token, so the first physical line becomes `To: ` + the 1000-character name: already 1004 octets before the address is even considered. RFC 5322's hard limit is 998 characters per line, so a downstream MTA is allowed to reject or mishandle the message.

This differs from an addr-spec, which must remain literal: the display-name is exactly the portion that may safely be converted to RFC 2047 encoded-words. `encodeHeaderValue()` already has analogous protection for an overlong ASCII Subject, but `encodeDisplayName()` lacks it.

The current tests cover Unicode display names and long Unicode Subjects, but not a long ASCII display-name token.

Smallest fix / acceptance criteria: treat a display name with an unbreakable run that cannot fit under the 998-octet hard limit as encoding-required even when it is printable ASCII, route that name through `encodeEncodedWords()`, and add To/Cc/Bcc regression coverage asserting every emitted physical header line stays <=998 octets while the decoded display name round-trips exactly.


## Finding 3 (posted 2026-08-21T17:03:07Z)

**Adversarial Review — issue**

`assembleSinglePart` does not emit the required blank line between headers and body when the body is empty.

Concrete failure: `sendMessage` allows `body` to be omitted, and `constructRawMessage` then calls `assembleSinglePart(headers, '', false)`. The builder appends one empty array element after `MIME-Version`, but because it only appends the encoded body when `bodyText` is truthy, `message.join('\r\n')` ends with only one `\r\n` after the final header. An RFC 5322 message needs an empty line between the header section and body, which is two consecutive CRLFs after the final header even when the body is zero bytes.

Current shape for an empty body ends like:

```text
Content-Transfer-Encoding: quoted-printable\r\n
MIME-Version: 1.0\r\n
```

It should end like:

```text
Content-Transfer-Encoding: quoted-printable\r\n
MIME-Version: 1.0\r\n
\r\n
```

This is reachable through the public `sendMessage` schema because `body` is optional, and it also affects any other caller that intentionally sends an empty single-part body.

Smallest fix / acceptance criteria: serialize the header/body separator independently of whether `bodyText` is empty. Add a regression that decodes an empty-body message and asserts the raw bytes contain `\r\n\r\n` after the final header and no body bytes after that separator.


## Unresolved review thread on dist/mime.js:None

**chatgpt-codex-connector** 2026-08-21T14:42:
**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Avoid emitting a blank line while folding long whitespace**

When a printable ASCII header contains a sufficiently long whitespace run followed by another token (for example, a subject of `abc` + 100 spaces + `def`), the whitespace is moved onto its own continuation at line 75, and this branch then pushes `line.slice(0, -whitespace.length)`, which is an empty string. The resulting `\r\n\r\n` prematurely terminates the message headers, so the remainder of the Subject and even the MIME headers are interpreted as body content; keep the whitespace on a nonempty continuation or otherwise avoid pushing an empty physical line.

Useful? React with 👍 / 👎.

---

**ElliotDrel** 2026-08-21T14:53:
Fixed in 86057c2. Folding now splits only at existing whitespace and always keeps a following token on a non-empty continuation, so no empty physical line can be emitted. The effect was worse than the severity label suggests: an empty line ends the header block, so everything after it, including the MIME headers, would have been parsed as body.

Two related things came out of verifying it. A general invariant test now covers adversarial whitespace (leading/trailing, runs of 1/2/78/100/999, tabs, whitespace-only, boundary-exact) asserting no empty line, no line over 998 octets, and exact unfold round-trip. And `foldThreadHeader` in dist/helpers.js turned out to be the one caller that folded a raw value with no encoding step, so a long unbreakable Subject on a received message produced an over-length line: Subject is now encoded there, while In-Reply-To and References stay literal so threading is preserved.

---

**ElliotDrel** 2026-08-21T16:54:
**Adversarial Review — issue**

The 86057c2 fix closes the reported long-whitespace case, but the same empty-physical-line failure still exists when the continuation contains exactly one whitespace byte.

Concrete repro: `foldHeader('Subject', 'A'.repeat(69) + ' ' + 'B'.repeat(78))`.

`Subject: ` is 9 octets, so the first 69-character token fills the first physical line to exactly 78. The following single space is therefore moved to a continuation by the whitespace branch (`line = segment`, so `line === ' '`). The next 78-character token does not fit. In the non-whitespace branch, `beforeWhitespace` is empty and the current fallback executes `lines.push(line.slice(0, -1))`; with a one-byte whitespace line, that pushes `''`. The serialized header therefore contains `\r\n\r\n`, terminating the header block before the remaining Subject/MIME headers.

The new adversarial test includes a one-space run, but only in `left + ' ' + right`, where the preceding line is nowhere near 78 octets, so it never reaches this branch.

Smallest fix: when the all-whitespace continuation has length 1, do not push `line.slice(0, -1)`; keep that one existing WSP with the following token (even if the token itself needs its own handling), and add a regression where a token fills the preceding physical line exactly before a 1-byte WSP + long token.
---

# Finding 5 — user-reported bug (treat as finding number 5 in your report)

Reproduce this FIRST with a real call through the draft/send body-encoding path before
changing anything. If the double-decode does not reproduce on this branch, say so with
evidence — the reporter was running published 2.0.0, and this PR rewrote that path.

## Issue #116: updateDraft/createDraft double-decodes quoted-printable, stripping every "=" from the body

## Description

## Summary

`updateDraft` (and likely `createDraft`/`sendMessage`, which share the body-encoding path) appears to run the message body through a quoted-printable decode one extra time before storing it. Because `=` is the QP escape character, every literal `=` in the body is consumed or turns into a garbage byte. This silently destroys HTML bodies and mangles any URL containing a query string.

## Reproduction

Call `updateDraft` with an HTML body containing normal attributes and a URL with query params, e.g.:

```
<a href="https://example.com/page?tab=t.0#heading=h.abc">link</a>
<a href="https://www.linkedin.com/feed/update/urn:li:share:7495913127058976769/?actorCompanyId=106734664">post</a>
```

Then read the draft back with `getDraft`.

## Expected

Body stored verbatim; the HTML renders with working links.

## Actual

Every `=` is gone, and `=NN` sequences are decoded as hex bytes:

- `<a href="https://...">` becomes `<a href"https://...">` (attribute syntax broken, so Gmail renders no link at all)
- `<div dir="ltr">` becomes `<div dir"ltr">`, `class="gmail_quote"` becomes `class"gmail_quote"`, `style="..."` becomes `style"..."` — the entire document structure collapses
- `?tab=t.0#heading=h.abc` becomes `?tabt.0#headingh.abc` (broken URL)
- `?actorCompanyId=106734664` becomes `?actorCompanyId 6734664` — here `=10` was decoded as byte 0x10, so the URL is not just broken but corrupted with a control character

The corruption is silent: the tool returns success, and the damage is only visible after `getDraft` or in the Gmail UI.

## Impact

Any HTML email sent or drafted through these tools is destroyed. In my case this wrecked a real outreach draft, and the only recovery was rebuilding the message by hand. Plain-text bodies are affected too whenever they contain a `=` (extremely common in URLs).

## Workaround

Pass a pre-built RFC 2822 message via the `raw` parameter with `Content-Transfer-Encoding: base64` on each MIME part. `raw` bypasses the broken encoding path entirely.

## Likely cause

The body is QP-encoded when the MIME message is assembled, then decoded again (or decoded before encoding) somewhere in the pipeline. A single decode pass too many. Worth checking whether the input is being treated as already-QP-encoded when it is in fact plain input.

## Environment

Gmail draft update on an existing reply thread, HTML body ~9KB, Windows 11, Claude Code.

<details>
<summary>Diagnostic Info</summary>

- **Server version:** 2.0.0
- **Node version:** v22.22.3
- **OS:** win32 10.0.26200 (x64)
- **Auth status:** valid
- **Scopes:** documents, drive, spreadsheets, script.external_request, gmail.modify, gmail.compose, gmail.send, gmail.settings.basic, gmail.settings.sharing, calendar, forms.body, forms.body.readonly, forms.responses.readonly, presentations, tasks, service.management

</details>

