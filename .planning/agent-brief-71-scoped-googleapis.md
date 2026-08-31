# Implement issue #71 in the dedicated worktree

Work only in `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-71`, branch
`feat/scoped-googleapis`. Read the full authoritative brief first at
`C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp/.planning/brief-71-scoped-googleapis.md`,
then read `.planning/constraints.md` in your worktree. The authoritative brief's two
corrections override the worktree constraints.

Complete this assignment directly. Do not spawn other agents or invoke orchestration skills.
Do not touch any other worktree. Do not use `gh`, post to GitHub, push, switch branches,
merge, rebase, stash, stage, or commit. The orchestrator owns all Git operations and the
final commit. Use `apply_patch` for hand edits. Do not change the already committed scoped
dependency-addition commit except through the requested later `npm uninstall googleapis`.

## Verified baseline

- Worktree was clean at `7bd3320` before this run.
- All ten scoped package named factories are installed and callable.
- Installed `google.auth.OAuth2 === OAuth2Client`; positional construction and auth URL
  behavior match. Use direct `OAuth2Client` imports in `dist/auth.js` and
  `dist/setupInspect.js`.
- Baseline full suite: `Test Suites: 91 passed, 91 total`; `Tests: 2 skipped, 1303 passed,
  1305 total`.
- Default and aliases-enabled tool counts must remain 160 and 232.

## Current scope, revalidated after the six merges

Runtime imports are exactly:

- `dist/auth.js`
- `dist/clients.js`
- `dist/setup.js`
- `dist/setupInspect.js`
- `dist/tools/index.js`

Test module mocks are exactly:

- `tests/authConsentFlow.test.js`
- `tests/legacyAliasAuthRetry.test.js`
- `tests/publicErrorBoundary.test.js`

Do not alter Google OAuth scope URLs, googleapis.com hostnames, or comments merely because
they contain the text `googleapis`.

## Implementation requirements

1. Replace the umbrella factories with the ten scoped factories exactly as specified by the
   authoritative brief. Keep the troubleshoot Drive/Gmail/Calendar construction isolated in
   `dist/tools/index.js` and document why.
2. Replace `google.auth.OAuth2` with `OAuth2Client` from `google-auth-library` in both auth
   runtime files.
3. Repair all three test mock surfaces. In `authConsentFlow`, merge `OAuth2Client` into the
   existing `google-auth-library` factory alongside `JWT`. In the legacy alias suite,
   preserve the real `withAuthRetry`; do not wholesale-mock `dist/clients.js` if that would
   bypass what the suite proves. In the public error suite, mock the scoped modules actually
   imported by the runtime.
4. Add `tests/scopedClients.test.js` covering construction of all ten factories with the
   required versions/auth object. Add observable `withAuthRetry` coverage for scoped-shaped
   `SERVICE_DISABLED`, `invalid_grant`, and unrelated errors. Add executable setup-path
   coverage for `batchEnable` and `operations.get` with a narrow injection/export seam.
5. After runtime and focused tests work, run `npm uninstall googleapis` so `package.json` and
   `package-lock.json` lose the umbrella package for real.
6. Update `docs/startup-performance.md`, `docs/architecture.md`, the two stale umbrella
   claims in `README.md`, and the existing Unreleased section of `CHANGELOG.md`. Use only the
   supplied 2026-08-30 measurements: umbrella 195 MB / 1,823 files / 1054, 1112, 1203 ms;
   scoped 8.1 MB / 148 files / 149, 139, 158 ms. Do not re-benchmark.
7. Regenerate `tests/fixtures/mcp-migration-inventory.json` with the repository script.
8. Verify no conflict markers, no imports/mocks from the umbrella module, no direct
   `googleapis` package or lockfile entry, correct tool counts, focused tests, and one full
   `npm.cmd test -- --runInBand`. Also run `npm.cmd pack --dry-run`. Do not run a clean
   `npm ci`; the orchestrator will do destructive clean-install verification after reviewing
   your diff.

## Boundaries

- Do not edit the stale historical execution plan under `docs/plans/`; the current
  authoritative brief intentionally supersedes its old counts.
- Do not add Husky or git-hook tooling in this issue branch.
- Do not weaken, consolidate, skip, or delete tests.
- Preserve stdout purity and the public error boundary.
- Report every file changed, exact focused/full test summaries, package checks, and anything
  you did not verify. A claim without command evidence is incomplete.
