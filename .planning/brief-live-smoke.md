# Build the pre-merge live smoke process for google-tools-mcp

You are working in the worktree `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-smoke`
on branch `feat/live-smoke` (cut from `docs/mcp-plan-client-evidence`, the MCP-migration
branch that every other open PR stacks on). Stay in that worktree. Commit as you go with
real commit messages. Do not push, do not touch other branches or worktrees.

## Why this exists

Unit tests are green on every open PR, and users still hit bugs that only show up against
real Google Docs, Drive and Gmail: markdown that exports but does not re-import, a read
that silently wipes a locally edited mirror, a draft whose `=` characters vanish. The
maintainer wants a process where, before a PR merges, the tools are actually run against
real files, the way the reporter ran them, and the result is checked.

Deliverable: a runner plus a directory of scenarios. Each scenario is a small script that
calls tools in-process and asserts on what comes back. There is a repro scenario for every
filed issue that described concrete steps, and the scenario does exactly what the reporter
did.

## What already exists (read these first)

- `scripts/call-local-tool.js` loads every registered tool in-process with real auth and
  runs one by name. This is the loading pattern to reuse. Do not go through the MCP
  transport; call `execute()` on tool definitions directly.
- `dist/auth.js`: auth already works on this machine (`token.json` in
  `~/.config/google-tools-mcp`). `node scripts/call-local-tool.js getProfile` succeeds.
- `dist/readTracker.js`, `dist/docsHandles.js`: on this branch, Docs mutations from the
  HTTP path need read handles, but in-process stdio-style calls do not. Read
  `tests/readHandleIntegration.test.js` and `tests/batchModifyTextHandleIntegration.test.js`
  to understand how tools expect to be called in sequence (read before write).
- `docs/plans/SESSION-STATE.md` on branch `dev/live-testing` (worktree
  `../google-tools-mcp-dev`, read-only for you) has a seven-item "Post-merge manual
  checklist". Every item becomes a scenario.

## Hard safety boundaries. Build these INTO the runner, not into the docs.

This runs against the maintainer's REAL Google account. The runner must:

1. Refuse to start unless `GOOGLE_MCP_TEST_FOLDER_ID` is set. The folder for this machine
   is `15m5wq1pA8Mn0ETxIaLdN0kaUFwnrfzHN` (name: "google-tools-mcp live smoke (safe to
   delete)"). Put that id in `.env.live-smoke.example`; never commit a real `.env`.
2. Confine every write to that folder. Before any mutating Drive/Docs/Sheets/Slides call
   on an existing file id, verify the file's parent chain reaches the test folder, and
   abort the scenario if it does not. Files the scenario creates must be created inside
   the folder (pass the parent id).
3. Never send mail. Inside the runner, `sendMessage`, `sendDraft`, `replyMessage` and
   `forwardMessage` must throw before reaching the API. Drafts are allowed (createDraft,
   updateDraft, getDraft, deleteDraft) and every draft created must be deleted at the end.
4. Delete only what the run created. Track every created id; the cleanup step trashes
   exactly those, nothing else, and reports anything it could not clean.
5. Log every tool call (name, args with long strings truncated, outcome, duration) to
   `live-smoke-results/<timestamp>.jsonl`, gitignored.
6. Never write to stdout from tool code paths. The runner's own progress output goes to
   stderr; the summary table goes to stdout at the end.

## Runner shape

`scripts/live-smoke.mjs [cluster|scenario-name ...] [--keep] [--list]`

- Discovers scenarios under `live/<cluster>/*.mjs`. Clusters: `docs`, `drive`, `gmail`,
  `checklist`.
- Each scenario exports `{ name, issue, description, expectedOnBase, run(ctx) }`.
  `ctx` provides: `call(toolName, args)` (in-process, logged, safety-checked), `folderId`,
  `track(fileId)` for cleanup, assertion helpers, and `readMirror(docId)` /
  `writeMirror(docId, text)` for the local markdown mirror file that `readDocument`
  writes (find its path from the tool result or from `dist/tools/docs/readGoogleDoc.js`).
- Exit code non-zero if any scenario fails. Print a table: scenario, issue, pass/fail,
  one-line reason. `--keep` skips cleanup for debugging.
- `npm run live-smoke` script in package.json.

## Scenarios. This is the important part.

For every issue below, the scenario must replicate the reporter's exact steps, in the
order they gave them, with the same kind of input (same markdown shapes, same body text,
same parameter names they used), and assert on the thing they said was wrong. A scenario
that passes on a build that still has the bug is worthless, so make the assertion strict:
compare read-back text byte for byte, or check `format='text'` output for literal markdown
characters.

