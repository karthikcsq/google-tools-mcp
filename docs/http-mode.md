# Shared HTTP mode

`GOOGLE_MCP_TRANSPORT=http` runs one long-lived server that many MCP clients
share over a loopback URL, instead of every client spawning its own stdio
process. This page is the reference for that mode, including the breaking
changes in 3.0.0.

stdio is still the default and is unaffected by everything below. If you run
the server the normal way (one process per client, no `GOOGLE_MCP_TRANSPORT`),
nothing in your config needs to change.

## Breaking changes in 3.0.0

The server now speaks MCP **2026-07-28** on the official MCP TypeScript SDK v2.
The previous runtime (FastMCP on the v1 SDK, fronted by mcp-proxy) is gone, and
with it the entire HTTP session lifecycle. HTTP is stateless: every request is
authenticated, served, and forgotten.

### Removed endpoints and headers

| Removed | What it did | Now |
| --- | --- | --- |
| `GET /sse` | Legacy SSE compatibility transport that mcp-proxy always stood up alongside the configured endpoint | `404` (after the auth check) |
| `POST /messages` | The `/sse` transport's companion message route, dispatched on `?sessionId=` | `404` (after the auth check) |
| `GET /ping` | mcp-proxy's own unauthenticated liveness route | `404`. Use authenticated `GET /healthz` |
| `GET <endpoint>` | Attaching to a session's event stream | Not routed. There is no session stream |
| `DELETE <endpoint>` | Terminating a session | Not routed. There is no session to terminate |
| `Mcp-Session-Id` | Session identity, request and response | Never required, never returned, ignored if sent |

Everything except the configured endpoint (`GOOGLE_MCP_ENDPOINT`, default
`/mcp`) and `GET /healthz` returns `404` — but only *after* the bearer-token and
`Origin` checks, so an unauthenticated caller gets `401`/`403` and cannot probe
which paths exist.

### What replaced them

- **One POST endpoint.** Modern (2026-07-28) and supported legacy stateless
  JSON-RPC both go to `POST /mcp`. No handshake route, no stream route, no
  teardown route.
- **`GET /healthz`.** Authenticated, and returns exactly
  `{"status":"ok","pid":<number>}` — no version, profile, tool list, handle, or
  client identity. It is operational liveness, not a second discovery endpoint;
  use `server/discover` for protocol discovery. The pid is the one piece of
  identity it does carry, because `setup` and `status` compare it against the
  recorded state file to prove the process answering the port is the one they
  started rather than something else that took it. Once the runtime has been
  shut down the same route answers `503` with `{"status":"closed"}`, so a
  supervisor stops treating a drained process as a live one.
- **`subscriptions/listen`** is accepted and closed gracefully with the empty
  result (this server has nothing to notify: the tool list is fixed). It does
  not hold the connection open.
- **CORS** is answered on `OPTIONS` for `/mcp` and `/healthz` from an allowed
  Origin, and `Access-Control-Allow-Origin` + `Vary: Origin` are attached to
  real responses too, not just the preflight.

### The `readHandle` contract on HTTP

This is the change most likely to affect how you actually use the server.

Read-before-edit state used to be carried by the MCP session: one request read a
document, a later request on the same session was allowed to edit it. Stateless
HTTP has no session, so **read state is never carried between HTTP requests**.

- **Google Docs edits over HTTP take an explicit `readHandle`.** `readDocument`
  returns one; pass it to the mutation. The handle is server-minted, opaque, and
  bound to the credential fingerprint, configured profile, runtime epoch, file,
  tab, revision, and structural fingerprint. It expires in under 24 hours, and a
  mutation handle is single-use: a successful write consumes it and returns a
  successor bound to the new revision. A revision string on its own cannot
  authorize a write.
- **The field is optional in the schema and required at runtime on HTTP.** stdio
  callers, which have implicit connection-pinned read state, do not pass it.
- **`writeSpreadsheet`, `batchWrite`, `clearSpreadsheetRange`, and `deleteFile`
  have no handle wiring yet and fail closed over HTTP.** Use stdio for those in
  this release.
- Restarting the process mints a fresh epoch, which invalidates every
  outstanding handle. Rotating the bearer token or `GOOGLE_MCP_PROFILE` means
  restarting, so rotation genuinely invalidates handles.

### Deployment limitation

One process serves **one** configured Google profile and **one** effective
service principal. Handles, trackers, and workspace ownership are only valid
for that deployment. Multiple profiles or horizontal scale would need a shared,
credential-partitioned state store and are out of scope for this release.

## Running it

```bash
google-tools-mcp start
google-tools-mcp status
google-tools-mcp status --json
google-tools-mcp restart
google-tools-mcp stop
```

`start` launches a detached managed process, or attaches if this profile's
recorded instance is already healthy. `serve` runs the same service in the
foreground for a login item or service manager. `restart` waits for the old PID
to stop before starting and authenticating the replacement. `stop` terminates
only the PID in the state file, verifies it exited, and removes stale state.

The config directory contains two private operations files:

- `http-token` (0600): generated once, then reused across restarts.
  `GOOGLE_MCP_HTTP_TOKEN` overrides it without rewriting it; status reports
  `environment` or `file`, never the token value.
- `http-server.json` (0600): atomically published after listen succeeds, with
  `pid`, `port`, `host`, `endpoint`, `startedAt`, `version`, and `profile`.
  Signals and normal shutdown remove the owning record. A dead PID is stale
  state and is cleaned on inspection.

The default config directory is `~/.config/google-tools-mcp`; profiles use a
child directory, and `XDG_CONFIG_HOME` is honored. One process is one profile
and one Google account. Use a distinct `GOOGLE_MCP_PORT` for each profile.

