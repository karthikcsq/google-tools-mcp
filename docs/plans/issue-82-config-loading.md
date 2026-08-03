# Plan: load shared machine configuration before startup (#82)

Issue: [#82](https://github.com/karthikcsq/google-tools-mcp/issues/82) (canonical for closed #85) · Verified against `main` @ 8640240. Revised after adversarial review.

## Root cause

The server *has* a user config file (`~/.config/google-tools-mcp/.env`, loaded by the hand-rolled non-overwriting parser at `dist/auth.js:67-89`) — but it is parsed inside `loadClientSecrets()`, which runs on the **first tool call**, long after every startup consumer has already read `process.env`:

- `dist/logger.js` reads `LOG_LEVEL` (`:16`) and `GOOGLE_MCP_LOG_FILE` (`:44-46`) at **module eval**, before `dist/index.js`'s body runs, and memoizes both (`:22`, `:31/:43`).
- `dist/index.js` reads `GOOGLE_MCP_TRANSPORT` (`:58`), `GOOGLE_MCP_PORT` (`:60`), `GOOGLE_MCP_ENDPOINT` (`:61`); `dist/httpAuth.js:33-36` reads the four HTTP auth vars via `resolveHttpAuthConfig` at `index.js:68`; `GOOGLE_MCP_ENABLE_LEGACY_ALIASES` is read during registration (`legacyAliases.js:19-22`).
- Lazily-read vars (`GOOGLE_MCP_WORKSPACE_DIR`, `GOOGLE_MAPS_API_KEY`) only *happen* to work if a tool call precedes them and credentials weren't already in env — `loadClientSecrets` short-circuits before reading any file when `GOOGLE_CLIENT_ID/SECRET` are set (`auth.js:95-97`).

So a machine-wide `.env` can configure exactly one thing in practice: OAuth credentials. Compounding defects: `getConfigDir()` is duplicated in three files (`auth.js:22-28`, `logger.js:33-40`, `setup.js:65-71`); a `GOOGLE_MCP_PROFILE` set *inside* a config file can never work coherently (`auth.js:98` computes the dir before parsing; logger burned the profile at module eval); and the loader swallows **all** read errors identically (`auth.js:85-88`) — a permission-denied config file fails with no trace.

## Design decisions

- **One config module, synchronous, loaded first.** New `dist/config.js` using **`fs.readFileSync`** — the current loader is async, and module-eval loading only guarantees ordering if the reads complete synchronously; top-level await would work but sync reads of three tiny files are simpler and cannot be observed mid-load. `dist/index.js` imports `./config.js` as its **first** import (before `./logger.js` at `:14`); ESM executes imports in order, and `config.js` itself imports nothing that reads env. Defense in depth: logger's level/file resolution also becomes lazy (first log call) — the exported-but-dead `refreshLogLevel` (`logger.js:23-25`) shows this was half-intended.
- **Precedence, explicit and tested:** (1) real process environment wins — where "set" means **defined, including empty string**: the parser's current `if (!process.env[key])` treats `FOO=` as unset and would clobber it; change to `if (process.env[key] === undefined)` and pin with a test; (2) user config `<configDir>/.env`; (3) `cwd/.env`; (4) package-root `.env` — preserving today's relative order (`auth.js:100-102`), executed at startup.
- **Config dir is immutable for the process.** `getConfigDir()` currently recomputes from mutable env on every call, so consumers can disagree mid-run. `config.js` resolves it **once** at load (from `XDG_CONFIG_HOME` + `GOOGLE_MCP_PROFILE` as seen in the real environment) and returns the snapshot thereafter; a test mutates `process.env.GOOGLE_MCP_PROFILE` after load and asserts the dir does not move.
- **Profile selection comes only from the real environment.** (Not "or CLI" — no profile CLI flag exists in `index.js:29-50`; if #48 adds argument parsing later, it may extend this, but this plan's rule is environment-only.) A `GOOGLE_MCP_PROFILE` key inside a `.env` file is ignored with a startup warning naming the offending file.
- **Loader errors become visible.** ENOENT stays silent (missing files are normal); any *other* read error (EACCES, EISDIR…) emits one stderr warning naming the path — directly fixing the "silently does not affect anything" failure class this issue is about.
- **No file-format change.** Same parser semantics otherwise; `loadClientSecrets` delegates to `config.js` (idempotent re-parse is harmless under the non-overwrite rule).
- **Windows stdio reality** (the closed #85 scenario): a user-level env var set after the MCP client started is invisible to spawned servers; the config file is the supported answer. Document in README's configuration section, with permissions guidance (0600 on POSIX; on Windows the user-profile ACL default suffices — say so explicitly).

## Implementation

1. New `dist/config.js`: sync `loadEnvFile` + ordered load at module eval; snapshotted `getConfigDir()`; profile-in-file warning; error-visibility rule.
2. `dist/index.js`: `import './config.js';` first.
3. `dist/logger.js`: lazy level/stream resolution; drop its private `getDefaultLogPath` config-dir logic in favor of `config.js`.
4. `dist/auth.js` / `dist/setup.js`: delete private `getConfigDir` copies, import from `config.js`; `loadClientSecrets` delegates file-parsing.
5. `dist/tools/index.js:379` (troubleshoot's re-derived log path) → shared helper; troubleshoot's `config` section gains `transport`, `port`, and the list of config files actually loaded (paths only, never values).
6. Docs: README "Configuration" subsection — locations, precedence table (including the empty-string rule), profile rule, Windows note, permissions; **update `docs/architecture.md:71`**, which currently documents `getConfigDir` as exported from `dist/auth.js`.

## Tests

New `tests/config.test.js` — child-process based, because the subject *is* module-eval timing. Two layers:

- **Unit (import `dist/config.js` in a child):** table-driven over the full startup-variable set — `GOOGLE_MCP_TRANSPORT`, `GOOGLE_MCP_PORT`, `GOOGLE_MCP_ENDPOINT`, each `GOOGLE_MCP_HTTP_*`, `GOOGLE_MCP_LOG_FILE`, `LOG_LEVEL`, `GOOGLE_MAPS_API_KEY`, `GOOGLE_MCP_WORKSPACE_DIR`, `GOOGLE_MCP_ENABLE_LEGACY_ALIASES` — file-only values land in `process.env`; env-over-file including **empty-string env wins over file**; precedence chain user-file > cwd-file > package-file; profile-in-file ignored with warning; config-dir immutability; EACCES fixture produces the warning line.
- **End-to-end (spawn `dist/index.js`):** with a fixture `XDG_CONFIG_HOME` whose `.env` sets `GOOGLE_MCP_TRANSPORT=http` + a random `GOOGLE_MCP_PORT` and `LOG_LEVEL=debug`, assert the child's stderr shows the HTTP ready line on that port — proving the values were visible at the *actual read sites*, not merely in `process.env`. A second spawn with real env `GOOGLE_MCP_TRANSPORT=stdio` overriding the file asserts the stdio ready line. Kill the child after the ready line.
- Existing suite green (logger laziness must not change message formats).

## Acceptance criteria

- `GOOGLE_MCP_TRANSPORT=http` (and port/log settings) in `~/.config/google-tools-mcp/.env` takes effect on a fresh launch with a clean environment — proven by the spawn test, not inference.
- Real env vars, including explicitly-empty ones, override file values everywhere.
- One `getConfigDir` definition, snapshotted; logger/auth/setup/troubleshoot agree by construction.
- Unreadable config files produce a visible warning; missing ones stay silent.
- Documented precedence matches tested precedence; architecture doc no longer misstates the export.

## Sequencing

Before #91 (log file/level must honor the config file) and before #75/#48 (lifecycle/doctor read the same config). No conflicts with the Docs/Gmail tracks.
