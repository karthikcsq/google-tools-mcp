# Plan: idempotent setup that can repair existing client configs (#48)

Issue: [#48](https://github.com/karthikcsq/google-tools-mcp/issues/48) (canonical for closed #79, #80) · Verified against `main` @ 8640240.

## Root cause

`runSetup()` (`dist/setup.js:246-631`) is a strictly linear first-install script with **no reads before its writes**:

- It never checks for existing credentials or a live token — always prompts for Client ID/Secret (`:381-396`), always truncating-overwrites `<configDir>/.env` (`:407`), and always calls `runAuthFlow()` (`:424`), which is `authenticate()` directly (`auth.js:341-343`) — a full browser OAuth round trip — even though the codebase already owns the correct returning-user primitive: `authorize()` (`auth.js:304-339`) loads the saved token, validates scopes (`:178-189`), proactively refreshes (`:315`), and falls back to interactive auth only on `invalid_grant`.
- Client registration shells out to `claude mcp add` / `codex mcp add` (`:570`, `:596`) without inspecting what's there. When an entry named `google` already exists, the CLI refuses, `runCommand` rejects, and the catch blocks (`:577-581`, `:603-607`) log a warning and **fall through to `outro('Setup complete!')` with exit 0** — the wizard reports success while the stale launch command (moving `@latest` npx target, deleted global-install path, wrong transport) stays in place. This is the exact verified failure of closed #80.
- There is no doctor/audit mode, no flags at all (`index.js` dispatches only exact `setup`/`auth` argv), no backup of anything it overwrites.

Root cause in one sentence: **setup treats every machine as blank, and treats client-config write failures as cosmetic** — so it cannot converge an existing installation toward a working state, only overlay a fresh one or silently fail.

## Design decisions

- **Make setup convergent (read → diff → converge), not linear.** Every step becomes: inspect current state; if already correct, say so and skip; if wrong, show exactly what will change and do it. Re-running setup on a healthy machine should be a fast no-op walk.
- **Returning-user auth path = `authorize()`, not `authenticate()`.** If `<configDir>/.env` (or env) yields credentials and `authorize()` succeeds without interaction, skip credential prompts and OAuth entirely; offer `--reauth` (and an interactive "re-authenticate anyway?" prompt) for the explicit case. This is a call-site swap plus flow reordering — the hard logic already exists and is tested by usage.
- **Client adapters that can read.** Two adapters (Claude Code, Codex) with `list/get/remove/add` — implemented on the CLIs themselves (`claude mcp get google` / `claude mcp remove` / `codex mcp get|remove`), not by parsing their config files, so we do not take a dependency on private file formats. Reconciliation for an existing `google` entry: fetch it, compare command+args against the recommended launch command from `buildLaunchCommand` (`setup.js:177-203`); identical → "already configured"; different → show old vs new and, on confirm, `remove` + `add` as one step, **failing loudly** (non-zero exit + no "Setup complete!") if either half fails. That replaces today's swallowed-error fall-through.
- **`doctor` = the read half, factored out.** New `google-tools-mcp doctor` subcommand (argv dispatch beside `setup`/`auth` in `index.js:29-45`): reports — credentials source and validity (`authorize()` dry probe), token scopes vs `SCOPES`, each detected client's `google` entry vs recommended launch command (flagging moving `@latest` npx targets, nonexistent paths via `fs.access`, duplicate/conflicting scopes reported by `claude mcp list`), config-file locations (#82), and — HTTP mode — endpoint reachability. **Read-only, always exits with a diagnosis, never writes.** Setup's inspection phase calls the same functions, so doctor and setup cannot drift apart.
- **Backups before destructive writes.** Before overwriting `<configDir>/.env`: copy to `.env.bak.<timestamp>` (keep last 2). Before `remove`+`add` on a client: print the exact old entry JSON to the console *and* append it to a `<configDir>/client-config-backups.log` — since we don't own the client config files, a printed/logged restoration command is the honest rollback.
- **Partial failure = honest exit.** Track per-step status; the outro becomes a summary table (done / skipped-already-correct / failed with the manual command), and any failure exits non-zero.

## Implementation

1. Extract inspection helpers into `dist/setupInspect.js` (shared by doctor + wizard): `checkCredentials()`, `checkToken()` (wraps `authorize()` non-interactively — needs a `{ interactive: false }` option added to `authorize` so it *reports* instead of launching a browser on failure), `checkClientEntry(adapter)`, `checkLaunchTarget(cmd)`.
2. Client adapters `dist/clientAdapters.js`: `claude`/`codex` objects with `detect/get/add/remove`; `get` parses the CLI's own output (pin with fixtures; both CLIs print entry JSON/TOML-ish text — parse defensively and treat unparseable as "unknown, show raw").
3. Rework `runSetup()` step order: inspect → report plan → credentials (skip if valid) → auth (authorize-first) → APIs (skip if token probe shows enabled — `troubleshoot`'s service probes at `tools/index.js:326-364` are reusable here) → client reconcile → summary.
4. `doctor` subcommand in `dist/index.js`; `--json` flag for scripting.
5. Fold the duplicated `getConfigDir` into #82's `config.js` if that has landed; otherwise import from `auth.js`.

## Tests

The wizard's prompt flow stays untestable-cheaply, but everything that matters moves into pure/injectable functions (the existing pattern — `setupFastLaunch.test.js` already tests `buildLaunchCommand` with injected fakes):

- `setupInspect` with injected fakes: valid token → returning-user verdict; expired refresh → reauth verdict; scope-mismatch → reauth verdict.
- Adapter reconcile matrix with a fake CLI runner: no entry → add; identical entry → skip; different entry + confirm → remove+add both called; remove fails → step reports failure and overall exit is non-zero (**the regression test for the swallowed-error bug**).
- Launch-target checks: `npx -y google-tools-mcp` flagged as moving; nonexistent path flagged; current global path passes.
- `.env` backup: overwrite produces `.bak`, retention of 2.
- Doctor `--json` output shape pinned.

## Acceptance criteria

- Re-running setup on a healthy machine performs zero writes, zero OAuth prompts, and says so.
- A stale/conflicting `google` client entry is shown (old vs new) and replaced atomically on confirm; a declined repair leaves everything untouched; a failed repair cannot produce "Setup complete!".
- `google-tools-mcp doctor` diagnoses the four bad patterns from the issue (moving tags, stale paths, duplicates/conflicting scopes, unreachable HTTP) without writing anything.
- First-install flow unchanged in effect for a genuinely blank machine.

## Sequencing

After #82 (shared config module). #75's HTTP client-config work builds on the same adapters — land this first.