| Variable | Default | Meaning |
| --- | --- | --- |
| `GOOGLE_MCP_TRANSPORT` | `stdio` | `http` (or `httpStream`, kept as an alias so an existing config still starts) |
| `GOOGLE_MCP_PORT` | `3939` | Listen port |
| `GOOGLE_MCP_ENDPOINT` | `/mcp` | URL path for the MCP endpoint |
| `GOOGLE_MCP_HTTP_HOST` | `127.0.0.1` | Bind address. Loopback by default |
| `GOOGLE_MCP_HTTP_TOKEN` | private token file | Overrides the stable token; its value is never printed or logged |
| `GOOGLE_MCP_HTTP_ALLOWED_ORIGINS` | none | Comma-separated extra `Origin` values to accept |
| `GOOGLE_MCP_HTTP_NO_AUTH` | off | Set `1` to drop the token requirement. Loopback only — startup refuses this with a non-loopback host |

Service mode refuses every non-loopback bind, with or without a token, until a
supported TLS deployment model exists. A foreign process on the configured port
fails with an actionable `GOOGLE_MCP_PORT` message. It never negotiates a hidden
port that would leave client URLs stale.

`status` performs two separate authenticated checks. `GET /healthz` proves only
liveness and must return the minimal `{"status":"ok"}` body. Server identity is
read from `io.modelcontextprotocol/serverInfo` in the authenticated official SDK
client's modern `server/discover` response `_meta`. Health data, state-file
fields, or caller-supplied metadata never substitute for that identity.

Security details (token on every route, loopback binding, Origin/DNS-rebinding
checks) are in the [README's Shared HTTP mode section](../README.md#shared-http-mode-one-server-for-many-clients).

## Client reconfiguration

### Claude Code

stdio — unchanged, nothing to do:

```bash
claude mcp add -s user google -- google-tools-mcp
```

HTTP setup invokes this native shape after the managed service is healthy:

```bash
claude mcp remove -s user google
claude mcp add -s user --transport http google http://127.0.0.1:3939/mcp \
  --header "Authorization: Bearer <value from http-token>"
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "google": {
      "type": "http",
      "url": "http://127.0.0.1:3939/mcp",
      "headers": { "Authorization": "Bearer <value from http-token>" }
    }
  }
}
```

If you previously pointed a client at `/sse`, change the URL to the `/mcp`
endpoint. There is no SSE URL to fall back to.

### Codex

Codex pins stdio MCP servers to the legacy lifecycle unless it is told the
server speaks the modern revision, regardless of its own feature flag. Set
`CODEX_MCP_PROTOCOL_VERSION=2026-07-28` in the server's env block, or you get
the legacy path against a server that no longer has a session lifecycle to
match it.

For stdio, setup writes this server environment entry (it is required even when
Codex's own modern-protocol feature is enabled):

```toml
[mcp_servers.google]
command = "google-tools-mcp"
args = []
env = { CODEX_MCP_PROTOCOL_VERSION = "2026-07-28" }
```

For HTTP, Codex's native shape takes the bearer token by environment-variable
name rather than an inline header:

```bash
codex mcp add google --url http://127.0.0.1:3939/mcp \
  --bearer-token-env-var GOOGLE_MCP_HTTP_TOKEN
```

The guided setup supplies the stable token while it invokes this command and
writes the same URL the lifecycle probe authenticated.

## Start at login

The portable service entrypoint is always `google-tools-mcp serve`. Put the
profile and any non-default port in the service manager's environment; the
token normally stays in `http-token`.

### Windows Task Scheduler

Create an **At log on** task that runs the absolute installed executable with
argument `serve`, starts in a stable directory, runs only for the current user,
and restarts on failure. The equivalent action is:

```text
Program: C:\path\to\google-tools-mcp.cmd
Arguments: serve
```

### macOS LaunchAgent

Use a per-user plist in `~/Library/LaunchAgents` with `RunAtLoad` and
`KeepAlive` enabled. Its `ProgramArguments` are the absolute Node executable,
the installed `dist/index.js`, and `serve`.

### Linux systemd user service

```ini
[Unit]
Description=google-tools-mcp shared HTTP service
After=network.target

[Service]
Type=simple
ExecStart=/absolute/path/to/google-tools-mcp serve
Restart=on-failure
Environment=GOOGLE_MCP_PORT=3939

[Install]
WantedBy=default.target
```

Then run `systemctl --user enable --now google-tools-mcp.service`.

## Recovery and token rotation

- `status` reports `not-running`, `stale-state`, `token-missing`,
  `unreachable-or-unauthorized`, or `unexpected-service` rather than treating a
  PID or successful health response as sufficient.
- If another process owns the port, stop it or set `GOOGLE_MCP_PORT` consistently
  for the service and both clients, then run setup again.
- To rotate the file-backed token, stop the service, delete only
  `<configDir>/http-token`, run `start`, then re-run setup for both clients.
  Rotation restarts the runtime epoch and invalidates outstanding read handles.

### Anything else

Any client that speaks streamable HTTP MCP works: send `POST` to the endpoint
with `Authorization: Bearer <token>`. Drop any configuration that references
`/sse`, `/messages`, `/ping`, or `Mcp-Session-Id`.

## Notes

- Setup defaults to stdio. Shared HTTP is explicit opt-in and establishes a
  healthy lifecycle before changing any client entry.
- All clients share one process and one OAuth token, so a crash or a token
  expiry affects everyone. Read state no longer leaks between them: it is scoped
  to a single request.
- `google-tools-mcp auth` remains independent of the transport choice.
