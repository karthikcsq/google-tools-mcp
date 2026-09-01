# Brief: close the two create-then-write gaps in #87

Worktree: `C:/Users/2supe/All Coding/Google-Tools-MCP/gtm-87`
Branch: `fix/seed-87`, off `main` @ `a95bf30`
`node_modules` is present and correct. **Do not run `npm install`. Do not modify `package.json` or `package-lock.json`.** Another agent is changing the lockfile on a different branch and a conflict here would be wasted work.

Read `.planning/constraints.md` in the main worktree first. Overrides: you have network access but should not need it. **Do not touch GitHub** (no `gh`, no comments, no PRs). Do not push. Do not commit to `main`. Do not touch any other worktree.

## The bug, already proven

GitHub issue #87 is the master issue for the read-before-write guard. Its third acceptance criterion reads:

> Seed trustworthy tracker state after create/copy/template operations; add create-then-write tests for Docs and Sheets.

That was done for Docs and left undone everywhere else. Verified on `main`:

- `dist/tools/drive/createDocument.js:170-187` seeds properly: it re-fetches with `documents.get({ fields: '*' })` and calls `trackRead(document.id, modifiedTime, markdownContent, seedRes.data.revisionId)`.
- `dist/tools/drive/createFromTemplate.js:89-110` does the same.
- `dist/tools/sheets/createSpreadsheet.js` contains **zero** references to `trackRead` or `readTracker`.
- `dist/tools/drive/copyFile.js` contains **zero** references to `trackRead` or `readTracker`.

Sheets mutations are guarded. All three of these call `guardMutation(args.spreadsheetId)`:
`dist/tools/sheets/writeSpreadsheet.js:27`, `dist/tools/sheets/batchWrite.js:29`, `dist/tools/sheets/clearSpreadsheetRange.js:17`.

And `guardMutation` on an id that was never tracked throws. I ran this against `dist/readTracker.js` on `main`:

```
hasBeenRead: false
guardMutation THREW: This file (fake-spreadsheet-id-just-created) has not been read in this
session. Read it first before making changes to ensure you have current content.
Use readDocument, readSpreadsheet, readFile, or readDriveFile.
```

So today: `createSpreadsheet` then `writeSpreadsheet` is rejected, and `copyFile` then any guarded write is rejected. The user is told to "read it first" a file they just created themselves. That is precisely the complaint #87 records for `createDocument` ("This occurred 7 times across 6 of 13 reviewed sessions"), still live on two other paths.

## What to build

### 1. `createSpreadsheet`

Seed after a successful create. The existing standard for Sheets is set by `dist/tools/sheets/readSpreadsheet.js:26`, which calls `trackRead(args.spreadsheetId)` with **no content and no revisionId**. Match it. A Sheets read does not capture content into the tracker today, so seeding a create with content would be inventing a stronger guarantee than the read path provides, and the two would then disagree.

Seed only when the spreadsheet was actually created. Note the existing `initialDataStatus` handling around `createSpreadsheet.js:44-52`: initial data can fail while the spreadsheet succeeds. Decide deliberately whether a seed is still correct in that case and say why in your report. My read is that it is, because the file exists and the guard is about "have you seen this file", not "did every follow-up step work", but make your own call and justify it.

### 2. `copyFile`

This is the part that needs judgment, so think before you type. `copyFile` can copy a Google Doc, a Google Sheet, or an arbitrary binary Drive file, and the right seed is not the same for all three.

Work out what the guard actually needs for each destination type, then pick the cheapest seed that is honest. Specifically consider:

- For a copied **Doc**, `createDocument` sets the bar: content plus `revisionId`. A copy's content is knowable. Is one extra `documents.get` per copy worth it, or does a bare `trackRead(newId)` leave the guard in a state that could later permit a write against content the caller never saw?
- For a copied **Sheet**, `trackRead(newId)` matches the read path exactly, as above.
- For an arbitrary binary file, ask whether the guard applies at all.

**Do not seed state you cannot stand behind.** #87 says "trustworthy" for a reason: a seed that claims the caller has seen content they have not is worse than the current rejection, because it converts a loud, recoverable error into a silent overwrite. If the honest answer for some branch is "do not seed", that is a valid answer. Say so and explain it.

Read `dist/readTracker.js` in full before deciding. Pay attention to `trackRead` (line 84), `guardMutation` (line 110), and what `guardMutation` does differently when content was recorded versus when it was not.

## Hard constraints

- Do not weaken `guardMutation`, and do not add a bypass flag. The fix is seeding at the creation site, never loosening the guard.
- Do not change any tool's parameter schema.
- A failure to seed must never fail the create/copy itself. The user's file exists; losing it to a bookkeeping error would be a worse bug than the one you are fixing. Consider what happens if the seed's own API call throws.
- Never interpolate a caught error's message into caller-visible error text. This repo has an explicit rule about it; `dist/errors.js` has `wrapOperationError` for the correct pattern.
- No new dependencies.

## Tests

`tests/createFlowsReadSeeding.test.js` already exists and covers the Docs paths (see `:197-215`, `:314-334`, `:336-349`). Extend it, or add alongside it if that reads better. Required:

1. **Sheets create-then-write.** `createSpreadsheet` followed immediately by a guarded `writeSpreadsheet` succeeds. This test must fail on `main`. Confirm that it does, and report the failure message you saw, before you write the fix. A regression test you never watched fail proves nothing.
2. The same for `batchWrite` or `clearSpreadsheetRange`, so the coverage is not tied to one writer.
3. **Copy-then-write**, one test per destination type you chose to seed.
4. For every branch you deliberately chose **not** to seed, a test asserting the guard still rejects, with a comment saying that is intentional. That is how the decision survives the next person reading it.
5. A test that a create still succeeds and still returns its normal payload when the seeding step itself throws.

## Gates, all required

1. `npm test` from the worktree root. Report the **`Test Suites:`** line verbatim, not just `Tests:`. A suite that fails to link reports zero failed tests while being completely broken, so `Tests:` alone is not evidence.
2. Suites >= 91, failed = 0.
3. Tool count unchanged: 160 default, 232 with aliases enabled.
4. `git diff --stat` against `main`.
5. Commit on `fix/seed-87`. **Do not push.**

## Report

- Your `copyFile` decision per destination type, and the reasoning. This is the part I will scrutinise hardest.
- The verbatim failure message from the Sheets test before the fix.
- The `Test Suites:` and `Tests:` lines.
- `git diff --stat`.
- Anything in this brief that turned out to be false. If a stated precondition is wrong, stop and report rather than working around it.
