# Session state: pre-publish handoff (next tag: the version at the top of CHANGELOG.md)

Rewritten 2026-09-02 during the final pre-publish gate pass. **The agent task list is the
first source of truth; this file is the durable backup of what would otherwise live only in
chat context.** Delete this file once the release is published.

Elliot's standing instruction for this pass: do everything up to, but not including, pushing
the `v*` tag. Merging is allowed. Only Elliot clears #50, and no tag is pushed before he does.

---

## Where things stand

`main` = `55d8c65` (PR #143 merged 2026-09-02). Work in flight is on branch
`t3code/release-readiness` in worktree
`C:\Users\2supe\.t3\worktrees\google-tools-mcp\t3code-55278c06`, going out as PR #144.

Versioning changed on 2026-09-02: `CHANGELOG.md` now has one entry per merged PR with its own
semantic version (Elliot's convention; "it's OK if we end up at a different version than 3").
The chain runs 2.0.0 (published) -> 2.0.1 ... 3.4.2 (already on `main`, never published) ->
3.4.3 (PR #144). `package.json` moves 3.0.0 -> 3.4.3 in PR #144. Every later PR adds its own
entry and bumps `package.json` to it (RELEASING.md, "Release a version").

| Gate (head of `t3code/release-readiness`, 2026-09-02) | State |
| --- | --- |
| `npm run test:ci` | 96 suites, 1419 passed, 2 skipped |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm pack --dry-run` | 185 files, 396.6 kB; no `tests/`, `live/`, `scripts/live-*`, `.husky`, `.planning` |
| `package.json` version | 3.4.3 |
| `npm run live-coverage` | 31 covered / 129 not covered / 2 blocked by design, exit 0 |
| Live vs real API (2026-09-02) | `verify-comment-collateral` PASS 15 calls (1 intended block refusal), 1/1 cleaned, sandbox 0 after; earlier the same day on `main`: `harness-selftest` PASS, `verify-created-resource-tracking` PASS, `agent-loop-2-fixes` PASS, `live-smoke` 22/22 with 0 leftovers |
| #50 protection rules | still `[]` as of 2026-09-02 |

## What PR #144 carries

1. **Fix: comment tools left the tracked Docs revision stale.** `addComment`, `replyToComment`,
   `resolveComment`, `updateComment`, `deleteComment` each advance the Docs `revisionId` while
   Drive `modifiedTime` stays identical (measured live with a scratch probe: modifiedTime
   `2026-09-02T19:53:11.311Z` before and after all three, Drive `version` 3 -> 4). The tracker
   only compares `modifiedTime`, so the next `appendText`/`replaceDocumentWithMarkdown` went out
   with the pre-comment `requiredRevisionId` and Google refused it ("changed since you last read
   it"). Fix: `readTracker.refreshRevision()` + `dist/tools/docs/comments/trackedRevision.js`,
   called after each successful comment write when the doc is tracked in-session. Content and
   modifiedTime are kept. A failed probe keeps the old revision (fails closed).
   Tests: `tests/commentRevisionRefresh.test.js`. Live: `live/missions/verify-comment-collateral.mjs`
   asserts a body write after each of the five tools succeeds with no re-read.
2. **CHANGELOG restructure** (subagent, verified: all 121 old paragraphs present verbatim except
   the 5 the split deliberately re-wrapped; chain order matches `git log --first-parent`).
3. `package.json`/lock 3.4.3, RELEASING.md per-PR convention, this file.

Not fixed, filed as a follow-up (see "Open issues"): a **collaborator's** comment made in the
Docs UI moves the revision the same way, and nothing in-process can see it, so the next write
reports the same conflict and a re-read clears it. The message is correct; it is just one round
trip more than necessary.

## The one blocker

**#50**: the `npm-publish` GitHub environment still has `protection_rules: []`. **Only Elliot
can set this**; it is a repo-settings action. `publish.yml`'s `validate` job fails closed if the
gate is missing (since 3.3.3 / PR #132).

```bash
gh api repos/karthikcsq/google-tools-mcp/environments/npm-publish --jq '.protection_rules'
```

## Final checks to run before the tag

On `main` after every PR below has merged. Do not tag until every one is green.

1. `git fetch origin && git status --short && git rev-list --left-right --count main...origin/main` -> clean, `0 0`
2. `npm ci` then `npm run test:ci` -> all suites green. The `Test Suites:` line is authoritative.
3. `npm audit --omit=dev` -> 0 vulnerabilities
4. `npm pack --dry-run` -> no `.husky`, `live/`, `scripts/live-*`, `.planning`, `tests/`
5. `node -p "require('./package.json').version"` equals the top `## [X.Y.Z]` in CHANGELOG.md,
   and that entry's date is the publish day.
6. `npm run live-mission -- live/missions/agent-loop-2-fixes.mjs`,
   `live/missions/verify-created-resource-tracking.mjs`, `live/missions/verify-comment-collateral.mjs`,
   `live/missions/harness-selftest.mjs` -> each PASS, "sandbox 0 item(s) after cleanup".
   `npm run live-smoke` -> all scenarios pass, folder empty after, 0 drafts left.
7. `npm run live-coverage` -> exit 0.
8. Confirm #50 is set (command above).

Then: `git tag vX.Y.Z && git push origin vX.Y.Z`, Elliot approves the environment gate, publish
runs, then the RELEASING.md "After a release" tarball check, plus `npx -y google-tools-mcp@X.Y.Z
doctor` on a machine with Codex or Claude Code installed (CI has neither client).

## Open issues, dispositions from the 2026-09-02 triage

| Issue | Disposition |
| --- | --- |
| [#50](https://github.com/karthikcsq/google-tools-mcp/issues/50) | **The blocker.** Elliot's repo-settings action. |
| [#141](https://github.com/karthikcsq/google-tools-mcp/issues/141) | Fixed on `main` since #86 (PR #110): `listComments` field mask includes `replies(...)` and `replyCount` is derived from it. Confirmed live 2026-09-02 by `issue-86-comment-reply-awareness` and `verify-comment-collateral`. Close with the evidence. |
| [#142](https://github.com/karthikcsq/google-tools-mcp/issues/142) | Suggestion 2 (warn at push time) shipped in #88 (PR #110): `replaceDocumentWithMarkdown` names every unresolved comment anchor it removes, `onCollateral='block'` refuses, `dryRun` previews. Confirmed live 2026-09-02. Suggestion 1 (listComments flags orphaned threads) not built: Drive keeps the thread record and its `quotedFileContent` after the anchor is gone, so the only way to detect an orphan is to search the current body for the quoted text, which false-positives on any repeated sentence. Close: the push-time warning is the signal. |
| [#136](https://github.com/karthikcsq/google-tools-mcp/issues/136) | Out of scope for this release, flagged. #119 already handles a backwards `modifiedTime` (keeps the newer baseline, warns, lets the WriteControl revision guard the write). New data point for whoever builds it: comment writes move `revisionId` with `modifiedTime` unchanged, so "revision moved, timestamp did not" is a coherent transition, not an incoherent one. |
| [#137](https://github.com/karthikcsq/google-tools-mcp/issues/137) | Out of scope for this release, flagged: a workspace-path refactor of two tools with a concurrency test, not a bug in shipped behaviour. |
| [#138](https://github.com/karthikcsq/google-tools-mcp/issues/138) | Relevant and cheap: CONTRIBUTING.md. Being written on its own branch/PR after #144 merges (entry 3.4.4). |
| [#130](https://github.com/karthikcsq/google-tools-mcp/issues/130) | Elliot ruled it deferred on 2026-09-01. Flagged, untouched. |
| follow-up (to file) | Collaborator UI comment -> next write reports a revision conflict until re-read. Also note the handle path: `docsHandles.guardTargets` re-arms on a revision-only change when targets are given, but a target-less write (`replaceDocumentWithMarkdown` over HTTP) still conflicts. |

## Standing rules that must survive compaction

- **Verify every subagent claim independently before accepting it.** The CHANGELOG subagent's
  "no bullet dropped" claim was re-checked by script (121 paragraphs), and its chain order was
  re-checked against `git log --first-parent v2.0.0..origin/main`.
- **Live testing runs against Elliot's real Google account.** Every write is confined to Drive
  folder `15m5wq1pA8Mn0ETxIaLdN0kaUFwnrfzHN` ("google-tools-mcp live smoke (safe to delete)").
  Never call any Gmail send or draft-send path. Never trash anything the run did not create.
  **Never disable, weaken, or work around any check in `scripts/live-smoke/guard.mjs`.**
- A broader filesystem search for credentials was **denied by Elliot**. Do not retry it.
- `dist/` is the source of truth. There is no `src/` tree, no build, no lint/typecheck script (#130).
- Never interpolate a caught error's message into `publicError()`.
- Jest runs as ESM via `node --experimental-vm-modules node_modules/jest/bin/jest.js`;
  `jest.unstable_mockModule` before a dynamic import is the mocking pattern. A new test file must
  be added to `tests/fixtures/mcp-migration-inventory.json`; a new `dist/` module changes that
  fixture too: regenerate with
  `node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json`.
- `doctor`'s `checkLaunchTarget` stats absolute launch paths on the real filesystem; tests
  that need an absolute path must create the file (see `withRealFiles` in
  `tests/doctorSetupInspection.test.js`).
- `.env.live-smoke` is gitignored; copy it from the main checkout into a new worktree.
- Do not add `actions: read` to `publish.yml` (public repo, the environments endpoint reads
  unauthenticated). Do not strip `pid` from `/healthz` (`httpLifecycle.js` compares it to the
  state file). Do not revert the `#000001` suppression. OAuth `state` mismatch deliberately
  ignores the callback.
- `gh pr merge` was blocked by the auto-mode classifier in an earlier thread; in this thread
  Elliot authorised merging explicitly.

## Recovery references

Deleted during cleanup on 2026-09-01, all verified to contain nothing `main` lacks:

```
feat/v3-integration        3c60eecac37275c38800f2befdd241d051914ef2
dev/live-testing           82827091505544abf6fd8dec5c0353c489cecdb1
verify/live-smoke-on-fixes 5e5d0e6ffcb51d84b573e7b605f8fbf5e584ec6f
stash@{0} (WIP #71)        5579ea3f2a7e470047466ce067dade9c40ca042c
```

Remote branch `t3code/review-main-changes-npm-readiness` (PR #143, merged) can be deleted once
nothing checks it out.
