# Live smoke found four Docs fixes that do not actually work against real Google APIs

Work only in the worktree `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prB`,
branch `feat/docs-cluster`. Commit as you go. Do not push. Do not post to GitHub.

## How these were found, and why you should trust them

A live smoke harness now runs each filed issue's literal reproduction against the real
Google APIs. Run against a build containing every fix on every branch, ten scenarios flipped
from failing to passing, which proves both the harness and those fixes. **These four did
not.** PR #110 claims to close all of them, the unit tests pass, and the live repro still
fails. So the unit tests are asserting something narrower than the real behaviour.

You cannot run the harness from this worktree (it lives on `feat/live-smoke`). Work from the
evidence below, and make the unit tests match reality rather than the other way round.

## The four

### 1. #122 — the mirror backup guard is bypassed on the v2 path (this is a real hole in a fix committed today)

`dist/tools/docs/readGoogleDoc.js` guards the legacy shared mirror, but only inside
`if (!diffHandle && writeLocalFile)`. When a read handle IS minted, which is the v2 runtime's
normal path, the handle's own editable file is written with no
`backupIfLocallyModified()` check at all. The live repro (write a local edit into the mirror,
then `readDocument(diffFromLastRead: true)`) still destroys the edit, with no `.bak` and no
mention of one.

Fix the handle path too. Every write to a file the user is told to edit must go through the
same local-modification check, whichever path produced it. Then add a unit test that
exercises the handle path specifically, since the existing one clearly only covers the legacy
branch.

### 2. #14 — text written by `replaceDocumentWithMarkdown` still carries no explicit colour

Live result: "3 of 3 text run(s) written by replaceDocumentWithMarkdown carry no explicit
foregroundColor." The default-colour work landed on `modifyText`, but the markdown replace
path never got it. Apply the same explicit-foreground-colour treatment there. Check
`appendMarkdown` and `replaceRangeWithMarkdown` for the same gap while you are in there and
report what you find.

### 3. #106 — list nesting is still lost through the mirror round trip

Live result: the sub-item "Follow up on the table count and space capacity." came back
without its nesting indent. A nested list exported to the mirror and pushed back loses the
sub-item's level. Note this is a different failure from #118 and #123, which now pass, so the
exporter's emphasis and blank-line handling are fine and this is specifically nesting depth.
Extend `tests/markdownRoundTrip.test.js` with a nested-list case; it is the natural home.

### 4. #108 — a title-only external change still blocks an unrelated edit

Live result: renaming the document (title only, body untouched) then editing a paragraph is
refused as an external modification. The reported timestamps also show `last modified`
EARLIER than `last read`, which should never trip a staleness check by itself.

A Drive title change bumps `modifiedTime` without touching any content the edit could
overlap. The guard must compare what actually matters: document content and revision, not
file metadata. Related to the #119 work already on this branch (`bf07ba0`), which stopped the
guard firing on a byte-identical document; this is the same class one level out.

## Standing constraints

- `dist/*.js` is hand-written runtime source. No `src/`, no TypeScript, no build step.
- Tests are Jest ESM: `npm test`. Bare `npx jest` fails. **Read the `Test Suites:` line**, not
  just `Tests:` — a suite that fails to load reports zero failed tests and looks green.
- Tool count is 160. Do not add a tool.
- After changing tracked `dist/` or `tests/` files, regenerate the snapshot **after staging**:
  `node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json > /dev/null`
  (redirect stdout, it is extremely verbose).
- Never interpolate a caught error's message into `publicError()`; use `wrapOperationError()`
  or a validated field from `dist/errors.js`.
- Stdout purity is absolute on stdio: nothing but protocol messages.
- Every behavioural fix needs a test that fails before it and passes after it. Say so
  explicitly in your report, with the before/after evidence.

## Report

One block per issue: FIXED `<sha>` with what changed and the test that now covers it, or
ALREADY-CORRECT / INVALID with the evidence. Then the `Test Suites:` line. If you conclude
one of these four is not actually fixable the way I described, say so and explain, rather
than forcing a change that makes the unit test pass without changing live behaviour.
