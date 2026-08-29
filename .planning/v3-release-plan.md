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
