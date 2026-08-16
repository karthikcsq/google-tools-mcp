# Plan: production-ready shared HTTP lifecycle (#75)

Issue: [#75](https://github.com/karthikcsq/google-tools-mcp/issues/75) (canonical for closed #83, #84, and #55 follow-up). Revised after the MCP 2026-07-28 migration decision.

## Migration boundary

The migration owns the HTTP runtime: the official SDK v2 handler, ordinary bearer-auth middleware, stateless requests, `server/discover`, and removal of fastmcp's request-guard monkey-patch, legacy SSE endpoints, and session lifecycle. Those are not parallel implementation work for #75. Re-verify every runtime anchor after the migration lands.

## Root cause

HTTP mode still needs service operations around the migrated socket: durable instance discovery, a persistent attach token, lifecycle commands, native client registration, and operator documentation. A human should not have to keep one terminal's stderr open to discover a restart-generated credential or diagnose a port collision.

## Design decisions

- **State and token files are the keystone.** `<configDir>/http-server.json` (0600) stores `{ pid, port, host, endpoint, startedAt, version, profile }`, written through temp-file plus rename only after listen succeeds. `<configDir>/http-token` (0600) is generated once and reused; `GOOGLE_MCP_HTTP_TOKEN` overrides it and `status` reports that override without printing a secret. One shared static bearer represents one effective service principal, not distinguishable end users; token rotation or Google-profile change invalidates every outstanding handle.
- **Lifecycle stays foreground and explicit.** `serve` starts the migrated handler and publishes state, `status` reads state and probes it, and `stop` terminates the recorded PID, waits, verifies, and removes stale state. Signal cleanup removes the state file synchronously. There is no embedded supervisor; start-at-login instructions belong in `docs/http-mode.md`.
- **Status uses authenticated SDK identity, health uses an authenticated minimal endpoint.** `status` authenticates first and reads operational identity from the SDK's authenticated response `_meta`; that metadata is observability-only and never authorization input. `GET /healthz` runs behind the same bearer-token and Origin checks and returns minimal liveness only, with no version, profile, tool identity, token state, or secret-bearing detail. It replaces the old `/ping` assumption; do not recreate `/info`, `/ping`, `/sse`, or session routes.
- **Collision and binding decisions are deterministic.** A second `serve` for a healthy recorded instance reports its profile and attach instructions; a foreign process or another profile on the port fails through `process.stderr.write`, including the `GOOGLE_MCP_PORT` remedy. Non-loopback binding is refused in every token mode.
- **Setup configures an actual attach path.** It ensures the token, writes each client's native HTTP `url`/authorization-header representation through #48's adapters, and probes the exact configured endpoint before declaring success. Token values are redacted from setup output and backups.
- **The state model is stateless.** A shared static bearer establishes one effective service principal, so this service makes no per-client identity claim. Cross-client safety comes from opaque-handle possession/unguessability plus per-handle editable-workspace isolation. HTTP has no implicit current-read fallback: each guarded Docs mutation must carry a valid handle bound to the effective service principal/profile/file/tab/revision/fingerprint. Token rotation or profile change invalidates all handles. The migration's request middleware is used directly; no `http.createServer` interception or transport-specific session bookkeeping is allowed back in.

## Implementation

1. After migration, re-baseline `dist/index.js` and add `dist/httpState.js` for atomic state/token read, validation, stale cleanup, and permission handling.
2. Add `serve`, `status`, and `stop` around the SDK v2 HTTP handler. Publish state after listen, remove it on signals, diagnose collisions on stderr, and retain stdio as the default transport.
3. Add an authenticated minimal `/healthz` liveness route behind the normal deployment boundary and make `status` consume authenticated SDK response `_meta`; document their intentionally different contracts and the fact that `_meta` has no authorization role.
4. Extend `dist/setup.js` and #48's adapters with HTTP registrations, token creation, redacted output, and a live endpoint probe.
5. Write `docs/http-mode.md`: lifecycle, token rotation, per-profile ports, non-loopback/TLS stance, start-at-login examples, discovery and health semantics, and failure recovery. README and command errors link to the repository URL because `docs/` is not packaged.

## Tests

- `httpState`: atomic publish, stale-PID cleanup, permissions, and env-token-override reporting.
- Child-process collisions: managed same-profile, managed cross-profile, and foreign-port branches have correct stderr and exit behavior even with silent logging.
- Binding refusal covers non-loopback with and without an env token; SIGTERM and already-dead `stop` clean state correctly.
- `status --json` obtains operational identity only from authenticated SDK response `_meta`; spoofed or unauthenticated metadata has no authority. `healthz` rejects missing/invalid token or Origin and, when valid, returns only its documented liveness shape.
- Setup HTTP registration has success and dead-endpoint failure cases; failures include the documentation URL and logs/backups never contain the token.
- Mandatory real-HTTP E2E, using the migration's mock-client seam: two clients share the one effective service principal, make modern and legacy-compatible calls through the same handler, and get distinct opaque handles/workspaces even when reading identical content. Unauthenticated calls fail, no `/sse` route exists, and a guarded Docs write succeeds only with possession of its validated opaque read handle. A raw revision or `expectedRevisionId` alone never authorizes it. Token rotation and profile change invalidate old handles. TTL and dirty-working-copy behavior follows the migration/#106 contract.

## Acceptance criteria

- `serve` → authenticated `status` healthy → `stop` works on a cold machine; collision and stale-state outcomes explain the exact remedy.
- A token persists across restart, is never logged, and setup writes and validates working Claude Code and Codex HTTP registrations.
- `status` reads identity only from authenticated SDK response `_meta` and `/healthz` is authenticated minimal liveness; no legacy ping, SSE, session, or monkey-patched transport surface remains.
- Two concurrent clients safely use stateless opaque read handles over real HTTP through one effective service principal; isolation comes from handle possession and workspace separation, not a per-client identity claim. stdio remains supported and default.

## Sequencing

Hard-blocked on the MCP migration. Then land after #82 (config/token precedence and profile `.env`) and #48 (client adapters and doctor), in lifecycle/state, setup, and E2E/documentation PRs as needed.
