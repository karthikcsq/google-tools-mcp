## Standing constraints (apply to every task below)

- You are working in the worktree you were launched in (`-C`). Stay in it. Do NOT `git
  checkout`, `git switch`, `git rebase`, `git merge`, `git push`, or touch any other branch.
- **Commit your work** in logical commits with real messages. Do not push.
- **`dist/*.js` is hand-written runtime source.** There is no `src/`, no TypeScript, and no
  build step. Edit `dist/` directly.
- **Tests are Jest ESM.** Run `npm test` or `npm test -- <path>`. Bare `npx jest` FAILS.
  Read the **`Test Suites:`** line, not just `Tests:` — a suite that fails to *load* reports
  zero failed tests, so a broken suite otherwise looks green.
- The registered tool count is **160**, pinned in `tests/toolRegistration.test.js`,
  `tests/mcpSdkV2Compatibility.test.js`, `tests/mcpServerFacade.test.js`,
  `tests/entrypointSmoke.test.js`. If you add a tool you must update all of them.
- After changing any tracked file under `dist/` or `tests/`, regenerate the inventory:
  `node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json`
  Line shifts alone fail `tests/mcpMigrationInventory.test.js`.
- **Stdout purity is absolute** on stdio transport: only protocol messages may reach stdout.
  A stray `console.log` corrupts the protocol. Use the logger, which writes to stderr.
- **Error-boundary rule:** never interpolate a caught error's message into `publicError()`.
  Use `wrapOperationError()` or a validated field via `getApiErrorDetail()` from
  `dist/errors.js`. Caller-supplied text must never reach persisted diagnostics.
- You have **no network access**. `gh`, `npm install`, and any HTTP call will fail. Do not
  try. Everything you need is inlined in this brief or already in the worktree.
- Do not make unrelated changes, do not reformat untouched code, do not bump versions.
- Add or extend tests for every behavioural fix. A fix without a test that fails before it
  and passes after it is not done.

## How to report

For EVERY numbered finding, end your run with one line of the form:

    FINDING <n>: FIXED <commit-sha> — <one sentence on what changed>
    FINDING <n>: ALREADY-CORRECT — <the code and reasoning that disprove it>
    FINDING <n>: INVALID — <why the report is wrong>

Verify each finding against the actual code BEFORE fixing it. Some reports are wrong or
already fixed; saying so with evidence is a correct outcome and is more useful than a
defensive change. Never silently skip one.
