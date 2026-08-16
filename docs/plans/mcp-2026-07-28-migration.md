# Plan: adopt MCP specification 2026-07-28 (fastmcp → official TypeScript SDK v2)

Written 2026-08-08 against `main` @ 873270a. Spec citations verified against the published documents the same day.

## Why

The [2026-07-28 MCP specification](https://modelcontextprotocol.io/specification/2026-07-28) makes the protocol stateless, and this repo's hardest open problems — session-keyed tracker state, the HTTP request-guard monkey-patch, the always-on legacy SSE surface, working-copy collisions between clients — are all consequences of the *old* protocol's session model or of fastmcp's implementation of it. The announcement's framing matches this repo's #75 goal almost verbatim:

> "Every request is self-describing, with an optional discovery call for clients that want capabilities up front, so any request can land on any instance behind a plain round-robin load balancer."
> — [MCP blog, 2026-07-28 release post](https://blog.modelcontextprotocol.io/posts/2026-07-28/)

### Why the framework must change

This server is built on `fastmcp` (`package.json` pins `^3.24.0`, installed 3.34.0). fastmcp cannot speak the new revision, and this is not a version-bump problem:

- The latest published `fastmcp` (4.13.1, verified via `npm view fastmcp@4.13.1 dependencies` on 2026-08-08) still depends on the **legacy v1 SDK**: `"@modelcontextprotocol/sdk": "^1.24.3"`.
- fastmcp's own migration effort is unresolved: [punkpeye/fastmcp#300](https://github.com/punkpeye/fastmcp/issues/300) documents the codemod state and two blocking API decisions awaiting a maintainer call, with no timeline.
- The official TypeScript SDK v2 shipped stable: the monolithic `@modelcontextprotocol/sdk` is retired in favor of split packages; `@modelcontextprotocol/server` **2.0.0** is on npm (verified 2026-08-08).

Decision: **migrate to `@modelcontextprotocol/server` 2.0.0** and drop fastmcp. The inventory below shows the fastmcp API surface actually used here is small enough that a thin façade preserves every tool module, every test, and the local CLI unchanged.

### Backwards compatibility is handled by the SDK, not by us

Existing installed clients (Claude Desktop, older Claude Code, Cursor…) mostly still speak 2025-era MCP. The SDK v2 adoption guide ([Supporting protocol revision 2026-07-28](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)) covers both directions:

- **stdio:** replace `server.connect(new StdioServerTransport())` with `serveStdio(() => buildServer())`. New clients probe with `server/discover`; legacy clients fall back to the `initialize` handshake — *"the opening exchange selects the connection's era, and one factory instance is pinned per connection."* The spec makes the probe normative:
  > "Add `server/discover`: servers MUST implement this RPC to advertise their supported protocol versions, capabilities, and identity. Clients MAY call it before any other request for up-front version selection, or use it as a backward-compatibility probe on STDIO."
  > — [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), major change 3 (SEP-2575)
- **HTTP:** `createMcpHandler(() => buildServer())` — *"the v2 HTTP entry that serves 2026-07-28 per request — and, by default (`legacy: 'stateless'`), also serves 2025-era traffic per request… One factory, one endpoint, both eras."*

So the migration cannot strand any existing client configuration; `setup.js`'s stdio registrations keep working as-is.

## Verified current coupling (inventory, 2026-08-08)

| Coupling | Blast radius | Migration cost |
|---|---|---|
| `new FastMCP(...)` + `server.start(...)` | `dist/index.js:138-202` only | The core swap |
| `server.addTool({name, description, parameters(zod), execute})` | 235 call sites (~156 live tools), but all flow through two patch layers in `dist/tools/index.js:96-120,223-228` | Thin façade; tool modules untouched |
| `context.log` (2nd `execute` arg) | 281 calls in 116 files — the **only** context member used | Façade provides it |
| `UserError` from `'fastmcp'` | 128 files, 605 refs | Local `dist/errors.js` + mechanical import rewrite |
| `authenticate` option + `startWithRequestGuard` `http.createServer` monkey-patch | `dist/httpAuth.js:154-167,242-296`, `dist/index.js:145-193` | **Deleted** — SDK v2 accepts ordinary Node/Express middleware |
| Session-keyed state: `sessionContext.js` (AsyncLocalStorage of `sessionId`), `readTracker.js:23-46` per-session Maps, `server.on('disconnect')` eviction at `dist/index.js:154-161` | The conceptual core | Redesigned (below) — sessions no longer exist |
| Raw v1-SDK usage | `dist/cachedToolsList.js` only — dead code, imported by nothing | Delete |
| Never used: sampling, roots, elicitation, resources, prompts, progress, streamContent | — | Nothing to migrate |

Also relevant: tests never construct a FastMCP instance — all 37 suites and `scripts/call-local-tool.js` duck-type a `{ addTool }` server and call `tool.execute(args, { log })` directly. **A façade that preserves that shape leaves the entire test suite and local CLI untouched.**

## Design decisions

### 1. Registration façade, not a 156-tool rewrite

`dist/mcpServer.js` exports `buildServer()`: creates `new McpServer({ name: 'google-tools-mcp', version: <package.json version> })` (also fixing the hardcoded `1.0.0` at today's `dist/index.js:138-141`), and wraps it in an `addTool`-shaped adapter that maps to v2 `registerTool`, converts string returns to text content, converts thrown `UserError` into `isError` tool results, and passes `{ log }` in the context slot. The two existing `addTool` patch layers (auth-retry/session wrap at `dist/tools/index.js:96-120`; raw-def snapshot for legacy aliases at `:223-228`) patch the façade exactly as they patch fastmcp today. Zod stays at v3.24+: tool schemas are accepted because v2 takes Standard Schema — *"Tool schemas now use Standard Schema, so you can bring Zod v4, Valibot, ArkType, or any compatible library"* ([SDK beta announcement](https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/)) — and Zod implements Standard Schema since 3.24.0.

### 2. Cross-call state: revision-keyed handles replace sessions (merges #87)

The spec removes the thing our state is keyed on:

> "Remove protocol-level sessions and the `Mcp-Session-Id` header from the Streamable HTTP transport. … Servers that need cross-call state use explicit, server-minted handles passed as ordinary tool arguments."
> — [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), major change 1 (SEP-2567)

There is also no longer a disconnect event to evict on. The redesign — which **is** #87's plan, restated for a sessionless world:

- **Guard signal = Docs `revisionId`, exactly as #87 specifies** (revision-first, content-equality fallback, structural fingerprint bound). A read's identity is *what version was read*, not *who read it*.
- **Tracker keyed by `(fileId, revisionId)` globally instead of per-session.** Content at a given revision is identical no matter which client fetched it, so global keying cannot cross-contaminate — this deletes `sessionContext.js` and the `'\0default'` sentinel rather than porting them.
- **Mutations carry the handle as an ordinary argument.** `readDocument` returns the `revisionId` it read; guarded mutation tools accept `expectedRevisionId` and, when supplied, it both satisfies the guard and becomes the `WriteControl.requiredRevisionId` — which is #108's escape-hatch design, now as the primary mechanism. For stdio and single-client use, the process-local tracker still auto-fills this (no workflow regression; the spec removes *protocol* sessions, not server memory).
- **Eviction by TTL sweep** (on access + startup) instead of `disconnect`; entries and working-copy files older than a configurable age are dropped.
- **Working copies keyed by content, not by session:** `<docId>[.<tabId>].<rev-or-hash>.md`. Two clients reading the same doc at the same revision share one immutable-baseline copy; a divergent local edit is what #106's `.remote.md`/no-clobber contract already handles. #106's filename-composition contract must be revised to compose with this instead of a session suffix.
- `requestState` is available for multi-step flows and must be integrity-protected when used: *"servers MUST treat `requestState` as an attacker-controlled input… MUST protect its integrity (e.g. HMAC or AEAD)"* ([MRTR spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)). Phase 2 does not need it (handles are plain revision ids whose tampering can only cause a rejected write, the case the spec exempts), but the SDK's `createRequestStateCodec` is the tool if a future flow does.

### 3. Logging: `context.log` routes to stderr

The spec deprecates the MCP Logging feature and constrains notifications:

> "Deprecate the Roots, Sampling, and Logging features… Suggested migrations: … log to `stderr` (stdio) or use OpenTelemetry instead of Logging."
> "Log level is now set per-request via `io.modelcontextprotocol/logLevel` in `_meta`; servers MUST NOT emit `notifications/message` for requests that did not include this field."
> — [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), Deprecated 1 (SEP-2577) and major change 5 (SEP-2575)

Today fastmcp turns all 281 `context.log.*` calls into `notifications/message`. The façade's `log` object routes to `dist/logger.js` (stderr + optional file) instead — spec-compliant on both eras, zero edits in the 116 tool files, and it converges with #91's diagnostics direction (structured logs live server-side, not in protocol notifications). Per-request `logLevel` gating on modern connections is left to the SDK.

### 4. HTTP transport: middleware replaces the monkey-patch; legacy SSE dies

- `createMcpHandler` + the Node adapter, with our bearer-token/Origin check (`checkHttpAuth`, unchanged logic) as ordinary middleware in front. `startWithRequestGuard` — the `http.createServer` interception hack that exists only because fastmcp has no middleware hook — is deleted, along with the GET-stream/DELETE-session guard rationale (those routes no longer exist: no sessions, and the GET endpoint is replaced by `subscriptions/listen`, which we do not serve — we emit no list-changed notifications; all 12 categories load eagerly).
- The implicit `/sse` + `/messages` endpoints that mcp-proxy always stands up (`dist/httpAuth.js:220-229`) disappear with fastmcp. That transport is formally done: *"Reclassify the HTTP+SSE transport (deprecated since protocol version 2025-03-26) as Deprecated under the feature lifecycle policy… Migrate to Streamable HTTP"* ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), Deprecated 2).
- Required headers are validated by the SDK: *"Require standard MCP request headers (`Mcp-Method`, `Mcp-Name`) on Streamable HTTP POST requests"* (changelog, minor change 4, SEP-2243) — and they give any future reverse-proxy/rate-limit setup something to route on without parsing bodies.
- `GET /ping` and fastmcp's `/health`/`/ready` go away (`ping` is removed from the protocol; changelog major change 5). Liveness/identity is `server/discover` — which is also a better `/info` than the one #75 planned to hand-build, since it is mandatory, spec-shaped, and carries name/version/capabilities.
- Auth hardening items (RFC 9207 `iss` validation, CIMD-over-DCR) target OAuth-based MCP authorization; this server's MCP-layer auth is a static bearer token and its Google OAuth is upstream of MCP, so they impose no work — noted here so the audit of the changelog is complete.

### 5. Deletions the migration makes safe

- `dist/cachedToolsList.js` (dead; only raw v1-SDK import in the repo).
- The five dead duplicate Gmail modules at `dist/tools/` root (`settings.js`, `messages.js`, `threads.js`, `labels.js`, `drafts.js`, ~69 dead registrations) — this is the "dead modules" third of #74; porting dead code would be absurd.
- `dist/sessionContext.js` and the disconnect handler (decision 2).
- `fastmcp` (and transitively `mcp-proxy`, the v1 SDK) from `package.json`; `@modelcontextprotocol/server` in.

### 6. Cacheable, deterministic tool lists

> "Require `ttlMs` and `cacheScope` fields on results returned by `tools/list`, `prompts/list`, `resources/list`… `ttlMs` is a freshness hint (in milliseconds) allowing clients to cache responses and reduce polling."
> "Servers SHOULD return tools from `tools/list` in a deterministic order to enable client-side caching and improve LLM prompt cache hit rates."
> — [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), minor changes 5 (SEP-2549) and 3

The tool set is fixed at process start (eager category load, no `list_changed` emitted — deliberate, `dist/tools/index.js:231-234`), so: sort registrations deterministically, set a long `ttlMs` (e.g. 1h) with `cacheScope: 'private'` (the set varies with env flags like `GOOGLE_MCP_ENABLE_LEGACY_ALIASES`, so it is per-deployment, not publicly cacheable). With 156 tools this is a real prompt-cache and reconnect-latency win for clients. This retires the idea `cachedToolsList.js` was groping toward, properly.

### 7. MRTR: nothing to migrate, one future door opened

The breaking change — *"Servers MUST send server-to-client requests (such as `roots/list`, `sampling/createMessage`, or `elicitation/create`) using the MRTR pattern. The previous pattern of server-initiated requests is no longer supported."* ([MRTR spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)) — costs this repo nothing: the inventory found zero uses of elicitation, sampling, or roots. Out of scope but now possible: returning `inputRequired()` with an elicitation from destructive Docs operations (#88's confirm/preview flow) and surfacing the Google OAuth consent URL via URL-mode elicitation instead of stderr. Both are follow-ups, not this PR.

## Issues this plan resolves

**Closed by this PR:**

- **#75 — Master: make shared HTTP transport production-ready.** The session-bleed risk, the request-guard hack, the unauthenticated `/ping`, the missing instance identity (`server/discover` replaces the planned `/info`), and the stray SSE surface are all resolved by decisions 2 and 4. Phase 4 lands the remaining operational items from the #75 plan (persistent token file, `serve`/`status`/`stop`, setup writing native HTTP client configs) minus everything session-related, which is obsolete. The plan's mandatory "two clients, session isolation over real HTTP" E2E becomes "two clients, stateless handle correctness over real HTTP" — strictly simpler and finally buildable.
- **#87 — Master: correct Docs read/write state and isolate working copies.** Decision 2 is #87's plan (revision-first guard, create-seeding, guard-bypass closure on the seven unguarded tools, working-copy isolation) re-founded on spec-blessed handles instead of session suffixes. All of #87's tests port; the session-suffix/disconnect-cleanup tests are replaced by TTL-sweep and revision-keying tests.

**Substantially resolved, issue stays open with reduced scope:**

- **#108 — conflict-guard precision.** The headline symptom (metadata-only change blocks an edit with an empty diff) falls to revision-first detection, and `expectedRevisionId` lands here wired end-to-end (guard + `WriteControl`). Remaining for #108: `targetRange` overlap classification, tiered explanations, re-resolution — which depend on #88's `findTextRangeInDoc` and stay sequenced after it.
- **#74 — Gmail maintenance.** Dead-module deletion happens here (decision 5); duplicate dispatch and parameter-doc work remain.
- **#56 — test blind spots.** The real-transport E2E seam (mock `dist/clients.js` behind an env gate) and the create-then-write regression test land here as part of phases 2/4 testing; remaining package-blind-spot items stay.
- **#91 — diagnostics.** Logging moves fully server-side per the spec (decision 3), which is the architecture #91 assumes; its JSONL/redaction/runbook content remains its own work. Bonus: the SDK's request layer replaces fastmcp dispatch, making #91's noted follow-up (instrumenting pre-execute dispatch failures) reachable.

**Explicitly not resolved by the spec** (tool-design problems, unchanged plans): #105, #106 (its working-copy filename contract needs a small revision to compose with revision-keyed copies — flagged in its plan), #107, #88, #86, #96, #99, #14, #73, #71, #82, #48, #50.

**Plan-queue impact:** land this migration **before** #71 (both touch every tool file's import block; two full-tree rebases would be miserable) and revise the `docs/plans/README.md` ordering accordingly. #82/#48 sequencing is unchanged; #75's plan file should be re-read through this document before its Phase-4 work starts.

## Implementation (one PR, four reviewable phases/commits)

**Phase 1 — core swap (behavior-neutral).**
`package.json` deps; `dist/errors.js` (`UserError`) + mechanical import rewrite across 128 files; `dist/mcpServer.js` façade (`buildServer()`, addTool adapter, stderr `log`); `dist/index.js` rewired to `serveStdio(buildServer)` / `createMcpHandler(buildServer)` + auth middleware; delete `startWithRequestGuard`, `cachedToolsList.js`, dead Gmail root modules; fix served version string. All existing tests must pass unmodified — that is the phase's acceptance gate.

**Phase 2 — state model (merges #87).**
`readTracker.js`: revision-first `guardMutation` + content-equality fallback + structural fingerprint, global `(fileId, revisionId)` keying, TTL eviction, `scope` (tab) field; `expectedRevisionId` parameter on guarded Docs mutation tools, doubling as `WriteControl`; create-seeding (`createDocument`, `createFromTemplate` success-only; `copyFile` deliberately unseeded); guard the seven bypassing tools (`insertImage` pre-upload); `workspace.js` revision-keyed paths + sweep; delete `sessionContext.js`.

**Phase 3 — protocol features.**
Deterministic tool ordering + `ttlMs`/`cacheScope` on `tools/list`; `server/discover` identity fields verified; per-request `logLevel` behavior confirmed against SDK defaults; capability declarations audited (no roots/sampling/logging/elicitation advertised).

**Phase 4 — HTTP operational layer (the surviving #75 scope).**
Persistent token file + `GOOGLE_MCP_HTTP_TOKEN` precedence; `serve`/`status`/`stop` subcommands with the atomic state file from #75's plan (status uses `server/discover` instead of `/ping`+`/info`); non-loopback refusal unconditional; `setup.js` HTTP registration (Claude Code `--transport http` + Codex TOML) with the live end-probe; `docs/http-mode.md`.

## Tests

- Phase 1 gate: entire existing suite green with zero test edits (proves the façade contract).
- New `tests/protocol.e2e.test.js` over real transports, using the env-gated `dist/clients.js` mock seam: (a) modern client via `server/discover` on stdio; (b) legacy client via `initialize` on stdio (era fallback); (c) HTTP: modern stateless request with `Mcp-Method`/`Mcp-Name` headers honored, legacy 2025-era request served from the same endpoint, `/sse` returns 404, unauthenticated request refused by middleware.
- `tools/list`: deterministic order across two calls/instances; `ttlMs`/`cacheScope` present.
- State model: all of #87's ported guard tests; two concurrent HTTP clients — client A reads at rev N, external edit → rev N+1, client A's write rejected with diff while a fresh read-then-write succeeds; `expectedRevisionId` correct → proceeds and appears as `requiredRevisionId`; stale → rejected naming both; TTL sweep removes aged entries and working-copy files.
- Logging: a tool's `log.info` reaches stderr/file and produces **no** `notifications/message` on a request without `io.modelcontextprotocol/logLevel`.

## Acceptance criteria

- A 2026-07-28 client and a 2025-era client both work against the same build on both transports, per the SDK's dual-era contract (*"nothing in v2 puts a 2026-07-28 byte on the wire by default"* — serving modern is our explicit opt-in via `serveStdio`/`createMcpHandler`).
- No `Mcp-Session-Id`, no `/sse`, no `/ping`, no session objects anywhere in `dist/`; grep-clean for `fastmcp`.
- Two clients sharing one HTTP instance cannot corrupt each other's read/write guard state or working copies — proven over the wire, not just in unit tests.
- Existing user configs (stdio `command`+`args`) work without any re-setup.
- Issues #75 and #87 closable with links to the landed tests; #108/#74/#56/#91 updated with what landed and what remains.

## Risks / open questions

- **SDK v2.0.0 is ~2 weeks old.** Mitigation: the façade confines SDK API churn to `mcpServer.js` + `index.js`; pin exact version.
- **Per-request server construction cost on HTTP** (156 `registerTool` calls). Category imports are module-cached; if profiling shows registration overhead, memoize the built server per era — verify what `createMcpHandler` caches before optimizing. `docs/startup-performance.md` numbers should be re-measured after Phase 1.
- **Client-era reality check:** confirm current Claude Code/Desktop behavior against `serveStdio` fallback early in Phase 1 (manual smoke), since the era handshake is the one thing unit tests can't fully prove.
- The legacy-alias layer re-registers tools through the same façade — verify alias count and the double-wrap invariant (`dist/tools/index.js:211-222`) still hold under v2 registration.
