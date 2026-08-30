# Repair the merge-induced mock-factory breaks on the integration branch

Work only in `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-int`, branch
`verify/live-smoke-on-fixes`. **Do not push. Do not touch any other worktree. Do not post to GitHub.**
Read `.planning/constraints.md` in the main worktree first.

All five v3 branches are merged here with zero conflict markers. `npm test` reports
`Test Suites: 2 failed, 89 passed` while `Tests:` shows only assertion failures in those same two
files. There are uncommitted edits in the worktree from a first pass at this; treat them as a
starting point to be corrected, not as finished work.

## The root cause (already diagnosed — confirm it, don't re-derive it)

Every failure is one class: a `jest.unstable_mockModule` factory written on branch A supplies a
*partial* set of exports, and branch B added a new named import from that same module to the code
under test. Git merges both cleanly because they are different files. The suite then either fails
to *link* (`SyntaxError: does not provide an export named X`) or the missing export shows up as a
`TypeError: X is not a function` at runtime. Three confirmed instances:

| Missing export | Factory lives in | New import introduced by |
|---|---|---|
| `fs/promises` -> `chmod` | `tests/authConsentFlow.test.js` (#115, independents) | ops-cluster: `dist/auth.js:172,176,191` chmods configDir 0o700 and token.json 0o600 |
| `child_process` -> `execFile` | `tests/authConsentFlow.test.js` | ops-cluster: `dist/shellSafe.js` browser opener (#125) |
| `markdown-transformer/index.js` -> `docsJsonToMarkdown` | `tests/createDocument.test.js` | docs-cluster: `dist/tools/drive/createDocument.js` read-state seeding (#87) |

## What to do

### 1. `tests/createDocument.test.js` — port the existing fix, do not reinvent it

Commit `dc9b1ce` on the local branch `dev/live-testing` already solved exactly this collision in an
earlier integration attempt. Read it (`git show dc9b1ce`) and port it. It is better than what is
currently uncommitted in the worktree: instead of stubbing `docsJsonToMarkdown` and leaving
`documents.get` absent (which makes seeding fail on *every* case and pollutes the asserted output
with a degraded-seeding warning), it gives the fake Docs client a realistic `documents.get`
returning a real document body, corrects the assertions to the merged behaviour, and adds a
dedicated `seeds read state after successful creation` test — the seeding path had no direct
coverage, which is why the merge broke it silently.

`dev/live-testing` is a different integration lineage, so the surrounding file has moved. Port the
intent by hand; a straight cherry-pick will not apply. Keep all six existing `it()` cases including
independents' partial-batch test (`getBatchUpdateProgress`, review finding 3).

### 2. `tests/authConsentFlow.test.js` — complete the factories AND assert the behaviour

The `fs/promises` factory needs `chmod` and the `child_process` factory needs `execFile`. Adding
bare no-op stubs would make the suite pass while silently dropping coverage of a security fix that
just landed. So:

- Record `chmod` calls the way `writeFileCalls`/`unlinkCalls` are recorded, and assert in the
  "saves credentials and succeeds" test that `token.json` is chmodded `0o600` and the config dir
  `0o700`. That behaviour is new in the merged tree and currently has no assertion anywhere in
  this file.
- `execFile(command, args, options, cb)` must record the argv (so no real browser opens during the
  test) and call back `(null, '', '')`. Check whether `execCalls` — the pre-existing `exec`
  recorder — is asserted on anywhere; if the browser opener no longer routes through `exec` at all,
  say so in your report rather than leaving a recorder that can never fire.

### 3. Sweep for the rest of the class

45 `unstable_mockModule` factories exist across `tests/`. The three above only surfaced because a
test happens to reach them; a factory missing an export on a path no test currently drives is a
live landmine that will fire on the next change. Sweep every factory: for each mocked module,
compare the exports the factory provides against the named imports the module(s) under test
actually pull from it. A throwaway helper script is fine (put it outside the repo tree or delete it
before you finish — it must not appear in `git status`). Report every gap you find. Fix the ones
that are real; for any that are intentional, say why.

## Gates

- `grep -rn '<<<<<<<\|>>>>>>>' dist tests scripts live` finds nothing.
- `npm test` run **twice**, both fully green. Report both `Test Suites:` lines *and* both `Tests:`
  lines. A suite that fails to load reports zero failed tests and looks green — read the
  `Test Suites:` line.
- **No test count is a target.** Never consolidate, delete, weaken or skip a test to reach a number.
  Test count should go UP here (you are adding a seeding test and chmod assertions).
- Tool count stays 160 default / 232 aliases-enabled. Do not touch `tests/toolRegistration.test.js`.
- Commit the repair on `verify/live-smoke-on-fixes` with a message that names the mechanism. Do not push.

## Also report (analysis, no action)

The rehearsal branch is throwaway. The real merges happen on GitHub in the order
#109 -> #110 -> #111 -> #112 (ops) -> #113 (independents). For **each** fix you made, say which
branch it must actually land on and whether it can land there *now* or only *after* the earlier PR
is merged in. Expected answer, which you must verify rather than assume: all three broken factories
live in files owned by `feat/independents` (#113), which merges last, so adding the missing exports
is safe there today — but any assertion change that encodes *merged* behaviour (for example
createDocument's warning text, which comes from docs-cluster) would fail on `feat/independents`
standalone and can only land after #110/#112 are merged into it. Give me the concrete split. Do not
push anything.
