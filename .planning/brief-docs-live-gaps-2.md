# Three Docs fixes still fail against real Google. This time you can run the live repro yourself.

Work only in the worktree `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-int`,
branch `verify/live-smoke-on-fixes`, baseline commit `e205d93`. Commit as you go. Do not push.
Do not post to GitHub. Do not touch any other worktree.

## Why you are in this worktree and not on the PR branch

`verify/live-smoke-on-fixes` is a disposable integration branch that merges all five open PR
branches PLUS the live smoke harness. It is the only tree where both the product fixes and the
live harness exist together, so it is the only place you can prove a fix against the real
Google APIs. I will port your `dist/` and `tests/` diff back onto `feat/docs-cluster` myself
afterwards, so do not try to do that.

## The situation, and why it matters more than the usual "please fix this"

An earlier agent was given these same three issues, reported all three FIXED with passing unit
tests, and all three are still broken against real Google. That is the second time on this
project that unit tests declared a Docs fix working while the live behaviour was unchanged.
So: **a passing unit test is not evidence here.** The only evidence I will accept is the live
scenario flipping to PASS.

Run the harness yourself, as often as you need:

```
GOOGLE_MCP_TEST_FOLDER_ID=15m5wq1pA8Mn0ETxIaLdN0kaUFwnrfzHN LOG_LEVEL=warn \
  node scripts/live-smoke.mjs issue-14-explicit-font-color issue-106-mirror-rewritten-list-structure issue-108-stale-guard-unrelated-change
```

That hits the maintainer's real Google account. The runner confines every write to one Drive
folder and refuses all send paths, so it is safe, but **do not disable, weaken, or work around
any check in `scripts/live-smoke/guard.mjs`**, and do not touch anything in Drive by any other
means. Each run takes about 20 seconds for these three. Cleanup is automatic.

Before you start, run it once unchanged so you see all three fail and you know your loop works.

## The three, with what I already verified

### 1. #14 — `replaceDocumentWithMarkdown` writes text with no explicit foreground colour

Live failure: `3 of 3 text run(s) written by replaceDocumentWithMarkdown carry no explicit
foregroundColor (e.g. "Font Color Probe"), so Google Docs treats them as "no color set"`.

I grepped every caller of `GDocsHelpers.buildDefaultColorStyleRequest`. It is called from
`appendToGoogleDoc.js`, `batchModifyText.js`, `insertTableWithData.js` and `modifyText.js`.
The markdown write path is not among them. So the previous agent's #14 work went onto
`modifyText` and the markdown path never got it, exactly as the last brief predicted, and the
report that it was done was wrong.

Find where `replaceDocumentWithMarkdown` actually turns markdown into batchUpdate requests
(`dist/markdown-transformer/markdownToDocs.js` is the likely place, reached via
`dist/googleDocsApiHelpers.js`) and apply the same explicit-foreground-colour treatment to the
runs it inserts. Check `appendMarkdown` and `replaceRangeWithMarkdown` for the same gap and fix
them too if present; say in your report which of the three needed it.

Watch for the trap: the colour request must cover the ranges the markdown insert actually
produced, which shift as the document is built. Getting the ranges wrong will colour the wrong
text and the live scenario will still fail, which is the feedback you want.

### 2. #106 — list nesting lost through a mirror round trip

Live failure: the sub-item `"Follow up on the table count and space capacity."` came back
without its nesting indent.

Note carefully: this scenario is a **round trip**. It exports the doc to markdown, pushes the
unmodified markdown back with `replaceDocumentWithMarkdown`, and reads again. The previous
agent worked on the **export** side, `renderListItem` in
`dist/markdown-transformer/docsToMarkdown.js` around lines 355-393, replacing a flat
2-space-per-level indent with marker-width-aware indentation. That work looks real.

So before changing anything, determine which half loses the nesting. Read the doc as markdown
and print the raw mirror text: if the sub-item already lacks its indent there, the exporter is
still wrong; if the indent is present in the markdown but gone after the push-back, the
importer (`markdownToDocs.js`, whatever sets `bullet.nestingLevel` or emits
`createParagraphBullets`) is dropping it. Say which one it was in your report. Do not "fix"
both halves speculatively.

### 3. #108 — a title-only external change blocks an unrelated edit

Live failure, with the tool's own rejection text:

```
This file was modified externally since you last read it
(last read: 2026-08-30T03:19:18.892Z, last modified: 2026-08-30T03:19:17.503Z).
```

Two things are wrong and they are separable.

- `last modified` is **1.4 seconds EARLIER** than `last read`. A staleness check that fires when
  the modification predates the read is broken on its face, whatever else is true.
- A Drive **title** change bumps `modifiedTime` without touching any body content the edit could
  overlap, so it should not block a body edit at all.

The guard lives in `dist/readTracker.js`; the message is built at lines 244 and 257. Related
prior work on this branch: `bf07ba0` stopped the guard firing on a byte-identical document
(#119, which now passes live). This is the same class one level out: compare document content
and revision, not file metadata.

Do not fix this by loosening the guard generally. #119's live scenario must keep passing, and
so must every other scenario. A guard that never fires is worse than one that fires too often.

## Standing constraints

- `dist/*.js` is hand-written runtime source. No `src/`, no TypeScript, no build step.
- Tests are Jest ESM: `npm test`. Bare `npx jest` FAILS. **Read the `Test Suites:` line**, not
  just `Tests:` — a suite that fails to *load* reports zero failed tests and looks green.
- The registered tool count is **160**, pinned in `tests/toolRegistration.test.js`,
  `tests/mcpSdkV2Compatibility.test.js`, `tests/mcpServerFacade.test.js`,
  `tests/entrypointSmoke.test.js`. Do not add or remove a tool.
- After changing tracked `dist/` or `tests/` files, regenerate the snapshot **after staging**:
  `node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json > /dev/null`
  (redirect stdout, it is extremely verbose).
- Never interpolate a caught error's message into `publicError()`; use `wrapOperationError()` or
  `getApiErrorDetail()` from `dist/errors.js`.
- Stdout purity is absolute on stdio transport.
- Every behavioural fix still needs a unit test that fails before it and passes after it. The
  unit test is not the evidence, it is the regression guard. Both are required.

## Gates before you report

1. All three named scenarios PASS in a live run.
2. A **full** live run passes at least as well as the baseline: exactly the three you fixed flip,
   and nothing that passed before now fails.
   `GOOGLE_MCP_TEST_FOLDER_ID=15m5wq1pA8Mn0ETxIaLdN0kaUFwnrfzHN LOG_LEVEL=warn node scripts/live-smoke.mjs`
   Baseline for comparison: 19 passed, 3 failed of 22. Target: 22 passed, 0 failed.
3. `npm test` fully green. Baseline: `Test Suites: 91 passed, 91 total`,
   `Tests: 2 skipped, 1295 passed, 1297 total`.
4. The test folder is empty after cleanup and `Stdout leaks` is 0 (the runner reports both).

## Report

One block per issue: FIXED `<sha>`, what was actually wrong (not what I guessed), which file
changed, and the unit test that now covers it. Then paste the **full 22-row live table** and the
`Test Suites:` line verbatim.

If you conclude one of these three cannot be fixed the way I described, say so and explain, with
the evidence you gathered. Do not force a change that makes a unit test pass without moving the
live result. Reporting "two fixed, one genuinely blocked, here is why" is a good outcome.
Reporting three fixed when the live table says otherwise is the one unacceptable outcome.