Fetch each issue body with `gh issue view <n> --json title,body -q '.title,.body'` (you
have network). Name files `issue-<n>-<slug>.mjs`.

### Docs cluster

- #118: `**text **` round-trip. Create a doc via `createDocument` with bold runs that
  include a trailing space, `readDocument(format='markdown')`, push the unmodified mirror
  back with `replaceDocumentWithMarkdown`, then `readDocument(format='text')` and assert no
  literal `**` or `~~`, and that bold survived (check `getFormatting` or the JSON format).
- #123: header immediately after a list. Same shape: create, read markdown, push back
  unchanged, read text, assert the header is its own paragraph and not glued to the last
  list item.
- #122: read overwrites the mirror. `readDocument(markdown)`, edit the mirror file
  locally (append a section), `readDocument(markdown, diffFromLastRead=true)`, then
  assert the local edit is still present in the mirror, or a `.bak` exists and the result
  says so. This scenario is expected to fail on the base branch; that is the point.
- #119: phantom staleness. `readDocument(text)`, then a series of 10+ `modifyText` calls
  with no external edits, assert none raises a "changed since you last read" error.
- #120: `modifyText` cannot create lists. Insert a paragraph mid-document with
  `modifyText` and a `paragraphStyle` requesting a bullet preset; read back with
  `format='json'` or `index` and assert the paragraph has a bullet. Expected to fail on
  the base branch until #110 lands.
- #121: inherited italic. Create a doc with an italic placeholder line, `modifyText`
  replace it with several plain paragraphs, then check formatting of the inserted range
  and assert it is not italic (or that the result message reports the inherited style).
- #117: mailto mismatch. Create a doc where a link's display text is an email but its
  URL is a different mailto; `readDocument(markdown)` and assert the output flags it.
- #105: `format='json'` size. Create a roughly 10K-char doc, `readDocument(format='json')`,
  assert the returned payload is not more than 20x the text length.
- #106, #108, #107, #96, #86, #14: read each body. If the reporter gave concrete steps,
  script them. If an issue only describes a design gap with no reproducible steps, write
  the scenario for the feature's stated acceptance and note in the file header that it
  is an acceptance check rather than a repro.

### Drive cluster

- #124: `copyFile` with `name`. Copy a file in the test folder passing `name: '...'`
  (the exact parameter the reporter used) and assert the copy has that name.
- #99: `listFolderContents` recursive. Build a 3-deep folder tree in the test folder,
  list with depth 3, assert every path and parent matches what was created.

### Gmail cluster (drafts only, never send)

- #116: `=` stripped. `createDraft` with the exact two-link HTML body from the issue,
  `getDraft`, assert every `=` survives and the URLs are intact. Then `updateDraft` with
  the same body and assert again. Delete the draft.
- #73: non-ASCII subject and a long non-ASCII attachment filename in a draft; `getDraft`
  and assert the subject decodes correctly and the filename is intact.

### Checklist

One scenario per item of the seven-item manual checklist in SESSION-STATE.md that is not
already covered above: nested ordered list round-trip, `replaceRangeWithMarkdown` on one
heading section leaving the rest untouched, comment resolve then reopen, and the
forward-with-attachment case, which must only build the forward as a draft and assert on
the assembled message, never send.

## Also add

- `docs/live-smoke.md`: how to run it, what it will and will not touch, how to add a
  scenario, and the rule that a PR touching a cluster must include a passing
  `live-smoke <cluster>` run in its description. Add it to the index in `docs/README.md`.
- If `.github/pull_request_template.md` exists, add a line for the live-smoke result. If
  not, do not create one; just document the rule.
- `.gitignore` entries for `live-smoke-results/` and `.env.live-smoke`.

## Gates before you report

- `npm test` fully green. Read the `Test Suites:` line; a suite that fails to load shows
  zero failed tests.
- If you change any tracked file under `dist/` or `tests/`, regenerate the inventory:
  `node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json`
  You probably will not touch `dist/`; the runner and scenarios live in `scripts/` and
  `live/`.
- Run the whole thing for real:
  `GOOGLE_MCP_TEST_FOLDER_ID=15m5wq1pA8Mn0ETxIaLdN0kaUFwnrfzHN node scripts/live-smoke.mjs`
  Report the per-scenario table verbatim. Failures on this base branch for #118 #123 #122
  #119 #120 #121 #117 #124 #116 are expected (the fixes live on other branches). What
  matters is that each fails for the reason the reporter described and not because the
  scenario is broken. Anything that errors because of a scenario bug, fix.
- Confirm the test folder contains nothing after cleanup (list it), and that no draft you
  created remains.

## Report

End with: the commit list, the scenario table from the real run, which scenarios are
expected-fail on this branch and why, and anything you could not do.
