# v3.0 release plan (audited 2026-08-29)

Source of truth for remaining work is the agent task list. This file is the durable copy.
Companion: `docs/plans/SESSION-STATE.md` on `dev/live-testing` (working rules, Codex
invocation, repo gotchas, worktree table, write boundaries for live testing).

## Goal

Every open issue acted on or closed; every discussed feature implemented and working;
3.0.0 shipped on the MCP 2026-07-28 spec with the official SDK v2 runtime.

## Done (verified 2026-08-29 against local and remote)

- Five PRs open, CI green on Node 20/22, all `MERGEABLE`, stacked on #109:
  - #109 MCP 2026-07-28 migration (base: main). All review comments answered.
  - #110 Docs cluster (closes #105 #96 #14 #106 #107 #88 #108 #86, #87 with #109)
  - #111 Gmail cluster (closes #73 #74 #53)
  - #112 Ops cluster (closes #75 #82 #85 #48 #79 #80 #91 #92 #78 #83 #84 #55)
  - #113 Independents (closes #99 #56 #100 #101)
- `feat/v3-integration` (worktree `google-tools-mcp-int`, HEAD 53073e1) proves all five
  merge: 1148 tests green. Conflict resolutions recorded in SESSION-STATE.md.
- `dev/live-testing` (8282709) registered as `google-dev` MCP server; 161 tools visible.
  Carries `dc9b1ce` createDocument test fix not yet on the integration branch.
- Every worktree clean. #71 partial work preserved in `stash@{0}` on the integration branch.
- Local `main` is one commit behind origin (ab3b243, README newline). Fast-forward it.

## Not done

### 1. 33 unanswered adversarial-review findings (posted after each branch's last commit)

The pre-compaction summary claimed every comment was answered. It was not. An hourly
review job posted findings through 2026-08-22T16:00Z. None have replies or fixes.

| PR | Count | Themes |
|---|---|---|
| #110 | 1 | measurement->delete race in `replaceRangeWithMarkdown` (pin delete to measured revision) |
| #111 | 4 | base64-before-CRLF canonicalisation; >998-octet display names; empty-body blank line; fold single-space continuation (unresolved codex thread) |
| #112 | 24 | setup transport switching, doctor blind spots, shellQuote, token printing in Codex fallback, backup secret filter, Codex `mcp get` shape, confirmPublicPost draft mismatch, PROFILE path traversal, symlink log path, rotation drops 0600, `.env` disabling HTTP auth, allowed-origins hot change, troubleshoot after rotation, first-install auth failure, bearer-token change stranding, NO_AUTH convergence, LOG_FILE=0 killing JSONL, `stop` exit 0, NO_AUTH->auth swap, port collision error lost, ENDPOINT normalisation, multi-process rotation |
| #113 | 4 | 403 misread as unreadable folder; maxItems not stopping pagination (verify vs 5e91562); createDocument partial warning; shared-drive `corpora` |

Each: verify against code first (some may be already fixed or wrong), fix real ones,
reply naming the commit, resolve the thread.

### 2. 11 new issues, routed into the existing PRs

| Issue | Route | Note |
|---|---|---|
| #114 feedback title shell injection | #112 (same file, `dist/tools/index.js`) | use `execFile` with argv, never a shell string |
| #115 re-auth without `prompt=consent` | #113 | `dist/auth.js:245` |
| #116 draft QP double-decode strips `=` | #111 | reproduce first; `dist/mime.js` path |
| #117 link target != display text warning | #110 | readDocument markdown output |
| #118 exporter emits `**text **` | #110 | move trailing whitespace outside delimiters |
| #119 phantom staleness (empty diff) | #110 | check whether #108 range-precision guard already changes this |
| #120 modifyText bullets (`bulletPreset`) | #110 | createParagraphBullets / deleteParagraphBullets |
| #121 modifyText `clearStyle` + inherited-style report | #110 | |
| #122 readDocument overwrites mirror | #110 | check overlap with #106 work; refuse or back up |
| #123 exporter: blank line after list | #110 | |
| #124 copyFile ignores `name` | #113 | schema is `newName`; accept `name` too or rename |

### 3. Merge sequence (only after 1 and 2)

#109 -> #110 -> #111 -> #112 -> #113. After each: regenerate
`tests/fixtures/mcp-migration-inventory.json`, full suite, read the `Test Suites:` line.
Port `dc9b1ce` from `dev/live-testing`. Then #71 (`@googleapis/*` swap) as its own PR from
`stash@{0}`, last, because it rewrites every tool's imports.

### 4. Live testing

