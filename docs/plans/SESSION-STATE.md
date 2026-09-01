# Session state: pre-publish handoff for v3.0.0

Written 2026-09-01, immediately before a context compaction. **The agent task list is the
first source of truth; this file is the durable backup of what would otherwise live only in
chat context.**

Everything in the 3.0.0 scope is done and on `main`. What remains is one action only Elliot
can take, then a tag, then publish. Delete this file once 3.0.0 is published.

---

## Where things stand

`main` = `73ca178`. **One PR is open and must land before the tag:**
[#140](https://github.com/karthikcsq/google-tools-mcp/pull/140), six fixes from the pre-tag
adversarial review (OAuth port hang, OAuth `state` + PKCE, `/healthz` after close, auth
concurrency latch, the live-harness cleanup and coverage gaps, three code/doc contradictions).
A seventh claim in that review — that `publish.yml` needs `actions: read` — was **disproven**:
the repo is public and the environments endpoint reads unauthenticated, so the workflow is
correct as written. Do not add that permission on the strength of the review.

| Gate | State |
| --- | --- |
| `npm test` | 94 suites, 1350 passed, 2 skipped |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `package.json` version | 3.0.0 |
| CHANGELOG 3.0.0 section | complete, incl. #129 dependency security work |
| Live regression vs real API | `agent-loop-2-fixes` PASS, 0 frictions, all artifacts cleaned |
| Open PRs | none |
| Worktrees / branches / stashes | 1 / `main` only / none |

## The one blocker

**#50** — the `npm-publish` GitHub environment still has `rules: []`. No required reviewer,
so a publish would proceed with no human approval. **Only Elliot can set this**; it is a
repo-settings action, not code. `publish.yml` already has the `validate` job and the
environment-protection guard on the workflow side (#59, done). Nothing else blocks the tag.

Verify with:
```bash
gh api repos/karthikcsq/google-tools-mcp/environments/npm-publish --jq '.protection_rules'
```
Non-empty means Elliot has done it.

## Final checks to run after compaction, before the tag

Run in this order. Do not tag until every one is green.

1. `git fetch origin && git status --short && git rev-list --left-right --count main...origin/main` → clean, `0 0`
2. `npm ci` then `npm test` → 94 suites green. The `Test Suites:` line is authoritative, never `Tests:` alone.
3. `npm audit --omit=dev` → 0 vulnerabilities
4. `npm pack --dry-run` → confirm the tarball matches `files: ["dist", "!dist/**/*.test.js"]`; no
   `.husky`, no `live/`, no `scripts/live-*`, no `.planning`, no `tests/`
5. `node -p "require('./package.json').version"` → `3.0.0`
6. `npm run live-mission -- live/missions/agent-loop-2-fixes.mjs` → PASS, 0 frictions, cleanup 5/5
   and `npm run live-mission -- live/missions/verify-created-resource-tracking.mjs` → PASS,
   cleanup 2/2, exit 0. Then confirm the sandbox folder is empty:
   `npm run live-call -- listFolderContents folderId=15m5wq1pA8Mn0ETxIaLdN0kaUFwnrfzHN`
7. `npm run live-coverage` → runs, exits 0 (non-zero means a scenario calls a tool that no
   longer exists). Expect 28 covered / 132 not covered / 2 blocked by design.
8. Confirm #50 is set (command above)

Then: tag `v3.0.0`, push the tag, Elliot approves the environment gate, publish runs, and the
last step is verifying the published tarball actually contains what step 4 predicted.

## Open issues, all accounted for

| Issue | Disposition |
| --- | --- |
| [#50](https://github.com/karthikcsq/google-tools-mcp/issues/50) | **The blocker.** Elliot's repo-settings action. |
| [#130](https://github.com/karthikcsq/google-tools-mcp/issues/130) | Ruled deferred to 3.0.x on 2026-09-01, both halves. Order when resumed: (1) husky + pre-push `test:ci`, (2) linter selection + repo-wide reformat of the 181 `dist/` files + `lint-staged`, as its own PR. |
| [#136](https://github.com/karthikcsq/google-tools-mcp/issues/136) | #87 criterion 2 follow-up. Scoped, not a blocker. |
| [#137](https://github.com/karthikcsq/google-tools-mcp/issues/137) | #87 criterion 5 follow-up. Scoped, not a blocker. |
| [#138](https://github.com/karthikcsq/google-tools-mcp/issues/138) | #87 criterion 6 follow-up. Scoped, not a blocker. |

## What landed in PR #139 (the last one)

The live agent loop, plus five defects it found. All five had shipped with a fully green
suite, because each sits at a boundary a mock cannot reach.

- `readDocument(format='index')` was rejected for **every** document. `Document.lists` is a
  `map<string, List>` and Google's field-mask syntax forbids sub-selecting into map values.
  Every Docs test mocks `documents.get`, and a mock cannot validate a field mask.
- `readDocument(format='markdown')` wrapped every run in `<span style="color:#000001">`. That
  is the #14 explicit-default-black sentinel, echoed back as author intent, which made
  read-back verification impossible. **The write was always correct** — an agent chased a
  phantom data-loss bug through three documents and seven calls because of it.
- `modifyText` rejected a wrong-shaped `target` with an unreadable union dump.
- `formatCells` said "at least one formatting option must be provided" to a caller who passed
  a full nested `CellFormat`.
- `help` returned the whole 39,279-character README on every call; now takes `tool=<name>`
  and `listTools=true`.

## Standing rules that must survive compaction

- **Verify every subagent claim independently before accepting it.** This caught a missing
  manifest-floor bump on #129, and it is why the #139 "data loss" report was correctly
  reclassified as a reader bug instead of a release blocker.
- **Live testing runs against Elliot's real Google account.** Every write is confined to Drive
  folder `15m5wq1pA8Mn0ETxIaLdN0kaUFwnrfzHN` ("google-tools-mcp live smoke (safe to delete)").
  Never call any Gmail send or draft-send path. Never trash anything the run did not create.
  **Never disable, weaken, or work around any check in `scripts/live-smoke/guard.mjs`.**
- A broader filesystem search for credentials was **denied by Elliot**. Do not retry it.
- `dist/` is the source of truth. There is no `src/` tree.
- Never interpolate a caught error's message into `publicError()`.
- Two Bash commands were blocked by the auto-mode classifier this session: `gh pr merge` and a
  bulk `git worktree remove --force` loop. Individual non-force `git worktree remove` calls
  were fine. If `gh pr merge` is needed again, hand Elliot the command rather than routing
  around the denial.

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
