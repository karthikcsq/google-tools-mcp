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
- **`GET /healthz`.** Authenticated, and returns exactly `{"status":"ok"}` — no
  version, profile, tool list, handle, client, or environment identity. It is
  operational liveness, not a second discovery endpoint. Use `server/discover`
  for protocol discovery.
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
GOOGLE_MCP_TRANSPORT=http GOOGLE_MCP_PORT=3939 GOOGLE_MCP_HTTP_TOKEN=your-secret google-tools-mcp
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `GOOGLE_MCP_TRANSPORT` | `stdio` | `http` (or `httpStream`, kept as an alias so an existing config still starts) |
| `GOOGLE_MCP_PORT` | `3939` | Listen port |
| `GOOGLE_MCP_ENDPOINT` | `/mcp` | URL path for the MCP endpoint |
| `GOOGLE_MCP_HTTP_HOST` | `127.0.0.1` | Bind address. Loopback by default |
| `GOOGLE_MCP_HTTP_TOKEN` | generated | Bearer token. If unset, a one-time token is generated and printed to stderr at startup |
| `GOOGLE_MCP_HTTP_ALLOWED_ORIGINS` | none | Comma-separated extra `Origin` values to accept |
| `GOOGLE_MCP_HTTP_NO_AUTH` | off | Set `1` to drop the token requirement. Loopback only — startup refuses this with a non-loopback host |

The variable names and their meanings are unchanged from 2.x, so a working
config keeps working. Only the wire protocol changed.

Security details (token on every route, loopback binding, Origin/DNS-rebinding
checks) are in the [README's Shared HTTP mode section](../README.md#shared-http-mode-one-server-for-many-clients).

## Client reconfiguration

### Claude Code

stdio — unchanged, nothing to do:

```bash
claude mcp add -s user google -- google-tools-mcp
```

HTTP — point at the endpoint and send the bearer token. Remove any older entry
first so you do not end up with two `google` servers:

```bash
claude mcp remove -s user google
claude mcp add -s user --transport http google http://127.0.0.1:3939/mcp \
  --header "Authorization: Bearer your-secret"
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "google": {
      "type": "http",
      "url": "http://127.0.0.1:3939/mcp",
      "headers": { "Authorization": "Bearer your-secret" }
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

In `~/.codex/config.toml`:

```toml
[mcp_servers.google]
command = "google-tools-mcp"
args = []
env = { CODEX_MCP_PROTOCOL_VERSION = "2026-07-28" }
```

For HTTP, keep the same env entry and point Codex at the URL with the bearer
token, exactly as for any other streamable-HTTP MCP server.

The guided setup (`google-tools-mcp setup`) registers Codex without that env
entry today; adding it there is tracked in
[#75](https://github.com/karthikcsq/google-tools-mcp/issues/75) /
[#48](https://github.com/karthikcsq/google-tools-mcp/issues/48). Until then, add
the four lines above by hand.

### Anything else

Any client that speaks streamable HTTP MCP works: send `POST` to the endpoint
with `Authorization: Bearer <token>`. Drop any configuration that references
`/sse`, `/messages`, `/ping`, or `Mcp-Session-Id`.

## Notes

- The shared server does not start or stop with your clients. You manage its
  lifecycle (login item, service, `systemd` unit).
- All clients share one process and one OAuth token, so a crash or a token
  expiry affects everyone. Read state no longer leaks between them: it is scoped
  to a single request.
- `google-tools-mcp auth` and `google-tools-mcp setup` are unchanged and still
  use stdio.