Blocked on Elliot: the dedicated Drive folder id, and `credentials.json` + `token.json` in
`~/.config/google-tools-mcp/`. Boundaries in SESSION-STATE.md. Checklist of seven manual
checks is there too.

### 5. Release

- #50 npm-publish environment protection: admin-only, Elliot must add a required reviewer
  before any `v*` tag is pushed. Zero rules today means a tag publishes with no gate.
- Bump to 3.0.0, finalise CHANGELOG (breaking: sessionful HTTP and `/sse` removed,
  `Mcp-Session-Id` ignored, `readHandle` on HTTP mutations, Zod v4, Node >= 20), docs
  sweep, RELEASING.md steps, tag.
- Final sweep: every open issue referenced by a merged PR or closed with a reason.

## Working rules carried forward

Codex-only delegation (terra default, luna quick fixes, sol hairy). Brief via Write tool,
stdin `-`. Verify every worker's diff and run gates myself. Reply to every review comment
and resolve the thread in the same pass.

---

## Merge rehearsal results (2026-08-29)

`feat/v3-integration` rebuilt from current heads and all four cluster branches merged:
**90 suites / 1287 tests green** at `3c60eec`. Heads proven to combine: docs `37a7686`,
gmail `8a112be`, ops `5c20ee8`, independents `4f76e3f`, on `docs/mcp-plan-client-evidence`
`45fc243`.

Conflicts and their resolutions, for reuse when merging on GitHub in order
#109 -> #110 -> #111 -> #112 -> #113:

| File | Resolution |
|---|---|
| `tests/fixtures/mcp-migration-inventory.json` | ALWAYS regenerate over the merged tree, after staging everything else. Never take a side. `git checkout --theirs`, `git add`, run the script, `git add` again. |
| `tests/toolRegistration.test.js` | Keep the ops branch's startup-timing and feedback-default assertions, at the docs branch's count of 160. Either side alone drops assertions or the count. |
| `dist/tools/docs/modifyText.js` | `normalizeEscapes(args.text)` from independents, plus the #14 default-colour and #121 inherited-style blocks from docs. |
| `dist/tools/drive/createDocument.js` | Union of both import sets. Catch block keeps the #87 document-id warning AND the `getBatchUpdateProgress` partial-apply branch, with the caught API error server-side only. Result keeps `warningNote: contentWarningNote ?? <docs generic text>` AND `readHandleNote`. Keep the `...(contentWarnings ?? [])` spread on both branches so an earlier colour warning is not clobbered. |
| `scripts/inventory-mcp-migration.mjs` | Take HEAD (`--exclude-standard`, which honours global and repo-local excludes) over `--exclude-from=.gitignore`. Keep the independents comment above the `ls-files` call; it is the only explanation of why `--others` is there. |
| `tests/modifyText.test.js`, `tests/packageContents.test.js` | Keep both sides' blocks in one file. packageContents ends with one import block, one `beforeAll` running `npm pack --dry-run --json` once, and four `it`s. |

### Two merge-induced test breaks that WILL recur on GitHub

Neither is a conflict, so git will not flag them. Both are a test mock on one branch meeting
a new import or code path on another:

1. `tests/authConsentFlow.test.js` (independents) mocks `fs/promises` with only
   `readFile`/`writeFile`/`mkdir`/`unlink`. The docs/migration side's `persistTokenCredentials`
   writes token.json atomically via `open` -> `writeFile` -> `sync` -> `rename` -> `chmod`,
   so the mock throws `TypeError: chmod is not a function`. Extend the mock with `chmod`,
   `rename`, and an `open` returning a handle that records into `writeFileCalls`.
2. `tests/createDocument.test.js` (independents) mocks
   `../dist/markdown-transformer/index.js` without `docsJsonToMarkdown`, which the #87
   read-seeding imports. The whole suite then fails to LINK, which reports zero failed tests
   and looks green. Add `docsJsonToMarkdown` to the mock and give the fake clients
   `documents.get` / `files.get` so seeding succeeds.

The second is the exact reason the standing rule is to read the `Test Suites:` line rather
than `Tests:`.

---

## PAUSE POINT 2 — 2026-08-29 evening, stopped for usage. Resume here.

Nothing lives only on this machine. No agents running, no monitors running.

**Codex Terra xHigh (`btfwj39t7`) was stopped mid-flight.** It had made uncommitted changes to
four files; I rescued them as commit `ae23783` on `verify/live-smoke-on-fixes`:

| File | What it was doing |
|---|---|
| `dist/googleDocsApiHelpers.js` (+11) | #14, threading default colour into the markdown write path |
| `dist/markdown-transformer/docsToMarkdown.js` (+50) | #106, list nesting |
| `tests/defaultTextColor.test.js` (+28) | #14 regression test |
| `tests/markdownRoundTrip.test.js` (+26) | #106 nested-list case |

**That WIP is UNVERIFIED.** No live run and no `npm test` was run against it. Do not trust it.
**#108 was never started.**

### To resume

Brief is still valid at `.planning/brief-docs-live-gaps-2.md`. Either resume the Codex session
with its context intact:

```
codex exec resume --last -C "C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-int" \
  -s workspace-write -m gpt-5.6-terra -c model_reasoning_effort="xhigh" \
  -c sandbox_workspace_write.network_access=true \
  -c sandbox_workspace_write.writable_roots='["C:/Users/2supe/.config/google-tools-mcp"]'
```
(session file: `~/.codex/sessions/2026/08/29/rollout-2026-08-29T23-35-44-01a050bc-*.jsonl`)

or dispatch fresh from the brief, telling it `ae23783` is unverified prior work it may keep,
discard, or redo.

First thing either way, before writing any code, is to establish where the WIP actually stands:

```
cd google-tools-mcp-int
npm test
GOOGLE_MCP_TEST_FOLDER_ID=15m5wq1pA8Mn0ETxIaLdN0kaUFwnrfzHN LOG_LEVEL=warn \
  node scripts/live-smoke.mjs issue-14-explicit-font-color issue-106-mirror-rewritten-list-structure issue-108-stale-guard-unrelated-change
```

Baseline to beat: `npm test` at 91 suites / 1295 tests, live at 19 passed / 3 failed of 22.

### #126, investigated and reframed — 2026-08-30

**The filed claim is not reproducible.** Those subfolders are genuinely empty. Evidence:

1. The symptom reproduces exactly: `{"folders": [], "files": []}` for the three named folders.
2. But three independent implementations agree they are empty: the depth-1 listing, the batched
   depth-2 traversal, and a separate third-party Drive client with its own auth token.
3. **Control passes.** `listFolderContents(depth: 2)` on My Drive returned 15 correct second-level
   folders with correct paths and `parentIds`. Recursion works.
4. My shared-drive-flags hypothesis was **wrong**. `dist/tools/drive/listFolderContents.js:71`
   already passes `supportsAllDrives` and `includeItemsFromAllDrives`, and the recursive path
   already scopes `driveId`, with a comment citing the Google doc on the `corpora='user'` trap.
5. The parent is named "Check and MAYBE DELETE" and now holds the Team Meeting 7 and 9 docs
   directly. The contents were moved out, which is what a recent `modifiedTime` reflects.

**The real defect it surfaced:** depth 1 passes `pageSize: maxResults`, takes one page, ignores
`nextPageToken`, and returns a bare `{folders, files}`. Proven live: `maxResults: 5` on a folder
holding hundreds returned exactly 5 with no truncation signal. Depth > 1 already reports
`truncated` / `truncationReason` / `unreadable` / `apiCalls`; depth 1 reported none of it. That
inconsistency is the reporter's actual stated harm.

Fixed on `feat/independents` as `b1b23a2`: `nextPageToken` added to the `fields` mask (without it
Drive never returns the token and the flag would always be false), plus additive `truncated` and
`truncationReason`, no auto-pagination, corrected `.describe()` text, three unit tests. Verified
independently: diff read, full suite run.

**Verdict: not a 3.0 blocker as filed.** Reply to #126 with this evidence and narrow it to the
truncation gap rather than closing outright.

### Flaky test found while verifying the above (task #54)

`tests/packageContents.test.js:11` throws `Exceeded timeout of 5000 ms` on roughly one full-suite
run in three. Not an assertion failure: it shells out to `npm pack --dry-run --json` with a
freshly `mkdtemp`'d npm cache, which blows Jest's 5s default under parallel load. Confirmed over
six runs, 4 green / 2 failed, same test each time. Stray untracked files ruled out as a cause.

This matters for the merge sequence below, which uses `npm test` as the gate after each of five
merges. A gate that reddens at random trains everyone to re-run until green.

---

## STATUS — 2026-08-30

Everything below is committed and pushed. Nothing lives only on this machine.

### Branch heads (all pushed)

