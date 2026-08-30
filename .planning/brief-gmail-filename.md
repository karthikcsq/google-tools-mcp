# Issue #73: long non-ASCII attachment filenames do not survive a draft round trip

Work only in the worktree `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prC`,
branch `feat/gmail-cluster`. Commit as you go. Do not push. Do not post to GitHub.

## The evidence

A live smoke run against the real Gmail API created a draft with a long non-ASCII attachment
filename and read it back with `getDraft`. The filename came back as:

```
Pr_sentation-du-partenariat-________-__-2026_8_-___-___-rele.pdf
```

Every non-ASCII character became `_`, and the name was truncated. The original was a long
French/Japanese mixed filename ending in `.pdf`.

The non-ASCII **subject** half of #73 passes now, so RFC 2047 encoded-words are working. This
is specifically the **filename** path, which uses RFC 2231 parameter continuations, a
different mechanism: `filename*0*=UTF-8''...`, `filename*1*=...` across multiple lines.

## Where to look

`dist/mime.js` — `buildContentDispositionHeader()` and `buildContentTypeHeader()`, plus
whatever RFC 2231 encoding helper they call. `dist/tools/gmail/messages.js` and
`dist/helpers.js` assemble the parts.

## What to do

1. **Reproduce it locally first**, without the network. Build a multipart message through
   `assembleMultipart()` with an attachment whose filename is long and non-ASCII (say 80+
   characters mixing accented Latin and CJK), then parse the resulting header block back and
   assert you recover the original filename byte for byte. Get a failing check before you
   change anything, and show it in your report.
2. Fix the encoding so a long non-ASCII filename round-trips: RFC 2231 continuations, each
   physical line within the 998-octet hard limit, percent-encoding of non-ASCII bytes with
   the `UTF-8''` charset prefix on the first segment only, and correct `*` suffixes.
3. Check whether the `_` substitution and the truncation come from the same place or two
   different ones. The `_` pattern looks like a sanitizer replacing anything non-ASCII rather
   than encoding it; if such a sanitizer exists, it is the bug, and encoding should replace
   it rather than run after it.
4. Add tests: a long non-ASCII filename, a short non-ASCII filename, a long pure-ASCII
   filename (which should NOT be encoded needlessly), and a filename containing a quote or a
   semicolon. Assert full round-trip and the line-length invariant.

## Standing constraints

- `dist/*.js` is hand-written runtime source. No `src/`, no TypeScript, no build step.
- Tests are Jest ESM: `npm test`. Bare `npx jest` fails. **Read the `Test Suites:` line**, not
  just `Tests:` — a suite that fails to load reports zero failed tests and looks green.
- After changing tracked `dist/` or `tests/` files, regenerate the snapshot **after staging**:
  `node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json > /dev/null`
  (redirect stdout, it is extremely verbose).
- Never interpolate a caught error's message into `publicError()`.
- Do not change the RFC 2047 subject encoding; it works and is covered by tests.

## Report

FIXED `<sha>` with the before/after round-trip evidence, or ALREADY-CORRECT / INVALID with
the evidence. Then the `Test Suites:` line.
