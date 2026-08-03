# Plan: production-ready shared HTTP transport (#75)

Issue: [#75](https://github.com/karthikcsq/google-tools-mcp/issues/75) (canonical for closed #83, #84, and #55 follow-up) · Verified against `main` @ 8640240. Revised after adversarial review.

## Root cause

The HTTP transport's *security* layer landed (auth guard on every route via the request guard `httpAuth.js:242-296`; no-auth + non-loopback refused `httpAuth.js:71-79`; token to stderr `index.js:93-98`), but the transport has **no operational layer**: nothing can start, find, share, or stop an instance except a human running `node dist/index.js` with hand-set env vars. Verified specifics:

- No lifecycle subcommands (`index.js:29-45`); no PID/lock/state file.
- Port collision = raw `EADDRINUSE` through the generic catch (`index.js:234-237`) — routed via the logger, so `LOG_LEVEL=silent` hides the fatal error (the pre-flight refusals deliberately bypass the logger, `index.js:79`; the listen failure doesn't).
- The auto-generated token is regenerated each restart and printed once to stderr — a second client can't attach without scraping another client's stderr.
- The setup wizard cannot configure HTTP at all: it emits only `command+args` registrations (`setup.js:570,596,614-616`), never a `url`/`headers` block or env vars.
- Health: mcp-proxy's `GET /ping` is allow-listed (`httpAuth.js:252`) and *is* documented in README (`README.md:490-500`) — the real gap is that it cannot identify **whose** server answered (instance/profile/version).

Root cause in one sentence: **HTTP mode shipped as a transport flag, not as a service** — everything around the socket (identity, discovery, credentials-for-attach, lifecycle, client config) is missing.

## Design decisions

- **Instance state file is the keystone.** `<configDir>/http-server.json` (0600): `{ pid, port, host, endpoint, startedAt, version, profile }`. Race discipline: written via **temp-file + rename** (atomic on one filesystem) immediately after listen succeeds; the ready line prints *after* the state file exists, defining "published". `status` treats missing-file-but-responsive-port as "unmanaged instance on this port" (diagnosed, not owned); stale file with dead PID → cleaned up and reported. Two concurrent `serve` starts race on the *socket*, not the file — the loser gets `EADDRINUSE` and the collision diagnosis below.
- **Per-profile ports must be configured, and collisions are diagnosed, not guessed.** Correction from review: nothing allocates ports per profile — every profile defaults to 3939 (`index.js:60`). The rule shipped here: a profile intended for concurrent use sets its own `GOOGLE_MCP_PORT` in its profile `.env` (#82 makes that work); `serve` on a port whose state file belongs to a *different* profile fails with a message naming both profiles and the config line to change. No automatic allocation — deterministic beats clever for client configs that embed the URL.
- **Persistent token, explicit secret-handling story.** `<configDir>/http-token` (0600), generated once (reuse `generateToken`, `httpAuth.js:83-85`), reused thereafter. Precedence: `GOOGLE_MCP_HTTP_TOKEN` env (per #82 rules) > token file; when the env override is active, `status` says so (config drift is diagnosable). The token lands in client config files, which are the clients' own security domain — setup states this in its output; #48's client-entry backup log **redacts token values**; rotation = delete token file, restart, re-run setup's HTTP registration (documented as the rotation procedure).
- **Lifecycle subcommands, not a supervisor.** `serve` (foreground; sets transport itself), `status` (state file + `/ping` + authenticated `GET /info` → `{ name, version, profile }`, added by us behind the request guard; `--json`), `stop` (PID from state file, SIGTERM, wait, verify, clean). **Shutdown correction:** current handlers call `process.exit(0)` immediately (`index.js:108-115`) and `exit` handlers can't run async work — the SIGINT/SIGTERM path becomes: synchronous `fs.unlinkSync` of the state file (idempotent, try/catch), then exit; `stop` waits for both process death and state-file disappearance. Start-at-login stays documentation: `docs/http-mode.md` ships systemd-user/launchd/schtasks snippets. A cross-platform service manager is a maintenance tarpit; the manual-lifecycle failure mode is documented as the issue demands.
- **Port collision becomes a diagnosis** (written with `process.stderr.write`, not the silenceable logger): our-healthy-instance → "already running (pid N, profile P); clients can attach — see status --json" with exit 0 for `serve`; foreign process → fatal with the port-change instruction.
- **Setup learns HTTP end-to-end** (extends #48's adapters concretely): a transport question; HTTP path → ensure token file; write each client's native HTTP shape — Claude Code `claude mcp add --transport http google <url> --header "Authorization: Bearer <token>"`; Codex via its `url`/`headers` TOML form. Adapter work is specified as: HTTP-shape `add/get` support + output fixtures per CLI + a recorded manual verification against each installed CLI's real syntax (release-dependent, same boundary as #48). **Setup's HTTP path ends with a live probe** of the exact URL+token it just wrote — configured-but-dead endpoints fail setup loudly instead of "succeeding" against nothing; the failure message points at `docs/http-mode.md`'s start-at-login section.
- **Boundary statements, enforced:** one profile = one Google account = one instance. Loopback default; **non-loopback refused with or without a token** — extend `assertSafeHttpBinding` (`httpAuth.js:62-80`), which today refuses only the no-auth case; plaintext bearer tokens on a LAN are not a supportable mode (revisit only with TLS guidance).
- Session/tracker isolation is already correct in logic (`readTracker` per-session; `sessionContext` from `mcp-session-id`; disconnect cleanup `index.js:154-161`; `tests/sessionIsolation.test.js`) — what's missing is the end-to-end proof over real HTTP, which is **mandatory** here, not best-effort.

## Implementation

1. `dist/httpState.js`: atomic state-file write/read/validate/cleanup + token-file management.
2. `dist/index.js`: `serve`/`status`/`stop` dispatch; listen-error wrapper; `/info` (guarded); state write after listen, ready line after state write; synchronous cleanup in signal handlers.
3. `assertSafeHttpBinding`: refuse non-loopback unconditionally.
4. `dist/setup.js` + `dist/clientAdapters.js` (#48): transport question, HTTP shapes, fixtures, final live probe.
5. `docs/http-mode.md` (lifecycle model, per-platform start-at-login, token rotation, one-profile boundary, failure modes, TLS stance). **Linking correction:** `docs/` does not ship in the npm package (`files: ["dist"]`) — README links use the absolute GitHub URL, and the `status`/collision messages print that URL, not a relative path.

## Tests

- `httpState`: atomic write (no partial file visible), stale-PID cleanup, permission bits, env-token-override reporting.
- Collision (child processes on a random port): our-instance vs foreign vs cross-profile branches → right message, right exit code, via stderr not logger.
- Binding refusal: non-loopback host refused **with a token set** (new) and without (existing) — both exit fatally pre-listen.
- Shutdown: SIGTERM → state file gone (synchronously) before process exit; `stop` on an already-dead PID cleans up and reports.
- **Two-real-clients E2E (mandatory):** server spawned in HTTP mode with the Google layer substituted through a test seam (env-gated mock module for `dist/clients.js` — added as part of this work); two raw MCP HTTP clients perform initialize (capturing their real `mcp-session-id`s) + tool calls with the persistent token; assert: both authenticated; session A's `readDocument`-then-write succeeds while the same write in session B is rejected as unread (tracker isolation across the wire, using actual session propagation); DELETE of A clears only A. No fallback that drops these assertions — if the seam can't be built, the plan is not done.
- `status --json` shape pinned; setup HTTP path: probe-success and probe-failure (dead endpoint → non-zero, message includes the doc URL).

## Acceptance criteria

- Cold machine: `serve` → `status` healthy; second `serve` explains itself (same profile) or names the profile conflict (different profile); `stop` shuts down and cleans state; kill -9 leaves a stale file that the next `serve`/`status` handles.
- Two MCP clients attach concurrently with the stored token; session isolation and disconnect cleanup verified end-to-end over real HTTP.
- Setup configures Claude Code *and* Codex for HTTP and fails loudly if the configured endpoint isn't actually reachable.
- Non-loopback binding refused in all auth modes; boundaries and lifecycle documented at a URL that exists for npm users.
- Default-transport promotion: explicitly out of scope; open a new issue after this ships. stdio remains supported and default.

## Sequencing

After #82 (config/token precedence, per-profile ports) and #48 (adapters, doctor — doctor's HTTP probe lands here). Split PRs: (1) state+token+subcommands+shutdown, (2) collision+/info+binding+docs, (3) setup integration, (4) E2E seam + test.
