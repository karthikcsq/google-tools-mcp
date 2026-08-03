# Plan: swap umbrella googleapis for per-API @googleapis/* packages (#71)

Issue: [#71](https://github.com/karthikcsq/google-tools-mcp/issues/71) · Verified against `main` @ 8640240.

## Root cause

`package.json` depends on the 196 MB / 1,823-file umbrella `googleapis` (`^171.4.0`) to use **ten** of its several hundred API surfaces. The cost is paid at every launch twice over: module import (~3 s more than scoped equivalents; measured 6.0–8.4 s total, ~80 % of startup per `docs/startup-performance.md:62-66`) and, for npx launches, per-file dependency-tree verification. All ten import sites are top-level static, so the full load sits on the startup path before the MCP handshake — the lazy category loader is defeated because `tools/index.js:15` itself imports googleapis.

Recon shows the swap is **smaller than the issue estimated**:

- Only 10 files import `googleapis`: `auth.js:4` (only `google.auth.OAuth2`), `clients.js:3` (nine services), `setup.js:10` (only `serviceusage`, *not on the startup path* — dynamically imported for the `setup` subcommand), `tools/index.js:15` (drive/gmail/calendar for troubleshoot probes), and the six comment tools (drive only).
- `google-auth-library` is **already a direct dependency** (`package.json:71`, hoisted in the lock) and already imported for JWT (`auth.js:5`) — the OAuth2 swap is an import-line change.
- Exactly **one** test mocks `'googleapis'` by name: `tests/legacyAliasAuthRetry.test.js:35`. The other 15 mock sites target `dist/clients.js` and are unaffected.

## Design decisions

- **Target packages (10):** `@googleapis/docs`, `drive`, `sheets`, `script`, `gmail`, `calendar`, `forms`, `slides`, `tasks`, `serviceusage`. Maps is plain `fetch` (`mapsClient.js:29`) — untouched. Each scoped package exports the same versioned constructor (`drive({version:'v3', auth})`) published from the same generator; auth objects from `google-auth-library` are accepted identically.
- **OAuth2 from `google-auth-library` directly**: `import { OAuth2Client } from 'google-auth-library'` replaces `google.auth.OAuth2` at `auth.js:192,245`. Same class — googleapis re-exports it.
- **Kill the import-shape divergence while here:** the six comment tools build private `google.drive(...)` clients per call instead of using `getDriveClient()` (`resolveComment.js:16-17` et al.). #86's plan already switches them to the cached client; if #86 lands first, those six files need no googleapis-swap edits at all. Same for `tools/index.js`'s troubleshoot probes — switch them to the existing `getGmailClient`/`getCalendarClient`/`getDriveClient` getters instead of importing API constructors a second way. End state: **`dist/clients.js` and `dist/setup.js` are the only files importing API packages**, which is also what makes the next such migration trivial.
- **Error-shape risk is low but must be verified:** the auth-retry classifiers parse gaxios error shapes (`clients.js:59-115` — `error.response.data.error.details[].reason === 'SERVICE_DISABLED'`, `invalid_grant` regexes). Scoped packages use the same `googleapis-common`/`gaxios` stack, so shapes should be identical — but this is the one assumption worth an explicit test (below) rather than faith.
- **Version pinning:** pick the current major of each scoped package (they version independently); record the googleapis→scoped mapping in the PR description. `package-lock` shrinkage (~190 MB installed) is the observable win — capture before/after `npm ls --package-lock-only | wc` style evidence and startup timings per `docs/startup-performance.md:104-109` methodology.

## Implementation

1. `package.json`: remove `googleapis`, add the ten `@googleapis/*` packages.
2. `dist/clients.js`: `import { docs } from '@googleapis/docs'` (etc.) — constructors replace `google.docs(...)` at `:134-137, 145, 153, 161, 169, 285`.
3. `dist/auth.js`: OAuth2Client from google-auth-library.
4. `dist/setup.js:216`: `serviceusage` from `@googleapis/serviceusage`.
5. `dist/tools/index.js` troubleshoot probes → cached getters (drop its googleapis import entirely).
6. Comment tools → `getDriveClient()` (or no-op if #86 landed).
7. `tests/legacyAliasAuthRetry.test.js:35`: retarget the module mock. Its factory mocks the `google` namespace object; with scoped imports the mock becomes per-package (`jest.unstable_mockModule('@googleapis/gmail', ...)`) — or better, since `clients.js` is the only consumer, convert this last module-name mock to the `dist/clients.js` mocking pattern the other 15 tests use, removing the coupling permanently.
8. `docs/startup-performance.md`: update measurements and the dependency-cost narrative; `docs/architecture.md:83-85` likewise.

## Tests

- Full suite green — the 15 clients.js-mocking suites are the behavioral regression net.
- New `tests/errorShapes.test.js`: construct a gaxios-style error through one scoped client against a mocked HTTP layer (or hand-build the documented shape) and assert `isApiNotEnabledError`/`extractApiEnableInfo`/`isInvalidGrantError` still classify it — the one real risk, pinned.
- Startup measurement (manual, recorded in PR): `node --input-type=module -e "console.time('i'); await import('./dist/index.js')"`-style timing before/after on the same machine, plus `du` of `node_modules`. Target: import cost drop in line with the issue's ~3 s measurement; no regression in `npm ci` time.
- `npm pack --dry-run`: unchanged package contents (this is a deps-only change).

## Acceptance criteria

- Server registers all 156 tools and passes the full suite with `googleapis` absent from the dependency tree.
- `node_modules` shrinks by roughly the predicted ~190 MB; measured import time drops multiple seconds on the reference machine.
- Only `clients.js` + `setup.js` import Google API packages; everything else goes through getters.
- Auth-retry error classification proven against the scoped stack.

## Sequencing

The open-PRs precondition is satisfied (PRs #103/#77 merged 2026-08-03). Land this **early and alone** — it touches the same files as most other plans, so it goes first (right after the small #96/#74) or waits for a quiet window; do not interleave with #86/#91 mid-flight. Coordinate: if #86 lands first, steps 6 shrinks to nothing; if this lands first, #86 rebases trivially.
