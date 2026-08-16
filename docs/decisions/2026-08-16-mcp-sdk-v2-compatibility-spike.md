# ADR: MCP SDK v2 compatibility spike

**Date:** 2026-08-16
**Status:** Accepted for the migration's Phase 1 decision gate
**Scope:** package floor and isolated test fixtures only. `dist/` still starts FastMCP by default.

## Decision

Use the official `@modelcontextprotocol/server@2.0.0` plus
`@modelcontextprotocol/node@2.0.0` as the Phase 2 facade target. Keep FastMCP
in this release while the migration flag and transport cutover are implemented.

The root project now declares Node `>=20`, Zod `^4.2.0`, direct Hono
`^4.11.4`, and exact official SDK package versions. Hono is a direct dependency
because `@modelcontextprotocol/node@2.0.0` declares it as a peer dependency.

`ViteMCP` is rejected as a candidate. `npm view vitemcp` returned npm `E404` on
2026-08-16, so there is no npm package/release to compare. It must not remain in
future implementation plans as an available facade option.

This decision is based on the official [SDK v2 migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28), the [Streamable HTTP specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), and the exact packages installed by this worktree's lockfile.

## Locked package evidence

| Package | Manifest request | Resolved in this spike |
| --- | --- | --- |
| `@modelcontextprotocol/server` | `2.0.0` | `2.0.0` |
| `@modelcontextprotocol/node` | `2.0.0` | `2.0.0` |
| `hono` | `^4.11.4` | `4.12.9` |
| `zod` | `^4.2.0` | `4.4.3` |
| `fastmcp` | retained as `^3.24.0` | `3.34.0` |
| FastMCP's v1 SDK dependency | transitive | `@modelcontextprotocol/sdk@1.28.0` |

The previous plan's claims that this repository uses FastMCP `4.15.1` or that
its current v1 SDK is `1.24.3` were stale. The exact lockfile above is the
baseline for the next phase.

## Verified API surface

The tests exercise only public SDK v2 APIs:

- `new McpServer(serverInfo, options)` accepts `instructions`,
  `cacheHints`, and explicit `capabilities`.
- `server.registerTool(name, { description, inputSchema }, callback)` accepts
  every current application Zod v4 schema.
- `createMcpHandler(factory)` exposes `{ fetch, close, notify, bus }` and its
  default `legacy: 'stateless'` serves supported 2025-era HTTP requests from
  the same factory.
- `StdioServerTransport(input, output)` has an explicit `close()` method; the
  modern/both-era stdio entry is `serveStdio(factory, { transport })` from
  `@modelcontextprotocol/server/stdio`.
- Node HTTP host wiring is `toNodeHandler(handler)` from
  `@modelcontextprotocol/node`, not a FastMCP or `http.createServer` patch.

The temporary test adapter preserves the existing module seam exactly:

```text
addTool({ name, description, parameters, execute })
execute(args, { log })
```

It exists only in `tests/fixtures/mcpSdkV2Fixture.js`. It is not a production
facade and does not change tool callbacks yet.

## Executed compatibility results

`tests/mcpSdkV2Compatibility.test.js` proves the following in one process
with root Zod v4:

1. All **156** default schemas register through real `FastMCP@3.34.0`.
2. The same **156** default schemas register through an official
   `McpServer.registerTool` adapter.
3. An isolated official-SDK fixture supports modern `server/discover`,
   `tools/list`, and `tools/call` traffic. Its registration is sorted and two
   list calls return the same ordered catalog.
4. `ServerOptions.cacheHints` emits `ttlMs: 60000` and
   `cacheScope: 'private'` for `server/discover` and `tools/list`; the
   configured `instructions` appears in `server/discover`.
5. Explicit `{ capabilities: { tools: { listChanged: false } } }` is required.
   With no explicit false value, registering a tool makes `McpServer` advertise
   `tools.listChanged: true`, which would be false advertising for this server.
6. The default handler serves legacy stateless `initialize`, `tools/list`, and
   `tools/call` requests when the request accepts both `application/json` and
   `text/event-stream`. Those responses have no `Mcp-Session-Id` header.
7. `StdioServerTransport.close()` calls its close hook. Ending its input stream
   alone does **not** close it in 2.0.0, so the production facade must retain an
   explicit stdin-EOF shutdown path.

The passed registration proof authorizes testing a dual-runtime migration flag
in Phase 2. It does not authorize default transport cutover, removal of
FastMCP, or any session/read-handle behavior change.

## Observed SDK defects and required Phase 2 handling

These are executable baselines, not hoped-for behavior:

| Observation in `@modelcontextprotocol/server@2.0.0` | Evidence | Phase 2 consequence |
| --- | --- | --- |
| A modern `tools/list` request with a valid `_meta` envelope and `Mcp-Method`, but no `MCP-Protocol-Version` header, returns `200`. | `mcpSdkV2Compatibility.test.js` pins this request. | Add a narrow modern-only header check if the upstream defect remains. It must not reject legacy traffic. |
| An empty `subscriptions/listen` request receives an SSE acknowledgement, then its stream remains open with no second frame. | The fixture reads the acknowledgement then proves the second read stays pending. | Add the planned narrow empty-honored-subset response/close wrapper before the SDK listen router. The public handler offers only global `close()`, not a public per-listen close primitive. |
| `McpServer` defaults `tools.listChanged` to `true` after tool registration. | The fixture requires explicit `false` to obtain a truthful discovery result. | The facade must explicitly disable dynamic list capability until it actually emits list-change notifications. |
| Stdio input EOF does not close `StdioServerTransport`. | The fixture observes no close hook until explicit `close()`. | Retain a stdin EOF hook that calls the facade/transport shutdown path. |

The modern fixture request uses the required per-request envelope in
`params._meta`:

```text
io.modelcontextprotocol/protocolVersion = 2026-07-28
io.modelcontextprotocol/clientCapabilities = {}
```

It supplies `MCP-Protocol-Version` and `Mcp-Method` headers. `tools/call` also
supplies `Mcp-Name` matching `params.name`. The missing-protocol-header test is
deliberately the exception, preserved to detect the upstream fix.

## Corrected contracts for later migration phases

- **Read handles:** an HTTP Docs read result must include a top-level,
  server-minted opaque `readHandle`. Every guarded HTTP mutation must accept a
  required `readHandle` input. `expectedRevisionId` remains an optional
  compare-and-write assertion and never grants authorization. The handle is
  not a hidden context field and not inferred from a session.
- **Tracker scope:** the current read tracker already has callers in Docs,
  Sheets, and Drive/file reads. The migration cannot describe it as Docs-only
  state while designing its replacement.
- **Error and log redaction:** apply the final redactor to every caller-visible
  error and every log field after wrappers add hints or re-wrap an error. A
  `UserError` instance or a wrapper that claims to be one is not an exemption
  from secret-safe logging/output rules.
- **Stdio state:** modern stdio can use only connection-pinned implicit state.
  HTTP must require the explicit `readHandle`; it has no implicit/session
  fallback.

## Non-goals

This phase does not replace FastMCP, modify `dist/index.js`, remove session
routes, migrate error imports, or create production HTTP/stdio handlers. Those
changes remain Phase 2 and must use the observed contracts above.
