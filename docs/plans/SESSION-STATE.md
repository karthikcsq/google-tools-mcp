# Session state: pre-publish handoff for v3.0.0

Rewritten 2026-09-02 at the end of the pre-publish review pass. **The agent task list is the
first source of truth; this file is the durable backup of what would otherwise live only in
chat context.**

Everything in the 3.0.0 scope is on `main` plus one review PR from branch
`t3code/review-main-changes-npm-readiness`. What remains is landing that PR, one action only
Elliot can take (#50), then a tag, then publish. Delete this file once 3.0.0 is published.

---

## Where things stand

`main` = `a957677` (PR #140 merged). **One PR from this review pass must land before the
tag**: branch `t3code/review-main-changes-npm-readiness`, worktree
`C:\Users\2supe\.t3\worktrees\google-tools-mcp\t3code-55278c06`. It reviewed every change
merged on 2026-09-01 (`06f4ef0..a957677`: PR #139, commit 73ca178, PR #140) and fixes what
that review found. See "What the review pass fixed" below.

| Gate (at the head of the review branch) | State |
| --- | --- |
| `npm run test:ci` | 94 suites, 1381 passed, 2 skipped |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm pack --dry-run` | 184 files, 394.8 kB, no `tests/`, `live/`, `scripts/live-*`, `.husky`, `.planning` |
| Every `dist/**/*.js` imports | 181 modules, 0 failures |
| `package.json` version | 3.0.0 |
| `npm run live-coverage` | 29 covered / 131 not covered / 2 blocked by design, exit 0 |
| Live vs real API (2026-09-02) | `harness-selftest` PASS 3/3 cleaned; `verify-created-resource-tracking` PASS 2/2; `agent-loop-2-fixes` PASS 19 calls, 5/5 cleaned; `live-smoke` 22/22, 28/28 trashed, folder empty after, 0 drafts, 0 leaks, 0 refusals |
| Open PRs on origin | none yet (the review PR is opened at the end of this pass) |
| #50 protection rules | still `[]` as of 2026-09-02 |

## The one blocker

**#50** — the `npm-publish` GitHub environment still has `protection_rules: []`. No required
reviewer, so a publish would proceed with no human approval. **Only Elliot can set this**; it
is a repo-settings action, not code. `publish.yml` already has the `validate` job and the
environment-protection guard on the workflow side (#59, done). Nothing else blocks the tag
once the review PR is merged.

Verify with:
```bash
gh api repos/karthikcsq/google-tools-mcp/environments/npm-publish --jq '.protection_rules'
```
Non-empty means Elliot has done it.

## Final checks to run before the tag

Run in this order, on `main` after the review PR merges. Do not tag until every one is green.

1. `git fetch origin && git status --short && git rev-list --left-right --count main...origin/main` → clean, `0 0`
2. `npm ci` then `npm run test:ci` → 94 suites green. The `Test Suites:` line is authoritative, never `Tests:` alone.
3. `npm audit --omit=dev` → 0 vulnerabilities
4. `npm pack --dry-run` → 184 files; no `.husky`, no `live/`, no `scripts/live-*`, no `.planning`, no `tests/`
5. `node -p "require('./package.json').version"` → `3.0.0`
6. Set the CHANGELOG heading `## 3.0.0 - 2026-08-31` to the actual publish date.
7. `npm run live-mission -- live/missions/agent-loop-2-fixes.mjs` → PASS, 0 frictions, cleanup 5/5,
   "sandbox 0 item(s) after cleanup". The runner takes a path; the bare mission name does not
   work. Then `npm run live-mission -- live/missions/verify-created-resource-tracking.mjs` →
   PASS, cleanup 2/2, exit 0.
8. `npm run live-coverage` → exits 0. Expect 29 covered / 131 not covered / 2 blocked by design.
9. Confirm #50 is set (command above).

Then: tag `v3.0.0`, push the tag, Elliot approves the environment gate, publish runs, and the
last step is verifying the published tarball actually contains what step 4 predicted, and that
`npx -y google-tools-mcp@3.0.0 doctor` on a machine with Codex or Claude Code installed gets
past client inspection (the #14 bug below never showed in CI because CI has neither client).

## What the review pass fixed (branch `t3code/review-main-changes-npm-readiness`)

Everything below shipped on `main` with a green suite. Each has a test now, and each test was
checked by mutation (break the fix, watch exactly the new test fail).

| Finding | Severity | Where |
| --- | --- | --- |
| `setup` and `doctor` could not finish on any machine with Codex or Claude Code installed: a "not found" CLI failure was mapped to `unknown`, and the Claude Code probe used `-s user --json`, which no `claude` version accepts. Claude Code user-scope inspection now reads `~/.claude.json`. | BLOCKER | `dist/clientAdapters.js`, `tests/setupIdempotency.test.js` |
| `doctor` flagged every README-documented registration (bare bin, `npx -y google-tools-mcp`, clone path) as "entry differs from recommended configuration", exit 1. Now `configured` + note when the entry launches this package; Codex without `CODEX_MCP_PROTOCOL_VERSION` stays a named problem. | HIGH | `dist/setupInspect.js`, `dist/doctor.js`, `tests/doctorSetupInspection.test.js` |
| Update check hit the npm registry on every launch (`readFile`/`writeFile`/`mkdir` had no defaults, so the cache never read or wrote). | HIGH | `dist/updateCheck.js`, `tests/updateCheck.test.js` |
| `help tool=X` rendered the output-io JSON Schema: 50 of 160 tools showed `.default()` fields as required. Pinned to the SDK's `tools/list` rendering for every tool. | HIGH | `dist/tools/index.js`, `tests/toolRegistration.test.js` |
| Auth: an abandoned flow could release a newer latch after logout; a flow running at logout could install its client afterwards; a cold request mid re-authorization opened a second consent screen. Identity guard + `authGeneration` + `ensureAuth` joins `reauthInFlight`. | MEDIUM | `dist/clients.js`, `tests/authConcurrency.test.js` (9 tests) |
| `doctor --json` printed `"args": "[Circular]"` for any shared (non-cyclic) reference. Redactor now tracks ancestors only. | LOW | `dist/errors.js`, `tests/errorsAndLogger.test.js` |
| Live harness: two copies of the cleanup loop, both reporting already-deleted files as left behind, both crashing on a null raw Drive handle after an `invalid_grant` rebuild; blocked outcomes uncounted; no post-cleanup listing; `--keep` printed no ids; `track()` double-counted. One shared `scripts/live-smoke/cleanup.mjs`, leftover listing fails the run, `--keep` prints the cleanup command. | MEDIUM | `scripts/live-smoke/cleanup.mjs`, `scripts/live-mission.mjs`, `scripts/live-smoke.mjs`, `scripts/live-smoke/context.mjs` |
| Live harness: frozen loop-1/loop-2 missions hard-failed on fixed code (moved to `live/missions/archive/`); `verify-preserve-heading` probe 3 reported false friction; `live-coverage` missed `ctx.createDoc`/`createFolder` helpers and single-quoted names, and had a hand-maintained guard-denied list (now derived from `guard.mjs`, `MUTATING_VERB` exported); the created-resource pin test compared literals (now executes all 8 creating tools). | LOW | `live/missions/`, `scripts/live-coverage.mjs`, `scripts/live-smoke/guard.mjs` (export only), `tests/liveHarnessCreatedResource.test.js` |
| `live-mission` report `account` was always null. | LOW | `scripts/live-mission.mjs` |
| README Step 3 Codex commands omitted `--env CODEX_MCP_PROTOCOL_VERSION=2026-07-28`, which the same README's breaking-change section says Codex needs. | DOC | `README.md` |

Evaluated and closed without change: `createSpreadsheet`/`copyFile` seed Sheets read state
that is request-scoped on HTTP. Neither tool claims the Sheet is mutable afterwards and the
guard's HTTP branch already says Sheets edits are stdio-only, so a warning would be noise.

## Open issues, all accounted for

| Issue | Disposition |
| --- | --- |
| [#50](https://github.com/karthikcsq/google-tools-mcp/issues/50) | **The blocker.** Elliot's repo-settings action. |
| [#130](https://github.com/karthikcsq/google-tools-mcp/issues/130) | Ruled deferred to 3.0.x on 2026-09-01, both halves. Order when resumed: (1) husky + pre-push `test:ci`, (2) linter selection + repo-wide reformat of the 181 `dist/` files + `lint-staged`, as its own PR. |
| [#136](https://github.com/karthikcsq/google-tools-mcp/issues/136) | #87 criterion 2 follow-up. Scoped, not a blocker. |
| [#137](https://github.com/karthikcsq/google-tools-mcp/issues/137) | #87 criterion 5 follow-up. Scoped, not a blocker. |
| [#138](https://github.com/karthikcsq/google-tools-mcp/issues/138) | #87 criterion 6 follow-up. Scoped, not a blocker. |

## What landed before this pass (PR #139, 73ca178, PR #140)

PR #139: the live agent loop, plus five defects it found, all of which had shipped with a
fully green suite because each sits at a boundary a mock cannot reach (`format='index'` field
mask rejected by Google; `#000001` colour sentinel echoed by the markdown reader; `modifyText`
union error dump; `formatCells` empty-options message; `help` returning the whole README).
PR #140: OAuth `state` + PKCE, `EADDRINUSE` on the callback port, `/healthz` after close,
auth latch, shared `createdResource.mjs`. A claim that `publish.yml` needs `actions: read`
was **disproven** (public repo, environments endpoint reads unauthenticated); do not add it.

## Standing rules that must survive compaction

- **Verify every subagent claim independently before accepting it.** This caught a missing
  manifest-floor bump on #129, and it is why the #139 "data loss" report was correctly
  reclassified as a reader bug instead of a release blocker.
- **Live testing runs against Elliot's real Google account.** Every write is confined to Drive
  folder `15m5wq1pA8Mn0ETxIaLdN0kaUFwnrfzHN` ("google-tools-mcp live smoke (safe to delete)").
  Never call any Gmail send or draft-send path. Never trash anything the run did not create.
  **Never disable, weaken, or work around any check in `scripts/live-smoke/guard.mjs`.**
- A broader filesystem search for credentials was **denied by Elliot**. Do not retry it.
- `dist/` is the source of truth. There is no `src/` tree, no build, no lint/typecheck script (#130).
- Never interpolate a caught error's message into `publicError()`.
- Jest runs as ESM via `node --experimental-vm-modules node_modules/jest/bin/jest.js`;
  `jest.unstable_mockModule` before a dynamic import is the mocking pattern.
- `doctor`'s `checkLaunchTarget` stats absolute launch paths on the real filesystem; tests
  that need an absolute path must create the file (see `withRealFiles` in
  `tests/doctorSetupInspection.test.js`).
- `.env.live-smoke` is gitignored; copy it from the main checkout into a new worktree.
- Two Bash commands were blocked by the auto-mode classifier: `gh pr merge` and a bulk
  `git worktree remove --force` loop. Hand Elliot the merge command rather than routing around
  the denial.

## Recovery references

Deleted during cleanup on 2026-09-01, all verified to contain nothing `main` lacks (zero files
added; each would only delete 10k–20k lines):

```
feat/v3-integration        3c60eecac37275c38800f2befdd241d051914ef2
dev/live-testing           82827091505544abf6fd8dec5c0353c489cecdb1
verify/live-smoke-on-fixes 5e5d0e6ffcb51d84b573e7b605f8fbf5e584ec6f
stash@{0} (WIP #71)        5579ea3f2a7e470047466ce067dade9c40ca042c
```

`Google-Tools-MCP/stash71.patch` (41,332 bytes, outside the repo) is a second copy of that
stash; its 20-file set was diffed against the stash before the stash was dropped.

16 branches remain on `origin`, untouched. Two were never reviewed:
`agent/documentation-coverage` and `fix/releasing-verify-command`.
