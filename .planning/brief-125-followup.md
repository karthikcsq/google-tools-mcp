# Your #125 change broke tests/feedbackDraftBinding.test.js. Fix it without weakening it.

Work only in the worktree `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prD`,
branch `feat/ops-cluster`, on top of your commit `1dd0452`. Commit as you go. Do not push.
Do not post to GitHub. Do not touch any other worktree.

Your report correctly said you could not confirm the full suite passed. It does not. I ran it:

```
Test Suites: 1 failed, 55 passed, 56 total
Tests:       5 failed, 2 skipped, 823 passed, 830 total
```

All five failures are in `tests/feedbackDraftBinding.test.js`:

```
SyntaxError: The requested module './shellSafe.js' does not provide an export named 'openBrowser'
  at tests/feedbackDraftBinding.test.js:42
```

## The cause

That file mocks the whole `dist/shellSafe.js` module at line 14 with a factory providing exactly
three exports: `runArgv`, `shellQuote`, `formatShellCommand`. You moved `openBrowser` into that
module, so `dist/tools/index.js` now imports a name the mock factory does not provide, and the
module fails to link.

## The trap, read this before you fix it

Do **not** just add `openBrowser: jest.fn()` to the factory and move on. That makes the suite green
while quietly destroying the property it exists to prove.

Read the comments at lines 11-12 and 36-39. The design was:

> Mock the only external-process boundary feedback's publish path can reach, so a successful
> "publish" in these tests never spawns gh or a browser.
> ... the browser-fallback branch, which also runs through the mocked runArgv above instead of a
> real process.

Before your change, `openBrowser` lived elsewhere and called `runArgv` internally, so mocking
`runArgv` alone covered **both** the gh boundary and the browser boundary. That is why
`expect(runArgvMock).not.toHaveBeenCalled()` at lines 60, 67 and 75 was a meaningful assertion
about the browser as well as gh.

Now that `openBrowser` is itself an export of the mocked module, a bare `jest.fn()` for it means
the browser boundary is no longer observed by any assertion. `runArgvMock` would stay untouched no
matter how many browsers the code opened, and the three "never reaches gh/browser" tests would
pass vacuously.

## What to do

1. Add an `openBrowser` export to the mock factory backed by its own module-scope spy, in the same
   style as `runArgvMock`. Reset it in `beforeEach` alongside `runArgvMock.mockReset()`.
2. Everywhere the file asserts `expect(runArgvMock).not.toHaveBeenCalled()` (lines 60, 67, 75, and
   any others), add the matching assertion on the new browser spy. The test name says
   "never reaches gh/browser"; make both halves of that true by assertion, not by accident.
3. In the success case (around lines 103-120, where `publish.method` is `'browser-fallback'`),
   assert the browser spy **was** called, and with the fallback URL that the test already knows
   about. That is the positive half of the same property, and it is currently only inferred from
   the returned `method` string.
4. Update the two comment blocks (lines 11-12 and 36-39) so they describe the new arrangement:
   there are now two mocked boundaries in this module, not one that covers both. Whoever reads this
   next should not have to re-derive what you just derived.
5. Do not change `dist/` for this. The runtime change in `1dd0452` is correct; only the test's
   assumptions about where `openBrowser` lives are stale.

## Also confirm

While you are in there, check whether any **other** test mocks `../dist/shellSafe.js` or
`../dist/tools/index.js` with a partial factory that will now be missing `openBrowser`. The failure
mode is a link-time `SyntaxError`, which takes out the whole suite file rather than one test, so it
is easy to miss. Report what you found either way.

## Gate

Run the **full** suite (`npm test`) and report the `Test Suites:` line. It must be fully green.
Read that line, not just `Tests:` — a suite that fails to *load* reports zero failed tests.

Then prove the restored assertions are not vacuous: temporarily make the publish path open a
browser when it should not (or make the refusal path fall through), confirm the new assertions
fail, then revert that scratch edit. Show the failing output in your report. If you cannot
construct such a case, say so and explain why.

## Standing constraints

- `dist/*.js` is hand-written runtime source. No `src/`, no TypeScript, no build step.
- Tests are Jest ESM: `npm test`. Bare `npx jest` FAILS.
- The registered tool count is **160**.
- After changing tracked `dist/` or `tests/` files, regenerate the snapshot **after staging**:
  `node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json > /dev/null`
- Write scratch files inside the worktree and delete them, never to a `/tmp` path.

## Report

FIXED `<sha>`, the new assertions you added, the vacuity-check output, any other partial mocks you
found, and the `Test Suites:` line.