| Branch | Head | State |
|---|---|---|
| `docs/mcp-plan-client-evidence` (#109) | `45fc243` | closed out |
| `feat/docs-cluster` (#110) | `eea7725` | **NOT mergeable — 3 live gaps open, see below** |
| `feat/gmail-cluster` (#111) | `078ba94` | closed out, #73 filenames now PASS live |
| `feat/ops-cluster` (#112) | `5c20ee8` | closed out, all 24 findings answered |
| `feat/independents` (#113) | `4f76e3f` | closed out |
| `feat/live-smoke` | `841a2a7` | scenarios recalibrated, **no PR opened yet (task #52)** |
| `verify/live-smoke-on-fixes` | `e205d93` | all five branches merged; 91 suites / 1295 tests green |

### Live smoke, run 2 — 2026-08-30T03-18-54 (journal in `google-tools-mcp-int/live-smoke-results/`)

**19 passed, 3 failed of 22**, up from 11/22 on run 1. Fourteen of the seventeen scenarios
that were expected-fail on base now pass, which is the calibration working as intended.
Cleanup trashed 28 of 28 created items, folder empty afterwards, 0 stdout leaks, 0 drafts left.

Confirmed fixed live since run 1: **#122** (mirror backup guard on the v2 handle path) and
**#73** (long non-ASCII attachment filename). **#105** and **#107** pass with their
recalibrated assertions.

Still failing, all Docs, all previously reported as FIXED with passing unit tests:

1. **#14** — `replaceDocumentWithMarkdown` writes runs with no `foregroundColor`. Confirmed by
   grep: `buildDefaultColorStyleRequest` is called from `appendToGoogleDoc`, `batchModifyText`,
   `insertTableWithData` and `modifyText`, and from no markdown write path.
2. **#106** — nested list sub-items lose their indent through the export/import round trip.
   The prior fix went onto the **export** side (`renderListItem` in `docsToMarkdown.js`); the
   loss may be on the import side. Determine which half before changing anything.
3. **#108** — a title-only rename still blocks an unrelated body edit, and reports
   `last modified` 1.4s **earlier** than `last read`. Guard is `dist/readTracker.js:244,257`.

**The lesson, twice over:** a passing unit test has now falsely certified a Docs fix on two
separate occasions. The gate for #110 is the live table, not `npm test`.

### Historical — run 1, 2026-08-29 (11 passed, 7 failed)

Kept for the reasoning trail.

Run it again with:
```
cd google-tools-mcp-int
GOOGLE_MCP_TEST_FOLDER_ID=15m5wq1pA8Mn0ETxIaLdN0kaUFwnrfzHN LOG_LEVEL=warn node scripts/live-smoke.mjs docs drive gmail
```
Journal from the last run: `google-tools-mcp-int/live-smoke-results/2026-08-29T15-47-14-742-3e7f.jsonl`

**Four real Docs gaps (task #49, brief at `.planning/brief-live-gaps-docs.md`, agent was
killed mid-way having produced nothing):**

1. **#122** — `backupIfLocallyModified()` only runs inside
   `if (!diffHandle && writeLocalFile)` in `dist/tools/docs/readGoogleDoc.js`. The v2
   read-handle path writes the mirror unguarded, so the reporter's exact repro still
   destroys the unpushed edit with no `.bak`. Hole in a fix committed today (`65deafa`).
2. **#14** — `replaceDocumentWithMarkdown` writes runs with no `foregroundColor`; the
   default-colour work only landed on `modifyText`. Check `appendMarkdown` and
   `replaceRangeWithMarkdown` too.
3. **#106** — nested list sub-items lose their indent through a mirror round trip. Distinct
   from #118/#123, which now pass.
4. **#108** — a title-only rename still blocks an unrelated body edit, and reports
   `last modified` earlier than `last read`. Same class as the #119 fix (`bf07ba0`), one
   level out: compare content and revision, not file metadata.

**One Gmail gap (task #50):** #73's non-ASCII subject passes, but a long non-ASCII
attachment filename returns as `Pr_sentation-du-partenariat-________-...`. RFC 2231
continuation encoding in `dist/mime.js` does not round-trip.

**Two scenario bugs, not product bugs (task #51):** #107 passes `range` where the parameter
is `target` (the tool's own `describe()` says "The range to replace", which likely misled the
author). #105 now refuses with a bounded `PublicToolError` instead of returning 1.36M chars,
which is arguably the correct fix, with the scenario still asserting the old shape.

### Resume order

1. Finish task #49 (four Docs gaps) — this is what blocks #110.
2. Task #50 (#73 filenames) on `feat/gmail-cluster`.
3. Task #51 (recalibrate two scenarios) on `feat/live-smoke`, then open its PR.
4. Re-run live smoke on a rebuilt `verify/live-smoke-on-fixes`; target is 0 disagreements
   with `expectedOnBase`.
5. Merge on GitHub in order #109 -> #110 -> #111 -> #112 -> #113, reusing the conflict
   resolutions recorded above.
6. #71 (`@googleapis/*`) as its own PR, last. Partial work in `stash@{0}` on the
   integration worktree.
7. Release: #50 environment protection (Elliot, admin-only), version bump, changelog, tag.

### To restart the monitor

Monitor task, persistent, 120s poll, one shared `scan()` for issues + PRs + issue comments +
review comments since a watermark that advances each cycle, filtering out `ElliotDrel` so my
own replies do not echo back as events.

## Merge-induced mock-factory breaks (found 2026-08-30)

After all five branches merged cleanly on `verify/live-smoke-on-fixes` (HEAD `f63cd12`, zero
conflict markers), `npm test` reported `Test Suites: 2 failed, 89 passed` with **zero failed
tests**. That gap is the whole finding: a Jest ESM suite that fails to *link* reports no failed
tests and reads as green on the `Tests:` line.

All of it is one mechanism. A `jest.unstable_mockModule` factory written on branch A supplies a
partial set of exports; branch B adds a new named import from that same module to the code under
test. Git merges both without a conflict because they are different files. The suite then either
throws `SyntaxError: does not provide an export named X` at link time, or the absent export
surfaces later as `TypeError: X is not a function`.

Three confirmed instances, all in files owned by `feat/independents` (#113, merges last):

| Missing export | Factory in | New import from |
|---|---|---|
| `fs/promises` -> `chmod` | `tests/authConsentFlow.test.js` (#115) | ops-cluster `dist/auth.js:172,176,191` (configDir 0o700, token.json 0o600) |
| `child_process` -> `execFile` | `tests/authConsentFlow.test.js` | ops-cluster `dist/shellSafe.js` browser opener (#125) |
| `markdown-transformer/index.js` -> `docsJsonToMarkdown` | `tests/createDocument.test.js` | docs-cluster `dist/tools/drive/createDocument.js` read-state seeding (#87) |

The `createDocument` one was already solved once, in `dc9b1ce` on the abandoned `dev/live-testing`
lineage: give the fake Docs client a real `documents.get` body rather than stubbing
`docsJsonToMarkdown`, correct the assertions to merged behaviour, and add the seeding test the path
never had. Ported by hand (the surrounding file moved), not cherry-picked.

45 mock factories exist across `tests/`. A factory missing an export on a path no test currently
drives fails silently until something changes, so the whole set gets swept, not just the two that
happened to fire.

**Rule for the real merge sequence:** adding a missing export to a mock factory is safe on
`feat/independents` today. Any assertion change that encodes *merged* behaviour (createDocument's
warning text comes from docs-cluster) fails on `feat/independents` standalone and can only land
after #110 and #112 are merged into it.

**Gate wording, restated:** read the `Test Suites:` line, never the `Tests:` line alone.

### Resolution (2026-08-30)

Repaired in `5e5d0e6` on `verify/live-smoke-on-fixes`. The `fs/promises` factory gained `chmod`
plus `open`/`rename` (ops-cluster writes the token atomically through a file handle, not a plain
`writeFile`), and now asserts configDir `0o700` and token.json `0o600` — coverage that fix had
nowhere else. The `child_process` factory gained `execFile` recording the argv, and the unreachable
`exec` recorder was removed. `createDocument.test.js` took the `dc9b1ce` approach: real
`documents.get` body, merged warning text, plus the seeding test the path never had.

Verified independently, not accepted on report: four consecutive full green runs
(`Test Suites: 91 passed, 91 total` / `Tests: 2 skipped, 1303 passed, 1305 total`), test count up
by one with nothing consolidated. A separate script compared all 56 factory calls across 45 files
against every named import of each mocked module anywhere in `dist/`; the 38 candidates it raised
all reduce to repo-wide imports vs per-test graph (a Docs test legitimately omits `getGmailClient`).
No real latent gap.

Residual note: `dist/setup.js` still imports `exec` from `child_process`, so if `auth.js` ever
transitively reaches `setup.js` that suite link-fails. It fails loudly at link time, so it is left
alone.

Live smoke on the merged tree, run `2026-08-30T14-32-04-674-afb4`: **22 passed, 0 failed**, cleanup
trashed 28 of 28, folder empty afterwards, 0 drafts left behind, 0 stdout leaks, 0 guard refusals
across 70 containment lookups. The 20 scenarios that disagreed with `expectedOnBase` are the point
of the harness (they fail on main and pass on the fix branches); both `expected-pass` scenarios
still pass, so nothing regressed.

The integration rehearsal is complete. Remaining gate before the merge sequence is the landing-split
decision recorded above.
