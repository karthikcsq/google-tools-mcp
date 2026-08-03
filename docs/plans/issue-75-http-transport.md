# Plan: production-ready shared HTTP transport (#75)

Issue: [#75](https://github.com/karthikcsq/google-tools-mcp/issues/75) (canonical for closed #83, #84, and #55 follow-up) · Verified against `main` @ 8640240.

## Root cause

The HTTP transport's *security* layer landed (auth guard on every route via the monkey-patched request guard `httpAuth.js:242-296`; no-auth + non-loopback refused `httpAuth.js:71-79`; token to stderr `index.js:93-98`), but the transport has **no operational layer**: nothing can start, find, share, or stop a server instance except a human running `node dist/index.js` with hand-set env vars. Verified specifics:

- No lifecycle subcommands exist (argv dispatch is `setup`/`auth` only, `index.js:29-45`); no PID/lock/port file anywhere.
- Port collision = raw `EADDRINUSE` through the generic catch (`index.js:234-237`) — routed via the logger, so `LOG_LEVEL=silent` *hides the fatal error* (the pre-flight refusals deliberately bypass the logger for exactly this reason, `index.js:79`; the listen failure doesn't).
- The auto-generated token is ephemeral — regenerated each restart, printed once to stderr — so a second client can't attach without scraping another client's stderr.
- The setup wizard cannot configure HTTP at all: it emits only `command+args` registrations (`setup.js:570,596,614-616`), never a `url`/`headers` block or env vars.
- Health = mcp-proxy's built-in `GET /ping` (allow-listed at `httpAuth.js:252`) — usable, but undocumented and unauthenticated-by-design; there's no "is it *our* server and which profile" answer.

Root cause in one sentence: **HTTP mode shipped as a transport flag, not as a service** — everything around the socket (identity, discovery, credentials-for-attach, lifecycle, client config) is missing.

## Design decisions

- **Instance state file is the keystone.** `<configDir>/http-server.json` (0600): `{ pid, port, host, endpoint, startedAt, version, profile, tokenRef }`. Written on successful listen, removed on clean shutdown. Every other feature reads it: `status` (liveness = PID alive + `/ping` + an authenticated `GET /info` returning `{ name, version, profile }` added by us), collision diagnosis, client config generation. Stale-file handling: if PID dead → treat as crashed, clean up, proceed.
- **Persistent token.** `<configDir>/http-token` (0600), generated once on first HTTP start (reuse `generateToken`, `httpAuth.js:83-85`), reused thereafter; `GOOGLE_MCP_HTTP_TOKEN` env still overrides (precedence per #82). This is what lets N clients attach without stderr-scraping — they all read the same known location (or setup writes it into their configs). Rotating = delete file + restart; document that.
- **Lifecycle subcommands, not a supervisor.** `serve` (foreground HTTP server — alias for today's env-var path, but sets transport itself), `status` (reads state file, probes, prints diagnosis, `--json`), `stop` (reads PID, graceful signal, waits, cleans state file). **Start-at-login stays documentation, not code**: ship copy-paste unit/plist/Task-Scheduler snippets in `docs/http-mode.md` per platform. Writing a cross-platform service manager is a maintenance tarpit far beyond this server's needs; the honest failure-mode documentation the issue asks for lives in that page until/unless demand proves otherwise.
- **Port collision becomes a diagnosis.** Wrap the listen: on `EADDRINUSE`, read the state file; if a live healthy instance of ours is on that port → exit 0-with-message for `serve` ("already running, pid N, attach clients with `google-tools-mcp status --json`") or a distinct exit code for scripted use; if a foreign process → fatal with the actionable message. Both paths via `process.stderr.write` (not the logger — the silenceable-fatal bug above gets fixed in passing).
- **Setup learns HTTP end-to-end** (builds on #48's adapters): a transport question (stdio per-client vs shared HTTP); HTTP path → ensure token file, write client config in each client's *native HTTP shape* — Claude Code: `claude mcp add --transport http google http://127.0.0.1:<port><endpoint> --header "Authorization: Bearer <token>"`; Codex: its TOML `url`/`headers` form via `codex mcp add` equivalents (verify current CLI syntax at implementation time; both CLIs' HTTP registration shapes are release-dependent — pin with adapter fixtures).
- **Boundary statements, enforced and written down:** one profile = one Google account = one server instance (state file is per-configDir, which is per-profile — collisions across profiles get distinct ports via config). Loopback stays the default; **non-loopback binding without TLS remains refused** (extend `assertSafeHttpBinding` from refusing only no-auth to refusing token-auth too — plaintext bearer tokens on a LAN are not a supportable mode; revisit only with TLS termination guidance).
- **Session/tracker isolation is already correct** (`readTracker` per-session, `sessionContext` from `mcp-session-id`, disconnect cleanup at `index.js:154-161`; pinned by `tests/sessionIsolation.test.js`) — what's missing is an end-to-end proof, added below. Working-copy collision is #87's item; its session-suffix fix completes this story.

## Implementation

1. `dist/httpState.js`: state-file read/write/validate/cleanup + token-file management.
2. `dist/index.js`: `serve`/`status`/`stop` argv dispatch; listen-error wrapper; `/info` route (through the existing request guard so it's authenticated); state-file write after ready, cleanup on SIGINT/SIGTERM/exit (extend `:108-135`).
3. `dist/setup.js`: transport question + HTTP client registration via #48's adapters.
4. `docs/http-mode.md`: lifecycle model, start-at-login snippets (systemd user unit, launchd plist, schtasks), token rotation, one-profile boundary, failure modes (manual lifecycle caveats), TLS stance.
5. README: point the existing shared-HTTP section at the doc page.

## Tests

- `httpState`: stale-PID cleanup, permission bits, round-trip.
- Listen-collision: spawn a real listener on a random port, run the wrapper → our-instance vs foreign-process branches produce the right message/exit (integration-style, child processes).
- **Two-real-clients end-to-end** (the issue's explicit ask): spawn the server in HTTP mode on a random port; two raw MCP HTTP clients (plain `fetch` doing initialize + tool call with distinct `mcp-session-id`s); assert: both authenticated with the same persistent token; a `readDocument`-then-`modifyText` sequence in session A does not unlock writes in session B (tracker isolation across the wire); disconnect of A (DELETE) clears A's state only. Mock the Google layer via `GOOGLE_MCP_*` test seams or run against `dist/clients.js` mocks loaded through a test-only module flag — if that proves too invasive, scope the E2E to auth + session-isolation via a diagnostic tool and keep tracker assertions at the unit layer (`sessionIsolation.test.js` already covers logic).
- `status --json` shape pinned.

## Acceptance criteria

- Cold machine: `google-tools-mcp serve` → `status` shows healthy; second `serve` on the same port explains itself instead of stack-tracing; `stop` shuts down and cleans state.
- Two MCP clients attach concurrently using the stored token, with verified session isolation and disconnect cleanup.
- Setup can configure Claude Code *and* Codex for HTTP without the user hand-editing anything.
- Non-loopback binding is refused with or without a token; the boundary and lifecycle model are documented.
- Only after all of the above: open a *new* issue to discuss default-transport promotion — explicitly out of scope here; stdio remains supported and default.

## Sequencing

After #82 (config/token precedence) and #48 (client adapters). Largest single plan; split PRs: (1) state+token+subcommands, (2) collision+/info+docs, (3) setup integration, (4) E2E test.
