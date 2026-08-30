# Issue #125: route the three browser-open helpers through runArgv

Work only in the worktree `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prD`,
branch `feat/ops-cluster`. Commit as you go. Do not push. Do not post to GitHub.
Do not touch any other worktree.

## The three sites, confirmed present on this branch

- `dist/auth.js:212` — `exec(cmd, (err) => {...})` where `cmd` is a shell string with a URL in it
- `dist/clients.js:177` — `exec(cmd, () => {})`, same shape
- `dist/setup.js:68` — `exec(cmd, () => {})`, same shape

These are the residual tail of #114. This same PR already replaced the `feedback` path and all
client registration with `runArgv()` from `dist/shellSafe.js`, which is `execFile`-based and never
involves a shell. These three were missed.

## Severity, so you calibrate correctly

Low, and explicitly **not** a 3.0 blocker. The URL comes from `generateAuthUrl`, so the
caller-influenced parts (client id, redirect port) are percent-encoded into a query string, which
escapes the shell metacharacters that would matter. This is defence in depth, not a live exploit.

It is worth closing because the reasoning in that paragraph is the kind that stops being true
quietly. If any of these helpers is ever reused for a URL that is not percent-encoded, the shell
string becomes an injection point again, and nothing in the code says otherwise.

So: make the change, keep it small, do not redesign anything around it.

## What to do

1. **Look first for an existing helper to reuse.** `dist/tools/index.js` already has
   `openBrowser(url, { run = runArgv, platform = process.platform })`, which does exactly this and
   is already tested. If it can be imported from these three modules without creating a circular
   import, reuse it and delete the duplicated platform-switch logic. If importing it *would*
   create a cycle, say so explicitly in your report with the import chain you traced, then move
   the helper somewhere neutral (`dist/shellSafe.js` is the obvious home) and have all four call
   sites use it. Do not leave four copies of the same platform switch.
2. Whatever you land on, the opener and the URL must be separate argv elements, never concatenated
   into one string: `['xdg-open', url]`, `['open', url]`, `['cmd', '/c', 'start', '', url]`. Note
   the empty string before `url` in the Windows form; it is the window-title placeholder, and
   dropping it makes `start` treat a quoted URL as the title.
3. Delete the string interpolation and the now-unused `exec` imports. Check whether `exec` is still
   needed at all in each file; `dist/setup.js` also uses `exec` at line 82 and `execSync` at line
   73 for other purposes, so read before deleting the import there.
4. Preserve current behaviour otherwise: these calls are fire-and-forget, failures are swallowed on
   purpose so a missing browser does not break auth. Keep that. Do not start surfacing errors to
   the caller.

## Tests

Add coverage in the spirit of `tests/shellSafeExecution.test.js`. Every behavioural change needs a
test that fails before it and passes after it; say so explicitly with the before/after evidence.

At minimum, for each of the three sites: a URL containing shell metacharacters (`;`, `$(...)`,
backticks, `&&`, a double quote) reaches the opener as a single intact argv element, and no shell
is involved. Assert on the argv array passed to the injected `run`, not on a formatted string.

## Standing constraints

- `dist/*.js` is hand-written runtime source. No `src/`, no TypeScript, no build step.
- Tests are Jest ESM: `npm test`. Bare `npx jest` FAILS. **Read the `Test Suites:` line**, not just
  `Tests:` — a suite that fails to *load* reports zero failed tests and looks green.
- The registered tool count is **160**. Do not add or remove a tool.
- After changing tracked `dist/` or `tests/` files, regenerate the snapshot **after staging**:
  `node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json > /dev/null`
  (redirect stdout, it is extremely verbose).
- Never interpolate a caught error's message into `publicError()`; use `wrapOperationError()` or
  `getApiErrorDetail()` from `dist/errors.js`.
- Stdout purity is absolute on stdio transport.
- Write scratch files inside the worktree and delete them, never to a `/tmp` path.

## Report

FIXED `<sha>`, which of the two routes you took for the helper and why, the before/after evidence
for the metacharacter tests, and the `Test Suites:` line.
