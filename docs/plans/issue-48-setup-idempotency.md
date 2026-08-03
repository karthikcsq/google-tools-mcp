# Plan: idempotent setup that can repair existing client configs (#48)

Issue: [#48](https://github.com/karthikcsq/google-tools-mcp/issues/48) (canonical for closed #79, #80) · Verified against `main` @ 8640240. Revised after adversarial review.

## Root cause

`runSetup()` (`dist/setup.js:246-631`) is a strictly linear first-install script with **no reads before its writes**:

- It never checks for existing credentials or a live token — always walks the onboarding prompts (API enablement, consent screen, test users, credential creation — `:261-378`), always prompts for Client ID/Secret (`:381-396`), truncating-overwrites `<configDir>/.env` (`:407`), calls `runAuthFlow()` (`:424`) = `authenticate()` directly (`auth.js:341-343`) — full browser OAuth — and **always runs `npm install -g google-tools-mcp@latest`** via `installGlobalFastLaunch()` (`:511-525`, `:131-134`) even when the installed target is already current.
- Client registration shells out to `claude mcp add` / `codex mcp add` (`:570`, `:596`) without inspecting what's there. On a duplicate `google` entry the CLI refuses, and the catch blocks (`:577-581`, `:603-607`) log a warning and **fall through to `outro('Setup complete!')` with exit 0** — the verified failure of closed #80.
- No doctor/audit mode, no flags at all (`index.js:28-49` dispatches only exact `setup`/`auth`), no backups.

Root cause in one sentence: **setup treats every machine as blank and treats client-config write failures as cosmetic** — it cannot converge an existing installation toward a working state.

## Design decisions

- **Make setup convergent (read → diff → converge).** Every step: inspect current state; already correct → say so and *skip* (including the onboarding prompt sections `:261-378` and the global install — both explicitly state-gated); wrong → show exactly what will change, then do it. A healthy rerun is a fast no-prompt, no-write, no-npm walk.
- **Returning-user auth = a genuinely non-mutating check first.** Important correction from review: `authorize()` is *not* read-only — it refreshes and re-saves tokens (`auth.js:312-318`), deletes scope-mismatched tokens (`:178-188`), and launches interactive auth (`:325-338`). So the inspection layer gets its own `inspectToken()`: read `token.json` directly, compare scopes against `SCOPES` **without unlinking**, and probe refresh on a *throwaway* OAuth2 client whose result is discarded (no `saveCredentials`, no deletes). Setup then uses the verdict: valid → skip credentials + OAuth entirely; invalid/absent → the existing interactive path. `--reauth` forces re-auth.
- **Credential detection matches the real loader.** Detection must accept every source `loadClientSecrets()` accepts — env vars, `.env` in three locations, **and `credentials.json` in three locations** (`auth.js:107-130`) — not just `<configDir>/.env`; reuse `loadClientSecrets` itself for detection instead of reimplementing.
- **Client adapters that can read, compare fully, and roll back.** Two adapters (Claude Code, Codex) with `detect/get/add/remove` on the CLIs themselves. Comparison covers the **full entry as the CLI reports it** — command, args, env block, and (for HTTP entries, with #75) url/headers/transport — not just command+args; "unknown fields differ" counts as different and is shown raw. Reconciliation of an existing `google` entry: identical → skip; different → show old vs new, and on confirm run `remove` → `add` with a **rollback contract**: the old entry is captured first; if `add` fails, immediately re-`add` the captured old entry; if the rollback itself fails, print the exact restoration command and exit non-zero. (Honest wording replaces "atomic" — there is an interruption window; it is bounded and recoverable.) Any failure → no "Setup complete!", non-zero exit.
- **`doctor` = the inspection layer, exposed.** New `google-tools-mcp doctor` subcommand: credentials source + validity (via `inspectToken`), scopes vs `SCOPES`, each detected client's `google` entry vs recommended launch command (flagging moving `@latest` npx targets, nonexistent paths, duplicate/conflicting entries), config-file locations (#82), global-install currency (`updateCheck.js` helpers). **Strictly read-only — no writes, no deletes, no token saves — enforced by construction (it only calls inspection functions) and by test.** HTTP endpoint reachability moves to #75's doctor extension, where the state file and `/info` route exist to probe meaningfully; until then doctor reports HTTP config as "configured (not probed)".
- **Flag parsing, minimal but real:** `index.js` dispatch gains flag handling for `setup --reauth`, `doctor --json` (and `doctor` exit semantics: 0 = healthy, 1 = problems found, 2 = could not inspect). No general argument framework.
- **Backups before destructive writes:** `<configDir>/.env` → `.env.bak.<timestamp>` (keep 2). Removed client entries are logged (full old entry) to `<configDir>/client-config-backups.log` **with any token/secret values redacted** and printed to console for manual restoration.

## Implementation

1. `dist/setupInspect.js`: `checkCredentials()` (delegating to `loadClientSecrets`), `inspectToken()` (non-mutating, as above), `checkClientEntry(adapter)`, `checkLaunchTarget(cmd)`, `checkGlobalInstall()`.
2. `dist/clientAdapters.js`: `claude`/`codex` adapters over the CLIs; `get` parses CLI output defensively (unparseable → "unknown, show raw"). Pin parsers with output fixtures **and** record, in the PR, a manual verification of each installed CLI's actual `get/remove/add` syntax and output (CLI contracts are release-dependent; fixtures alone cannot prove them — this boundary is explicit).
3. Rework `runSetup()`: inspect → plan summary → conditional onboarding/credentials/auth (state-gated skips) → conditional API enablement (reuse troubleshoot's probes, `tools/index.js:326-364`) → conditional global install → client reconcile with rollback → summary table (done / skipped-correct / failed+manual-command), non-zero exit on any failure.
4. `doctor` + flags in `dist/index.js`.
5. Use #82's `config.js` for config-dir logic when landed.

## Tests

Everything consequential moves into pure/injectable functions (`setupFastLaunch.test.js` precedent), plus subcommand-level checks:

- `inspectToken` with fixture token files: valid / expired-refresh / scope-mismatch verdicts, and **filesystem untouched after each** (no unlink, no rewrite — mtime/content compared).
- Adapter reconcile matrix with a fake CLI runner: no entry → add; identical → skip, no CLI mutation calls; different + confirm → remove+add; **remove fails → failure, non-zero**; **add fails → rollback re-add invoked; rollback fails → restoration command printed, non-zero** (the two regression tests for the swallowed-error bug and the new rollback contract).
- Full-entry comparison: entries differing only in env block or headers → classified different.
- `checkLaunchTarget`: `npx -y …@latest` flagged moving; nonexistent path flagged; current global path passes. `checkGlobalInstall`: current version → skip verdict (no npm invocation in the convergence plan).
- Backup: `.env` overwrite produces `.bak`, retention 2; client-entry backup log redacts a planted token value.
- Subcommand level (child process): `doctor --json` on a healthy fixture home → exit 0, pinned shape, **no file writes anywhere under the fixture home** (recursive mtime sweep); on a broken fixture → exit 1 naming the problems. A full `runSetup` no-prompt rerun is **not** automated (clack prompts need a TTY); instead the state-gating functions are unit-tested per branch, and the healthy-rerun walk is a scripted manual check recorded in the PR.

## Acceptance criteria

- Re-running setup on a healthy machine: zero prompts beyond the plan summary, zero writes, zero npm installs, zero OAuth — and says what it skipped.
- A stale/conflicting `google` entry is shown (old vs new) and replaced with rollback on failure; declined repair leaves everything untouched; no failure path can print "Setup complete!" / exit 0.
- `doctor` diagnoses moving tags, stale paths, duplicate/conflicting entries, and token problems without mutating anything — including no token refresh side-effects.
- A machine configured via `credentials.json` (any supported location) is recognized as configured.
- First-install flow unchanged in effect for a genuinely blank machine.

## Sequencing

After #82 (shared config module). #75 builds on the same adapters and extends doctor with HTTP probing — land this first.
