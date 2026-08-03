# Plan: load shared machine configuration before startup (#82)

Issue: [#82](https://github.com/karthikcsq/google-tools-mcp/issues/82) (canonical for closed #85) · Verified against `main` @ 8640240.

## Root cause

The server *has* a user config file (`~/.config/google-tools-mcp/.env`, loaded by the hand-rolled non-overwriting parser at `dist/auth.js:67-89`) — but it is parsed inside `loadClientSecrets()`, which runs on the **first tool call**, long after every startup consumer has already read `process.env`:

- `dist/logger.js` reads `LOG_LEVEL` (`:16`) and `GOOGLE_MCP_LOG_FILE` (`:44-46`) at **module eval**, before `dist/index.js`'s body even runs, and memoizes both (`:22`, `:31/:43`).
- `dist/index.js` reads `GOOGLE_MCP_TRANSPORT` (`:58`), `GOOGLE_MCP_PORT` (`:60`), `GOOGLE_MCP_ENDPOINT` (`:61`) in its body; `dist/httpAuth.js:33-36` reads the four HTTP auth vars via `resolveHttpAuthConfig` at `index.js:68`.
- Lazily-read vars (`GOOGLE_MCP_WORKSPACE_DIR` at `workspace.js:40`, `GOOGLE_MAPS_API_KEY` at `mapsClient.js:4`) would *happen* to work only if a tool call precedes them and only if credentials weren't already in env — `loadClientSecrets` short-circuits before reading any file when `GOOGLE_CLIENT_ID/SECRET` are set (`auth.js:95-97`).

So a machine-wide `.env` can configure exactly one thing in practice: OAuth credentials. Everything else silently ignores it. Compounding defects: `getConfigDir()` is duplicated in three files (`auth.js:22-28`, `logger.js:33-40`, `setup.js:65-71`) that can disagree, and a `GOOGLE_MCP_PROFILE` set *inside* a config file can never work and would desynchronize logger vs auth if it half-worked (`auth.js:98` computes the dir before parsing; logger burned the profile at module eval).

## Design decisions

- **One config module, loaded first, side-effect-free imports elsewhere.** New `dist/config.js` exporting `loadConfigFiles()` and `getConfigDir()`. `dist/index.js` calls `loadConfigFiles()` as its **first** statement — before importing the logger. Because ESM static imports hoist, this requires either (a) making `index.js` import `./config.js` first and having *config.js itself* run the load at module eval (imports execute in order, config.js has no imports that read env), or (b) converting logger's eager reads to lazy first-use reads. Do **both**: config loads at module eval of `config.js` (imported first), and logger's `resolveLevel`/`initLogFile` become lazy (first log call) as defense in depth — the existing exported-but-dead `refreshLogLevel` (`logger.js:23-25`) shows this was half-intended already.
- **Precedence, explicit and tested:** (1) real process environment always wins — the parser's existing `if (!process.env[key])` behavior (`auth.js:81`) already guarantees this; (2) user config `<configDir>/.env`; (3) `cwd/.env`; (4) package-root `.env` — preserving today's relative order (`auth.js:100-102`), just executed at startup instead of first-call.
- **Profile selection comes only from the real environment/CLI.** Resolve the circularity by rule, per the issue's suggestion: `GOOGLE_MCP_PROFILE` inside a `.env` file is ignored with a startup warning naming the offending file. Implement by snapshotting the profile before parsing and restoring/warning if a file tried to set it.
- **No file-format change.** Same parser, promoted to `config.js`; `loadClientSecrets` keeps calling it (idempotent — the non-overwrite rule makes double-parsing harmless), so the auth path is unchanged for clients that never restart the server. Remove the early short-circuit at `auth.js:95-97` *for file loading* only in the startup call (still fine to skip re-parsing on the auth path).
- **Windows stdio reality check** (the closed #85 scenario): a user-level env var set after the MCP client started is invisible to spawned servers; the config file is the supported answer. Document exactly that in README's configuration section, plus secure-permissions guidance (0600; on Windows, the user-profile ACL default suffices — say so rather than hand-waving).

## Implementation

1. New `dist/config.js`: move `loadEnvFile` + `getConfigDir` there; export both; run the ordered load at module eval; capture-and-warn on in-file `GOOGLE_MCP_PROFILE`.
2. `dist/index.js`: `import './config.js';` as the first import (before `./logger.js` at `:14`).
3. `dist/logger.js`: make level and file-stream resolution lazy (first call to any log fn), delete the duplicated `getDefaultLogPath` config-dir logic in favor of `config.js`'s `getConfigDir`.
4. `dist/auth.js` / `dist/setup.js`: delete their private `getConfigDir` copies, import from `config.js`; `loadClientSecrets` delegates file-parsing to `config.js`.
5. `dist/tools/index.js:379` (troubleshoot's own re-derived log path) → use the shared helper; troubleshoot's `config` section gains `transport`, `port`, and which config files were loaded (paths only, no values) — cheap observability for this exact class of bug.
6. README: one "Configuration" subsection — file locations, precedence table, profile rule, Windows note, permissions note. Cover the full variable list from the issue: transport/port/endpoint/HTTP_*, log file/level, Maps key, workspace dir.

## Tests

New `tests/config.test.js`, spawning fresh child processes (`node -e` importing `dist/config.js`) because the subject *is* module-eval timing:

- File-only startup values: with a temp `XDG_CONFIG_HOME` pointing at a fixture `.env` containing `GOOGLE_MCP_TRANSPORT=http`, `LOG_LEVEL=debug`, `GOOGLE_MAPS_API_KEY=x` — child process reports all three visible in `process.env` after importing config.js.
- Env-over-file: same fixture plus real `GOOGLE_MCP_TRANSPORT=stdio` in the child's env → stdio wins.
- Profile circularity: fixture `.env` sets `GOOGLE_MCP_PROFILE=evil` → ignored, warning emitted, config dir unchanged.
- Precedence chain: user-file vs cwd-file vs package-file ordering.
- Existing `tests/` suite green (logger laziness must not change any message format).

## Acceptance criteria

- `GOOGLE_MCP_TRANSPORT=http` (and port/token/log settings) in `~/.config/google-tools-mcp/.env` takes effect on a fresh launch with a clean environment — the issue's headline scenario.
- Real env vars still override file values everywhere.
- One `getConfigDir` definition; logger/auth/setup/troubleshoot agree on it by construction.
- Documented precedence matches tested precedence.

## Sequencing

Before #91 (log file/level must honor the config file) and before #75/#48 (their lifecycle/doctor work reads the same config). No conflicts with the Docs/Gmail tracks.
