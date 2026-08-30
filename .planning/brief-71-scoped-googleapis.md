# Issue #71: replace the umbrella `googleapis` package with per-API `@googleapis/*` packages

Work only in `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-71`, branch
`feat/scoped-googleapis`, cut from `main` at `5756259`.
**Do not push. Do not touch any other worktree. Do not post to GitHub.**
Read `.planning/constraints.md` in the main worktree first, with two corrections that
override it for this task:

1. **You DO have network access here**, despite what `constraints.md` line 22 says. That line is
   written for sandboxed runs; this one is not sandboxed that way. `npm` works. `gh` is still
   off limits because nothing here touches GitHub.
2. **All ten `@googleapis/*` packages are already installed** in this worktree, along with the
   updated `package.json` and `package-lock.json`. A previous run correctly refused to proceed
   when they were absent rather than fabricate a lockfile. They are present now: verify with
   `node -e "console.log(Object.keys(require('./package.json').dependencies))"` before starting.

`googleapis` is deliberately still installed so both sets can coexist while you work. Removing it
is part of your job (see below).

## Why

`googleapis` ships client definitions for every Google API. This server uses nine. Measured on the
issue: 196 MB / 1,823 files versus 5.6 MB / 74 for the scoped equivalents, and about 3 seconds of
extra import time per launch. `npx` re-verifies the tree per file on every start, so the file count
matters as much as the bytes. This is the largest single cause of slow startup (#46), and Claude
Code's stdio MCP connect timeout is a fixed 30 seconds.

The scoped packages are published by the same team from the same source and take the same auth
objects, so call sites change shape but not behaviour.

## Exactly what imports the module today

Only five runtime files and three test files actually import `googleapis`. Everything else that
greps for the string is a scope URL (`https://www.googleapis.com/auth/...`), a hostname
(`docs.googleapis.com`), or a comment. **Do not touch those.**

| File | What it uses |
|---|---|
| `dist/clients.js` | `google.docs/drive/sheets/script/gmail/calendar/forms/slides/tasks` |
| `dist/tools/index.js` | `google.drive`, `google.gmail`, `google.calendar` |
| `dist/setup.js` | `google.serviceusage` |
| `dist/auth.js` | `new google.auth.OAuth2(...)` only |
| `dist/setupInspect.js` | `google.auth.OAuth2` as a default parameter only |
| `tests/authConsentFlow.test.js` | mocks `'googleapis'` |
| `tests/legacyAliasAuthRetry.test.js` | mocks `'googleapis'` |
| `tests/publicErrorBoundary.test.js` | mocks `'googleapis'` |

## How the swap works

Each scoped package exports a factory named after the API:
`import { docs } from '@googleapis/docs'` then `docs({ version: 'v1', auth: authClient })`,
replacing `google.docs({ version: 'v1', auth: authClient })`. Same options object, same return.

Ten packages are needed: `docs`, `drive`, `sheets`, `script`, `gmail`, `calendar`, `forms`,
`slides`, `tasks`, `serviceusage`.

**`auth.js` and `setupInspect.js` should drop `googleapis` entirely rather than gain a scoped
package.** `google.auth.OAuth2` is `OAuth2Client` re-exported from `google-auth-library`, which is
already a direct dependency at `^10.5.0`. Import `OAuth2Client` from there. Verify that claim
against the installed packages before relying on it; if the constructor signature or behaviour
differs in any way that matters, say so and stop rather than papering over it.

When you are done, `googleapis` must be gone from `package.json` dependencies and from every
`import`. `grep -rn "from 'googleapis'" dist tests scripts live` must find nothing.

## The test mocks are the trap

Three suites mock `'googleapis'` with a shape like `{ google: { auth: { OAuth2: MockOAuth2 } } }`.
Once the runtime imports `OAuth2Client` from `google-auth-library` instead, those mocks target a
module nobody imports any more and the real client would be constructed during tests.

`tests/authConsentFlow.test.js` **already** mocks `google-auth-library` (currently
`{ JWT: class {} }`). Merging the OAuth2 mock into that existing factory rather than adding a second
one is required — two factories for the same module is not a thing.

We were bitten today by exactly this class: a mock factory that supplies a partial export set while
the code under test imports a name it does not provide. That fails at *link* time with
`SyntaxError: does not provide an export named X`, and a suite that fails to link reports **zero
failed tests**. Read the `Test Suites:` line, never `Tests:` alone. Whatever the runtime imports
from `google-auth-library`, the factory must export.

## A stale reference, not a starting point

`stash@{0}` in the `google-tools-mcp-int` worktree holds an earlier attempt
(`git stash show -p 'stash@{0}'`, prefix `MSYS_NO_PATHCONV=1`). It predates all six merges, so it
will not apply, and it also contains unrelated `withAuthRetry` changes that landed differently.
Read it for the shape of the `clients.js` rewrite if useful. Do not try to apply it.

## Also update

- **Remove `googleapis`** with `npm uninstall googleapis`, which updates both `package.json` and
  `package-lock.json` for real. Do this only after the code no longer imports it, so you can run
  the suite before and after and see exactly what the removal breaks.
- `tests/fixtures/mcp-migration-inventory.json`, regenerated:
  `node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json > /dev/null`
- `docs/startup-performance.md` and `docs/architecture.md` if they name the umbrella package.
- `CHANGELOG.md` if one exists with an unreleased section.

## Measurements are already done — do not redo them

I measured both sides in this worktree, three runs each:

| | umbrella `googleapis` | the ten scoped packages |
|---|---|---|
| installed size | 195 MB | 8.1 MB |
| file count | 1,823 | 148 |
| cold `import()` | 1054 / 1112 / 1203 ms | 149 / 139 / 158 ms |

Method: `du -sh` plus a recursive `find -type f | wc -l` for size, and a fresh Node process with
`process.hrtime.bigint()` around the import(s) for time. The issue quotes 196 MB -> 5.6 MB and
5200 ms -> 2213 ms; those were five packages on a colder machine. Use my numbers, not the issue's,
in any doc you update, and say they were measured on 2026-08-30.

Your job is the code, not the benchmark.

## Gates

- `grep -rn '<<<<<<<\|>>>>>>>' dist tests scripts live` finds nothing.
- `npm test` run **twice**, both fully green. Report both `Test Suites:` and both `Tests:` lines.
- Tool count stays **160** default / **232** aliases-enabled.
- **No test count is a target.** Never consolidate, delete, weaken or skip a test to reach a number.
- Commit on `feat/scoped-googleapis` with a message naming the mechanism. Do not push.

## Report

Per file changed, one line on what changed. Then both test-run lines, the measurements, and
anything you judged rather than mechanically translated. Call out anything you suspect is wrong but
left alone.
