# tests/packageContents.test.js is flaky and will randomly redden CI

Work only in the worktree `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE`,
branch `feat/independents`. Commit as you go. Do not push. Do not post to GitHub.
Do not touch any other worktree.

## The evidence

I ran `npm test` on this branch six times. Four were green, two failed, always the same test:

```
● published package contents › contains only package metadata and runtime JavaScript

  thrown: "Exceeded timeout of 5000 ms for a test.
  Add a timeout value to this test to increase the timeout, if this is a long-running test."

  at tests/packageContents.test.js:11:5
```

It is not an assertion failure. The test body shells out to `npm pack --dry-run --json` using a
freshly created temp npm cache (`mkdtemp`, line 12). Spawning npm with a cold cache takes well
over Jest's default 5000ms timeout whenever the machine is under load from the other 52 suites
running in parallel. When the machine is quiet it finishes in time, which is why it passes more
often than it fails.

I confirmed it is not caused by stray untracked files in the working tree: I added one and the
test still passed in isolation.

This matters beyond the annoyance. The merge sequence for 3.0 uses `npm test` as the gate after
each of five merges. A test that fails roughly one run in three makes that gate meaningless, and
it teaches everyone to re-run until green, which is exactly how a real regression gets waved
through.

## What to do

1. Give this test an explicit, generous timeout. It shells out to a package manager; it is not a
   5-second unit test. Pass the timeout as the third argument to `it(...)`. Two minutes is
   reasonable. Do not raise the global Jest timeout for every test to fix this one.
2. Check whether anything else in the file, such as a `beforeAll` that also runs `npm pack`, needs
   the same treatment, and give it a matching timeout if so. `beforeAll` takes a timeout argument
   the same way.
3. Look for any other test in `tests/` that spawns a subprocess (`npm`, `node`, `execFile`,
   `spawn`) and relies on the default 5000ms timeout. Report what you find. Fix the ones that are
   clearly in the same boat, and list any you chose to leave alone with your reason.
4. Add a short comment above the timeout saying why it is there, so nobody deletes it later as
   noise.

Do not "fix" this by mocking out `npm pack`. The whole value of this test is that it inspects what
the real packer would publish.

## Verify

Run the **full** suite (`npm test`, not just this file) at least four times and report the
`Test Suites:` line for each run. All four must be green. A single green run does not demonstrate
anything here, since the bug reproduces roughly one run in three.

## Standing constraints

- `dist/*.js` is hand-written runtime source. No `src/`, no TypeScript, no build step.
- Tests are Jest ESM: `npm test`. Bare `npx jest` FAILS. **Read the `Test Suites:` line**, not just
  `Tests:` — a suite that fails to *load* reports zero failed tests and looks green.
- The registered tool count is **160**. Do not add or remove a tool.
- After changing tracked `dist/` or `tests/` files, regenerate the snapshot **after staging**:
  `node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json > /dev/null`
- Write scratch files inside the worktree and delete them, never to a `/tmp` path.

## Report

FIXED `<sha>`, what you changed, the list of other subprocess-spawning tests you found and what
you did about each, and the `Test Suites:` line from **all four** full runs.
