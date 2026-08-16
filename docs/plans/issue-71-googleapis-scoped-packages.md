# Plan: swap umbrella googleapis for per-API @googleapis/* packages (#71)

Issue: [#71](https://github.com/karthikcsq/google-tools-mcp/issues/71) · Verified against `main` @ 8640240. Revised after adversarial review.

## Migration precondition

The MCP 2026-07-28 migration must complete first. It replaces fastmcp and rewrites every tool module's `UserError` import, so this plan's ten-import inventory and every line anchor must be re-verified against the final SDK v2 runtime. Do not begin package edits from the `8640240` inventory below.

## Root cause

`package.json` depends on the 196 MB / 1,823-file umbrella `googleapis` (`^171.4.0`) to use **ten** of its several hundred API surfaces. The cost is paid at every launch twice: module import (~80 % of startup per `docs/startup-performance.md:62-66`) and, for npx launches, per-file dependency verification. All ten import sites are top-level static, so the full load precedes the MCP handshake — the lazy category loader is defeated because `tools/index.js:15` itself imports googleapis.

Recon shows the swap is smaller than the issue estimated:

- Only 10 files import `googleapis`: `auth.js:4` (only `google.auth.OAuth2`), `clients.js:3` (nine services), `setup.js:10` (only `serviceusage`; not on the startup path — dynamically imported for the `setup` subcommand), `tools/index.js:15` (three troubleshoot probes), and the six comment tools (drive only).
- `google-auth-library` is **already a direct dependency** (`package.json:71`, hoisted) and already imported for JWT (`auth.js:5`).
- Exactly **one** test mocks `'googleapis'` by name (`tests/legacyAliasAuthRetry.test.js:35`); the other 15 mock sites target `dist/clients.js` and are unaffected.

## Design decisions

- **Target packages (10):** `@googleapis/docs`, `drive`, `sheets`, `script`, `gmail`, `calendar`, `forms`, `slides`, `tasks`, `serviceusage`. Maps is plain `fetch` (`mapsClient.js:29`) — untouched.
- **Export-shape verification is a first step, not an assumption.** The scoped packages are published from the same generator and are expected to export a callable factory named after the API (e.g. `import { drive } from '@googleapis/drive'; drive({version:'v3', auth})`) plus an `auth` helper — but the review flagged this as unverified, and the packages version independently. Step 0 of implementation: install the ten packages and pin the exact import/constructor shape of each in the new integration test *before* touching call sites. If any package's shape differs, the call-site pattern adapts to what the test proves.
- **OAuth2 from `google-auth-library` directly**: `OAuth2Client` replaces `google.auth.OAuth2` at `auth.js:192,245` (same class, re-exported today).
- **Comment tools:** switch to `getDriveClient()` (#86 does this; whoever lands second has no work here).
- **Troubleshoot probes keep their diagnostic isolation.** Correction from review: routing probes through the cached getters would couple them — `getDriveClient()` initializes docs/drive/sheets/script together (`clients.js:130-138`), so one bad constructor would poison multiple probes. Instead the probes (`tools/index.js:325-350`) keep constructing their own clients, importing constructors from the scoped packages directly. End state: API packages are imported by `clients.js`, `setup.js`, and (deliberately, for isolation) the troubleshoot probe block — documented in a comment there.
- **Error-shape risk pinned by test, via observable behavior.** The retry classifiers are private (`clients.js:59-115`; only `withAuthRetry` is exported at `:197`). Rather than exporting internals for tests, drive them through `withAuthRetry`: feed it a fake operation rejecting with a scoped-stack-shaped `SERVICE_DISABLED` error / an `invalid_grant` error, assert the retry/enable behavior. (Both stacks use `googleapis-common`/`gaxios`, so shapes should match — this test is what turns "should" into "does".)
- **Lockfile is part of the deliverable:** `package-lock.json` regenerated; verification includes `npm ls googleapis` (must fail / show nothing), a lockfile grep for `node_modules/googleapis`, and a **clean `npm ci`** from scratch, not just an incremental install.

## Implementation

0. Install packages; write `tests/scopedClients.test.js` pinning each package's export shape by constructing every client with its expected version and a dummy auth object.
1. `package.json` + `package-lock.json`: remove `googleapis`, add the ten scoped packages (current majors; record the mapping in the PR).
2. `dist/clients.js`: scoped constructors at `:134-137, 145, 153, 161, 169, 285`.
3. `dist/auth.js`: `OAuth2Client` from google-auth-library.
4. `dist/setup.js:216`: `@googleapis/serviceusage`.
5. `dist/tools/index.js` probes: scoped constructors, isolation comment.
6. Comment tools → `getDriveClient()` (or no-op if #86 landed first).
7. `tests/legacyAliasAuthRetry.test.js:35`: convert this last module-name mock to the `dist/clients.js` mocking pattern the other 15 suites use, removing the module-name coupling permanently.
8. `docs/startup-performance.md` + `docs/architecture.md:83-85`: updated measurements and narrative.

## Tests

- `tests/scopedClients.test.js` (from step 0): every scoped package imports and constructs with expected version + auth object — the direct regression net the clients.js-mocking suites cannot provide.
- `withAuthRetry` behavior test with scoped-shaped errors: `SERVICE_DISABLED` detail → enable-URL flow triggered; `invalid_grant` → reauthorize retry; unrelated error → passthrough.
- **Setup path:** `enableApisProgrammatically` (`setup.js:212-220`) executed against an injected mock serviceusage client (constructor called with expected shape; `batchEnable` + `operations.get` invoked) — currently `tests/setupApiCoverage.test.js` only pins the constant list, so a broken serviceusage import would pass every existing test.
- Full suite green; `npm ci` from clean; `npm ls googleapis` empty; lockfile contains no `node_modules/googleapis` entry.
- **Startup measurement, per the documented methodology** (`docs/startup-performance.md:101-112`): isolated per-package import timing (the umbrella vs the ten scoped packages) plus a bounded child-process server start to the ready line — not a bare `import('./dist/index.js')`, which registers tools and leaves a live server. Record before/after numbers and `node_modules` size in the PR.
- `npm pack --dry-run`: package contents unchanged.

## Acceptance criteria

- Server registers all tools and passes the full suite with `googleapis` absent from the dependency tree (lockfile-verified, clean-install-verified).
- `node_modules` shrinks by roughly the predicted ~190 MB; isolated import time drops in line with the issue's ~3 s measurement on the reference machine.
- Every scoped client construction and the serviceusage setup path are covered by executing tests, not just constant assertions.
- Auth-retry classification proven against scoped-stack error shapes through `withAuthRetry`.

## Sequencing

Hard-blocked on the final MCP SDK runtime cutover. Re-baseline the import inventory, package tree, tests, startup measurement, and all line anchors after migration, then land this alone. The open-PRs precondition remains satisfied (PRs #103/#77 merged 2026-08-03). Do not interleave with #86/#91 mid-flight; if #86 lands first, step 6 disappears.
