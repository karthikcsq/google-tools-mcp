# Plan: adopt MCP specification 2026-07-28 (fastmcp to official TypeScript SDK v2)

Written 2026-08-08, revised after adversarial review, revised again 2026-08-16 with client-implementation evidence and known SDK defects. This is a migration plan, not implementation authorization. Re-verify every source anchor and SDK API against the exact locked dependency before coding.

## Root cause

The current runtime (`dist/`) uses FastMCP and the v1 MCP SDK. It couples Docs, Sheets, and Drive/file-read tracker state plus temporary working files to HTTP sessions, then compensates with an `http.createServer` request-guard interception in `dist/httpAuth.js`. That design cannot safely represent a stateless 2026-07-28 HTTP request. The current lockfile resolves `fastmcp@3.34.0`, whose v1 SDK dependency resolves to `@modelcontextprotocol/sdk@1.28.0`; these exact locked versions, rather than stale package-registry examples, are the migration baseline. The upstream FastMCP migration issue previously cited here, [#300](https://github.com/punkpeye/fastmcp/issues/300), is closed and is not a dependency or a reason to wait.

The protocol removes server-managed HTTP sessions and uses self-describing requests. See the [2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28), its [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), and the official SDK's [2026-07-28 migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28). The root fix is to own the small server integration layer directly, give cross-call Docs state an authenticated explicit capability, and remove the session-era transport code.

## Client implementation evidence (verified 2026-08-16)

Three weeks after the revision shipped, both clients this server actually serves have implemented it. Their published behavior and bug fixes are constraints on our server, not background reading, and they resolve several questions this plan previously deferred to the spike.

**Claude Code** (`anthropics/claude-code` CHANGELOG, at 2.1.233):

- 2.1.233: *"Fixed MCP v2 connections endlessly reopening the subscriptions/listen stream against servers that terminate long-held streams on a fixed timeout (e.g. serverless hosts)"* — a v2 client will open `subscriptions/listen` against our HTTP endpoint, and how the server ends that stream decides whether the client reconnect-loops.
- 2.1.232: *"Fixed MCP connections hanging for the full 30-second connect timeout when a server fails to answer or sends a malformed reply to the protocol-version probe"* — the `server/discover` answer must be prompt and well-formed or client startup stalls.
- 2.1.153: *"Fixed stateful MCP servers without the optional GET SSE stream reconnect-looping on `tools/list`"* — reconnect loops are a recurring failure class for this transport shape.
- 2.1.132: *"Fixed unbounded memory growth (10GB+ RSS) when a stdio MCP server writes non-protocol data to stdout"* — stdout purity is a client-crashing constraint, not hygiene.
- 2.1.76 added elicitation (form and browser-URL modes) plus `Elicitation`/`ElicitationResult` hooks, so MRTR-delivered elicitation is usable client-side today.

**Codex** (`openai/codex`, commit [`be2e4afc`](https://github.com/openai/codex/commit/be2e4afc), "Add MCP 2026-07-28 discovery support" #35724):

- Modern mode is behind the `Feature::Mcp20260728` flag: *"Add an opt-in `mcp_2026_07_28` protocol mode while preserving the legacy lifecycle by default."*
- **stdio servers must opt in through their own config env block:** *"Require stdio servers to opt in with `CODEX_MCP_PROTOCOL_VERSION=2026-07-28`."* The dispatch in `codex-rs/codex-mcp/src/connection_manager.rs` pins any stdio server whose `env` lacks that key to `McpProtocolMode::Legacy`, regardless of the feature flag. Whichever plan owns Codex registration (#75/#48 setup work) must write that env var; it is inert while the flag is off and harmless either way because this server serves both eras.
- HTTP negotiation is unforgiving of ambiguity: *"fallback only when a response establishes that the endpoint is legacy-only."*
- Clients cache our catalog: `0ca43990` fingerprints "transport settings, relevant environment variables, protocol mode, plugin status, and client capabilities" for a process-scoped tool-catalog cache, and `42b5f05c` keeps namespace descriptions so *"cached definitions now expose the server instructions to the model before a lazily started MCP connection finishes initializing."* This is the concrete payoff for deterministic ordering plus cache hints, and the reason to supply server `instructions` (today the FastMCP construction passes none).

## Scope and compatibility contract

- The Phase 1 lockfile declares exact `@modelcontextprotocol/server@2.0.0` and `@modelcontextprotocol/node@2.0.0`, direct compatible `hono`, root Zod `>=4.2`, and Node `>=20`, while retaining FastMCP as the default runtime. Audit Zod v4 parsing/error-shape changes before changing any tool contract.
- Preserve existing stdio configuration (`command` and `args`) and test both a modern 2026-07-28 stdio client and a legacy stdio client.
- Keep the official SDK's stateless legacy HTTP compatibility path and test a legacy HTTP request against the same authenticated endpoint.
- Removing current sessionful HTTP, including `/sse` and session lifecycle routes, is a documented breaking change. Release notes, `docs/http-mode.md`, and setup output must name the removed endpoints and the required client reconfiguration. This is not silently presented as transparent compatibility.
- Retain a minimal authenticated `GET /healthz`. It returns liveness only, after the same bearer-token and Origin checks as MCP requests. Its fixed minimal payload contains no server version, profile, tool, handle, client, or environment identity. It is operational health, not a second MCP discovery or status endpoint.
- This first release explicitly supports one process serving one configured Google profile and one effective service principal. In-memory handles, trackers, and workspace ownership are valid only for that deployment. Horizontal scale or multiple profiles requires a separately designed shared, credential/profile-partitioned state store and is out of scope.

## Verified inventory and guardrail

The affected runtime seam is `dist/index.js` (FastMCP construction/start), `dist/httpAuth.js` (request interception), `dist/tools/index.js` (registration patch layers), `dist/readTracker.js`, `dist/sessionContext.js`, `dist/workspace.js`, and every `fastmcp` `UserError` import. `dist/cachedToolsList.js` is the only raw v1 SDK import and is unused.

Do not carry forward stale hand-counts of tools, registrations, calls, or imports. The first PR adds `scripts/inventory-mcp-migration.mjs`, which enumerates tracked runtime/test files and reports: FastMCP imports, raw SDK imports, `addTool` registrations, `UserError` imports, `context.log` call sites, and loaded tool count. The committed output and a test snapshot become the migration baseline. Any count stated in implementation PRs must be generated by that script.

## Design decisions

### 1. Select the official SDK through a constrained facade spike

The Phase 1 fixture records the selected official SDK surface in [the compatibility ADR](../decisions/2026-08-16-mcp-sdk-v2-compatibility-spike.md). `ViteMCP` is not a candidate: `npm view vitemcp` returned `E404` on 2026-08-16, so no npm package/release exists to compare. The selected direction is a thin local facade over `@modelcontextprotocol/server@2.0.0` and `@modelcontextprotocol/node@2.0.0`.

The spike must register real tool schemas, exercise real stdio and authenticated HTTP wire calls, preserve the current `addTool({ name, description, parameters, execute })` seam, and invoke each module callback as `execute(args, { log })`. It must convert `UserError`, cleanly shut down, and expose no session API. The ADR records package versions, API observations, known defects, and the ViteMCP rejection rationale. The official SDK is selected because that fixture proves the required surface with no extra framework dependency.

The selected facade owns `buildServer()`, tool registration, result/error adaptation, logger context, and shutdown. Tool modules stay unchanged until a later issue intentionally changes their behavior. `UserError` moves to local `dist/errors.js`; imports are mechanically rewritten and verified by the inventory script.

### 2. Explicit `readHandle` replaces HTTP session state (#87 replacement)

HTTP mutation authorization must use an explicit `readHandle`, never a revision ID alone and never a client-supplied unsigned object. A successful HTTP Docs read returns `readHandle` as a named top-level field in its structured result alongside the normal read content, regardless of `format`; every guarded HTTP mutation declares a required `readHandle` input field. Neither field is hidden in transport context or inferred from a session. On a successful Docs read, the server mints a high-entropy opaque handle and stores its record:

`servicePrincipalFingerprint`, configured Google `profile`, `fileId`, `tabId`, `revisionId`, structural `fingerprint`, `issuedAt`, `expiresAt`, and a credential/profile invalidation epoch.

The authenticated bearer credential and configured Google profile define the one effective service principal in this release. Middleware derives and retains only a non-reversible credential fingerprint, never the raw token; it does not distinguish individual clients that share the token. Every guarded mutation requires the handle, looks it up in a process-local store, checks its credential fingerprint, configured profile, invalidation epoch, remaining bindings, and expiry, then applies the stored revision as Docs `WriteControl.requiredRevisionId`. Token rotation or configured-profile change invalidates every outstanding handle before a further mutation. Handles expire in less than 24 hours and are single-purpose only if the final tool contract requires it; otherwise their replay semantics and allowed mutation set must be explicit and tested. Guessing, swapping credential/profile/file/tab, or reusing an expired handle fails before a Google write.

HTTP cross-client safety does not rely on distinguishing callers that hold the same token. It comes from an unguessable explicit capability per read and a unique editable workspace per handle. Two clients with the shared bearer may use only handles they possess; neither can infer another handle or alter that handle's editable file through its own handle.

Only a pinned stdio connection may use implicit current-read state. That state is scoped to the live connection, never a global default, and is destroyed at connection shutdown. A stdio caller may also pass an explicit handle for parity. HTTP has no implicit fallback.

`expectedRevisionId` from #108 is retained as a caller-visible compare-and-write assertion, but it never authorizes a write by itself. If supplied with a handle it must equal the handle record's revision; the actual `WriteControl` value comes from the validated record. The separate #108 work still owns target-range overlap classification, re-resolution, and explanatory tiers after #88.

### 3. Workspace ownership separates editable copies from immutable baselines

Each `readHandle` owns a unique editable workspace directory/file. The server also keeps a content-addressed immutable baseline keyed by `(profile, fileId, tabId, revisionId, fingerprint)` that can be shared safely. A handle workspace is initialized from that baseline and never shared with another handle, even when two reads see identical content.

Expiry cleanup may remove expired handles and immutable baselines with no live references. It must never delete a dirty editable workspace. A dirty workspace is retained, reported by status/diagnostics, and requires explicit recovery or an operator-approved cleanup policy. Cleanup uses an ownership manifest and exact paths, never a broad glob. This replaces #106's session-suffix filename contract; update that plan before it is implemented.

### 4. HTTP is ordinary middleware plus a narrow authenticated health route

Delete `startWithRequestGuard`, the monkey-patched `http.createServer` path, session disconnect logic, and the legacy SSE endpoints. Put existing bearer-token and Origin validation ahead of the SDK handler and `GET /healthz`; test middleware ordering over the wire. Do not add #75's token persistence, process manager, setup rewrites, or operational commands to this migration.

`server/discover` remains protocol discovery. `/healthz` remains a liveness-only operational endpoint. Its response must not disclose token state, handles, profile identifiers, tool list, environment values, or server/client identity. Modern SDK `_meta` client identity is supplemental observability data after authentication, not an authorization input. The later #75 `status` command must authenticate as a modern SDK client and obtain server identity from the authenticated protocol response `_meta`, never from `/healthz` or a hand-parsed discovery body.

The SDK's `subscriptions/listen` behavior still needs confirmation in the spike, but it is no longer an open question — the answer is known and the spike verifies it rather than discovers it. This server has no dynamic tool/resource list changes and must not advertise or emit list-change events it cannot support, so the honored notification subset for any listen request is empty. Two verified facts make "let the SDK default handle it" the wrong choice:

1. Real clients open the stream (Claude Code 2.1.233, above).
2. The SDK holds an empty stream open forever. [typescript-sdk#2650](https://github.com/modelcontextprotocol/typescript-sdk/issues/2650), open: *"When a server advertises no `listChanged` capabilities and no `resources.subscribe`, `honored` is `{}`. The stream can never carry a single notification, and nothing in the router ever closes it… The connection is held open, indefinitely, to deliver a set that is provably empty."*

Required behavior: when the honored subset is empty, respond to the `subscriptions/listen` request with the empty result and close the stream immediately, which is the spec's graceful-closure path — *"it SHOULD respond to the original `subscriptions/listen` request with an empty result before closing the stream… A client that receives this response knows the subscription closed cleanly; a transport that closes without it indicates an unexpected disconnect, which the client MAY treat as a trigger to reconnect"* ([Subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)). That distinction is exactly what separates a clean close from the reconnect loop Claude Code had to patch around. Prefer the supported SDK API if one exists; otherwise a narrow wrapper ahead of the listen router, removed when #2650 lands upstream. An empty acknowledged filter is legitimate: *"Notification types the server does not support are omitted."* If any stream is ever held open, the spec's SSE hygiene applies — `X-Accel-Buffering: no` and periodic `:\r\n` keep-alive comments. Auth must cover the listen route like every other route.

Old-transport verbs get the spec's answers, not improvised ones: *"HTTP GET or DELETE to the MCP endpoint: respond with `405 Method Not Allowed`. An `Mcp-Session-Id` header on a request: ignore it, and do not mint or echo session IDs. A `Last-Event-ID` header: ignore it; streams are not resumable"* ([Streamable HTTP: Backward Compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)). Because the stateless legacy path is retained, confirm what the SDK actually returns on those verbs and pin it in the wire tests rather than asserting a number this plan invented.

Header validation is a server obligation on modern POSTs — `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` must be present and must match the body, with `400` plus `-32020 HeaderMismatch` on mismatch. The SDK enforces most of this but not all: [typescript-sdk#2589](https://github.com/modelcontextprotocol/typescript-sdk/issues/2589), open, reports that `createMcpHandler` accepts a modern POST whose `MCP-Protocol-Version` header is absent. Do not route, authorize, or rate-limit on header presence. Re-check that issue in PR 1; only add a middleware check if it is still open, and only in a way that cannot fire on legacy-era POSTs, which carry no such header. This server adopts no `x-mcp-header` / `Mcp-Param-*` mirroring: it is optional for servers and no tool parameter belongs in a header.

### 5. Cache hints and logging

Use the SDK-supported `ServerOptions.cacheHints` configuration for deterministic `tools/list` responses. Sort registrations deterministically, set an intentionally selected TTL and private cache scope, and prove the emitted v2 wire response carries the configured hints. Do not hand-roll an obsolete `tools/list` response or revive `cachedToolsList.js`. Private scope is the right default because the tool set varies per deployment with env flags such as `GOOGLE_MCP_ENABLE_LEGACY_ALIASES`, so it is not safe for a shared intermediary to cache. Apply the same treatment to the `server/discover` result, which also supports caching, and carry `instructions` there — Codex reads exactly that field out of its catalog cache before a lazily started connection finishes.

Pagination is not a concern in this release and should not be designed for: [typescript-sdk#2352](https://github.com/modelcontextprotocol/typescript-sdk/issues/2352), open, records that `McpServer` does not implement server-side pagination for list operations, so the whole tool list returns in one response with no cursor. That is the safer side of the trade here, since Codex rejects repeated cursors in modern mode and we emit none. It does mean one large payload per cold client, which is an argument for the cache hints above, not against them. Re-check the issue at PR 1; if pagination lands upstream, cursors must be derived deterministically from the sorted registration order.

The facade maps the current callback's `{ log }` object to server-side stderr/structured logging. Respect modern request log-level metadata where supported, and do not emit deprecated logging notifications when the request did not negotiate them. Two stdio constraints are absolute and belong to the facade, not to individual tools: stdout carries protocol messages only (*"The server MUST NOT write anything to its `stdout` that is not a valid MCP message"*, and Claude Code 2.1.132 shows the failure mode is 10GB+ of client RSS), and the `server/discover` reply must be well-formed and fast, before any Google auth or network work, because a missing or malformed answer costs the client a 30-second stall (Claude Code 2.1.232).

### 6. The facade sanitizes errors, because the SDK cannot

New in the 2026-08-16 revision, and a correctness issue rather than polish. [typescript-sdk#2656](https://github.com/modelcontextprotocol/typescript-sdk/issues/2656), open: `McpServer`'s `tools/call` handler funnels every throw into a tool-execution result — *"Every thrown error — regardless of `McpError` code, regardless of whether it represents a business-level failure or a genuine unhandled/internal exception — is funneled into a Tool Execution Error… there's no way to reach the spec's 'server errors' protocol-error case at all."* The related [#1429](https://github.com/modelcontextprotocol/typescript-sdk/issues/1429) is specifically about raw internal messages leaking to clients through that same catch.

Consequence: an unhandled internal exception — a gaxios error whose message carries a request URL with an API key, a stack naming a token — is returned verbatim to the caller as `isError: true` text. FastMCP behaves similarly today, so this is not a migration regression, but the facade is the moment the boundary becomes ours to define. The facade's execute wrapper classifies before returning, then applies the secret redactor to every caller-visible error string and every server-side log field. `UserError` is eligible for a user-facing message only after that redaction; a hint wrapper, subclass, or unsafe wrapper that claims to be a `UserError` is never an exemption. The full original error must not be written to ordinary logs unredacted. This is the same classifier and redactor #91 specifies, pulled forward only as far as this boundary requires; #91 keeps its JSONL records, rotation, and runbook.

Keep the existing stdin `close`/`end` shutdown path rather than delegating it to the SDK. The stdio binding asks for it — *"Servers SHOULD exit promptly when their standard input is closed or reads return end-of-file. This is the primary graceful-shutdown signal and the only portable one"* — and the SDK's own fix is still an unmerged PR ([typescript-sdk#2494](https://github.com/modelcontextprotocol/typescript-sdk/pull/2494)), whose description documents the zombie-process accumulation inherited by servers that rely on the SDK for it.

### 7. Structural prerequisites

#105 remains a public Docs feature, but this migration cannot hide it as a prerequisite. Add a small internal structural walker now, with no new public tool or parameter: it traverses tabs, structural elements, paragraphs, tables, and text runs using stable internal result types. #105 later exposes its public indexed/limited read behavior on top of that walker. Tests must prove the migration works when #105 has not landed.

## Issue disposition and sequencing

- **#87 stays open during migration.** Close it only after the handle replacement passes its stated migration tests: explicit HTTP handle binding, connection-pinned stdio state, write-control enforcement, isolated editable workspaces, immutable baselines, dirty-file preservation, expiry, and shutdown cleanup.
- **#75 stays open, narrowed.** This migration removes its session-era transport core. Its remaining plan owns deployment operations, token persistence, lifecycle commands, configuration writing, and production hardening, sequenced after the migration is stable. Its former operational work is outside this plan. One new item belongs to it or to #48, whichever lands the client-registration work: a Codex stdio registration must write `CODEX_MCP_PROTOCOL_VERSION=2026-07-28` into the server's env block, since Codex otherwise pins stdio servers to the legacy lifecycle regardless of its own feature flag.
- **#108 remains open.** This migration lands `expectedRevisionId` only as a validated handle companion. Its precision/re-resolution work remains sequenced after #88.
- **#105 remains open.** The internal walker lands here without changing its public API; the user-facing index/limit feature remains #105.
- **#71 is hard-blocked on this migration.** Both touch every tool import/registration path. Land this first, then rebase #71 once.
- #106 must adopt handle workspaces and immutable baselines before implementation. #74, #56, and #91 receive only the directly landed pieces documented in their issue comments. This migration does not delete or consolidate Gmail modules; that work remains wholly owned by #74.

## Implementation sequence: rollback-safe PRs

Each PR is independently reviewed and published only after its gates pass. A runtime-selection flag is permitted only after a proof that fastmcp and the selected SDK path can coexist with the same Zod version and tool schemas. If that proof fails, the cutover is atomic and rollback is the tested release-tag/git-revert path, not a false feature flag.

### PR 1: inventory, platform floor, and SDK decision spike

- Add the inventory script/snapshot and Node 20/22 CI smoke matrix.
- Build the official-SDK isolated fixture, including `@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/node@2.0.0`, and root Zod `>=4.2`; record its actual API and wire evidence in the ADR. ViteMCP is already rejected because no npm package exists.
- Upgrade the root Zod dependency in this PR, but do not replace FastMCP, add a production transport, or alter a tool's public contract. The default runtime remains FastMCP; its all-schema Zod v4 registration proof is a decision gate, not a transport cutover.
- As a decision gate, prove whether FastMCP and the official SDK can register every existing default tool schema with the same root Zod v4 process. Record the result. Only a passing proof authorizes a dual-runtime flag in later PRs.
- Re-check every entry in the upstream defect table below and record its state in the ADR. Their states are what several decisions in this plan are conditioned on, and they are three weeks old at most.
- The fixture must pin current legacy stateless HTTP behavior, missing-modern-header behavior, empty `subscriptions/listen` behavior, and stdin-EOF shutdown behavior. Future SDK updates either remove the corresponding workaround or update this record deliberately.

### PR 2: facade and transport, using the proven rollout path

- Add `dist/mcpServer.js`, `dist/errors.js`, and the internal structural walker. Preserve the current `addTool` testing seam while registering real SDK tools.
- If PR 1 proved dual-runtime Zod/schema compatibility, add the new stdio and stateless HTTP serving path behind an explicit migration flag and retain fastmcp temporarily. If it did not, atomically install exact `@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/node@2.0.0`, and Zod `>=4.2`, update the lockfile, replace fastmcp, and cut over every registered schema in this PR.
- Implement authenticated `/healthz`, middleware ordering, deterministic registration, `ServerOptions.cacheHints`, server-side logging, error sanitization at the facade boundary, the empty-honored `subscriptions/listen` close, server `instructions`, and shutdown hooks including the retained stdin-EOF path.
- In the dual-runtime path, delete no legacy transport or session code yet and use the tested flag as rollback. In the atomic path, tag the last fastmcp release before merge and rehearse a git revert/redeploy rollback before release.

### PR 3: handle and workspace replacement

- Implement server-minted opaque handles, non-reversible credential-fingerprint/profile/epoch binding checks, rotation/profile invalidation, `<24h` expiry, connection-pinned stdio implicit state, and `expectedRevisionId` comparison.
- Implement per-handle editable workspaces, immutable baselines, ownership manifests, dirty-file retention, safe expiry cleanup, and explicit shutdown handling.
- Port #87 guard behavior and `WriteControl` wiring. Seed create/template flows only after a successful API response; leave deliberately unsupported flows unseeded and explicit.
- Exercise the internal walker only internally. #105's public tool API remains untouched.
- In the dual-runtime path, keep the handle path behind the already proven migration flag. In the atomic path, rely on the release-tag/git-revert rollback proven in PR 2.

### PR 4: cutover and removals

- Make the official SDK path the default after real-client smoke succeeds. Remove fastmcp, `mcp-proxy`, raw v1 SDK code, `cachedToolsList.js`, `sessionContext.js`, disconnect handlers, the request-guard monkey-patch, `/sse`, and other sessionful HTTP routes.
- In the dual-runtime path, remove the feature flag only after the full suite, wire matrix, rollback rehearsal, and release-note review pass. In the atomic path, retain the release tag at the final fastmcp version and the rehearsed git-revert/redeploy procedure as the operational rollback.
- Update docs/configuration with the HTTP breaking change and exact client migration instructions. Do not implement #75 operational scope here.

## Required tests

### Facade and protocol wire tests

- A real SDK client over stdio performs modern discovery, lists tools, calls a tool, and shuts down cleanly.
- A legacy stdio client completes its supported initialization path and calls the same tool.
- A modern authenticated HTTP client makes discover/list/call requests. A legacy stateless HTTP client makes its supported request against the same endpoint.
- The tests assert actual request/response wire shapes, cache hints, tool ordering, protocol identity, and that no session ID is required or returned.
- `server/discover` returns a well-formed result carrying supported versions, capabilities, `serverInfo`, and `instructions`, within a strict time bound and without depending on Google auth or network access. The bound is asserted because the client-side cost of failing it is a 30-second stall, not a slow test.
- Nothing but valid protocol messages reaches stdout while a tool logs at every level on the stdio path.
- `subscriptions/listen` against the authenticated HTTP endpoint returns the empty result and closes promptly. The test asserts the connection does not stay open — the #2650 regression — and that the close carries the graceful response rather than being a bare transport drop.
- Modern POSTs missing or contradicting `MCP-Protocol-Version`, `Mcp-Method`, or `Mcp-Name` produce the documented status and error code; whatever the SDK does with the `MCP-Protocol-Version` absence case per #2589 is pinned as observed behavior so a future SDK change is caught rather than assumed.
- A tool that throws any error carrying a secret in its message returns a sanitized result containing no secret. The redactor applies to ordinary errors, `UserError`, and every wrapper/hint path; server-side logs contain only the redacted diagnostic fields.
- `/sse` and former session endpoints return the documented removal response. `/healthz` rejects missing/invalid token or Origin before returning exactly its fixed liveness payload; a valid response contains no version, profile, server, client, tool, handle, or environment identity.
- Test supported `_meta` client identity as authenticated observability metadata with modern SDK traffic, and prove spoofed/unauthenticated metadata has no authority. #75 separately tests its authenticated SDK `status` client reading server identity from the protocol response `_meta`.
- Start, close, and restart stdio/HTTP servers in one process. Assert timers, connection state, handle stores, and filesystem resources are closed or retained according to the dirty-workspace rule.

### Handle, guard, and workspace tests

- A valid HTTP handle permits only its bound service-principal fingerprint, configured profile, invalidation epoch, file, tab, revision, and structural fingerprint. One negative case per binding, token rotation, configured-profile change, an expired handle, malformed/unknown handle, and random high-entropy guessing all fail without a Google write. Tests assert no raw credential is stored or logged.
- HTTP without a handle fails even if it supplies a current revision. A pinned stdio connection succeeds from its own implicit read state; a second connection cannot consume it.
- `expectedRevisionId` matching the validated handle reaches `WriteControl.requiredRevisionId`; mismatch fails before the write. A remote revision change produces the documented conflict result.
- Two handles for identical content receive distinct editable files while sharing one immutable baseline. Handle A's edit never appears in B. Expiry never deletes a dirty workspace, and a clean unreferenced baseline is reclaimed only after its last handle expires.
- An external structural change produces a fingerprint conflict. The migration's internal walker is unit-tested across text, tables, tabs, and nested structural elements without exposing #105's public index API.
- The `subscriptions/listen` spike result is covered by a real authenticated request test matching the selected SDK configuration.

### Package and regression gates

- `npm ci` and the complete Jest suite pass under Node 20 and Node 22.
- The generated inventory snapshot is clean; no fastmcp/raw v1 import remains after PR 4.
- Existing direct-tool tests still work through the facade's `{ addTool }` shape. The load-bearing live-tool count tests remain green without hand-updating unrelated tool totals.

## Acceptance criteria

- `package.json` and lockfile install exact `@modelcontextprotocol/server@2.0.0` and `@modelcontextprotocol/node@2.0.0`, Zod `>=4.2`, and Node `>=20`; Node 20 and 22 CI are green.
- The selected official SDK facade has the recorded npm `E404` ViteMCP rejection and passed real-SDK stdio/HTTP/auth/shutdown tests.
- Modern stdio, legacy stdio, modern authenticated HTTP, and legacy stateless authenticated HTTP all call a real tool on the same release build. The removal of sessionful HTTP is documented and tested.
- Every HTTP Docs mutation has a validated, unguessable, server-minted `readHandle` bound to the effective service-principal credential fingerprint, configured profile, invalidation epoch, file/tab/revision/fingerprint, and an expiry under 24 hours. A revision string alone cannot authorize it. The one-token deployment does not claim per-client identity isolation.
- Stdio implicit read state is connection-pinned; no HTTP session state, global default read state, `Mcp-Session-Id`, or session cleanup remains.
- Editable workspaces are unique per handle; immutable baselines are shareable; TTL cleanup preserves every dirty file. The deployment limitation is explicit in docs and startup diagnostics.
- `/healthz` is authenticated and returns liveness only. `server/discover` is protocol discovery, while #75's later authenticated SDK `status` client reads server identity from response `_meta`. Auth, middleware ordering, metadata treatment, and `subscriptions/listen` behavior are verified over the wire.
- #87 closes only after all replacement criteria pass; #75 and #108 stay open with their narrowed scopes recorded. #71 is not started until this migration lands.

## Upstream defect table (states verified 2026-08-16; re-verify in PR 1)

`@modelcontextprotocol/server@2.0.0` published 2026-07-27, so every one of these is at most three weeks old and several are the sole reason a decision above exists. Treat the table as a merge gate, not a reading list: if an entry has been fixed, delete the workaround it justifies rather than shipping both.

| Item | What it forces here | State |
|---|---|---|
| [#2650](https://github.com/modelcontextprotocol/typescript-sdk/issues/2650) `subscriptions/listen` holds an empty stream open forever | The graceful empty-close in §4 | Open |
| [#2656](https://github.com/modelcontextprotocol/typescript-sdk/issues/2656) every throw becomes a tool-execution error, no protocol-error path | Facade-side error sanitization, §6 | Open |
| [#1429](https://github.com/modelcontextprotocol/typescript-sdk/issues/1429) raw internal error messages leak through the same catch | Same | Open |
| [#2589](https://github.com/modelcontextprotocol/typescript-sdk/issues/2589) `createMcpHandler` accepts a modern POST with no `MCP-Protocol-Version` | Never route or authorize on header presence | Open; verified against installed 2.0.0 (2026-08-19): the SDK already rejects `Mcp-Method`/`Mcp-Name` mismatch/absence with 400/-32020, so only the absent-`MCP-Protocol-Version` case needs the facade check. Both behaviors pinned in `tests/mcpServerFacade.test.js`. |
| [#2537](https://github.com/modelcontextprotocol/typescript-sdk/issues/2537) SDK errors when `io.modelcontextprotocol/clientInfo` is missing, though the spec makes it a SHOULD | A conforming client could be rejected; confirm against real client traffic | Open |
| [#2494](https://github.com/modelcontextprotocol/typescript-sdk/pull/2494) stdio transport does not close on stdin EOF | Keep our own stdin-EOF shutdown, §6 | Open PR |
| [#2352](https://github.com/modelcontextprotocol/typescript-sdk/issues/2352) no server-side pagination for list operations | Do not design for cursors now, §5 | Open |
| Codex `Feature::Mcp20260728` | Flips Codex to modern mode and makes the stdio env opt-in live | Registered, off by default |

## Risks and open questions to resolve in PR 1

- Verify the exact 2.0.0 API names/signatures for HTTP serving, `ServerOptions.cacheHints`, stateless legacy mode, shutdown, client identity metadata, and `subscriptions/listen`. The plan deliberately does not invent undocumented SDK calls.
- Derive a non-reversible credential fingerprint from the authenticated bearer without storing or logging the raw token, bind it to the configured Google profile and invalidation epoch, and prove token rotation and profile changes invalidate outstanding handles. This release intentionally does not distinguish clients sharing the bearer.
- Measure 156-tool registration cost with the selected official SDK and document whether the supported factory/caching pattern already addresses it. Do not add ad hoc server reuse that can leak request state.
- Decide the dirty-workspace recovery operator workflow and disk-pressure alert threshold before enabling automatic expiry cleanup in production.
