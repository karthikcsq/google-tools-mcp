# Changelog

## Unreleased (next: 3.0.0)

Migration to MCP specification **2026-07-28** on the official MCP TypeScript
SDK v2. FastMCP, mcp-proxy, and the v1 SDK are gone. **stdio users: nothing in
your config changes.** The breaking changes are all in shared HTTP mode.

### Breaking

- **Sessionful HTTP is removed.** HTTP is stateless: every request is
  authenticated, served, and forgotten. Removed, all now returning `404` after
  the same bearer-token and `Origin` checks as any other request:
  - `GET /sse` and its `POST /messages` companion — the legacy SSE
    compatibility transport mcp-proxy always stood up alongside the configured
    endpoint, with no supported way to turn it off.
  - `GET /ping` — mcp-proxy's unauthenticated liveness route. Replaced by
    authenticated `GET /healthz`, which returns exactly `{"status":"ok"}` and no
    server, version, profile, tool, handle, or environment identity.
  - The `GET` that attached to a session's event stream and the `DELETE` that
    terminated a session.

  The `Mcp-Session-Id` header is never required, never returned, and ignored if
  sent. What remains is one `POST` endpoint (`GOOGLE_MCP_ENDPOINT`, default
  `/mcp`) plus `GET /healthz`.

  Reconfiguration steps for Claude Code and Codex — including the
  `CODEX_MCP_PROTOCOL_VERSION=2026-07-28` env entry a Codex stdio registration
  needs, without which Codex pins the server to the legacy lifecycle — are in
  [docs/http-mode.md](docs/http-mode.md).

- **Google Docs edits over HTTP now require an explicit `readHandle`.** Read
  state is never carried between HTTP requests, so an earlier request's read
  cannot authorize a later write. `readDocument` returns an opaque, server-minted
  handle bound to the credential fingerprint, configured profile, runtime epoch,
  file, tab, revision, and a structural fingerprint of the document; it expires
  in under 24 hours, and a mutation consumes it and returns a successor bound to
  the new revision. A revision string alone cannot authorize a write. The field
  is schema-optional and runtime-required on HTTP, so stdio and its
  connection-pinned implicit read state are unaffected.

- **`writeSpreadsheet`, `batchWrite`, `clearSpreadsheetRange`, and `deleteFile`
  fail closed over HTTP.** They have no handle wiring yet. Use stdio for them in
  this release.

- **`GOOGLE_MCP_USE_SDK_V2` is removed.** The SDK v2 path was the flagged
  runtime during the migration and is now the only runtime, so there is nothing
  left to select.

- **Node `>=20` and Zod `^4.2`** are now the floor.

- One process serves **one** configured Google profile and one effective
  service principal. Handles, trackers, and workspace ownership are valid only
  for that deployment; multiple profiles or horizontal scale are out of scope.

### Added

- `GET /healthz`, authenticated, liveness only.
- `server/discover` carrying supported versions, capabilities, `serverInfo`, and
  server `instructions`, with `cacheHints` (60s TTL, private scope) on both
  `server/discover` and `tools/list` so clients can cache the catalog.
- Per-handle editable workspaces over content-addressed immutable baselines,
  with ownership manifests, dirty-file retention, and cleanup on mint and
  shutdown.
- A secret redactor and error classifier at the transport boundary
  (`dist/errors.js`): every caller-visible error string and every server-side
  log field is redacted, and an unclassified internal failure returns a generic
  message instead of a raw stack.
- `docs/http-mode.md`, the reference for HTTP mode and this breaking change.

### Fixed

- Read-tracker state can no longer be shared across HTTP requests. One request's
  read of a document could previously satisfy another request's mutation guard.
- `subscriptions/listen` returns its empty result and closes gracefully instead
  of holding the connection open ([typescript-sdk#2650](https://github.com/modelcontextprotocol/typescript-sdk/issues/2650)).
- A modern POST whose body claims a protocol revision but omits the
  `MCP-Protocol-Version` header gets a JSON-RPC `-32020` HeaderMismatch error
  addressed to the pending request id, rather than a generic HTTP body the
  client would take down the wrong error path.
- `Access-Control-Allow-Origin` and `Vary: Origin` are attached to real
  responses, not just the CORS preflight.
- **Gmail messages are now standards-compliant MIME** (#73, closing #54). All
  header and body construction moved into a new `dist/mime.js`, and every send,
  draft, reply, and forward path routes through it:
  - Non-ASCII Subjects and To/Cc/Bcc display names become RFC 2047 base64
    encoded-words, chunked on UTF-8 character boundaries and separated by
    folding whitespace, so a wordless CJK or emoji subject now folds legally
    instead of shipping as one line past the 998-octet limit. Addr-specs,
    Message-IDs, and unsupported address shapes are never encoded.
  - Attachment `Content-Type` and `Content-Disposition` use RFC 2231/6266
    `filename*` with numbered continuations for long or Unicode names, plus a
    sanitized quoted ASCII fallback. A filename or `mimeType` can no longer
    inject a header: CR/LF never survive, and `mimeType` is validated against
    the RFC 2045 grammar and rejected outright when it does not match.
  - `Content-Transfer-Encoding: quoted-printable` is now true. Text and HTML
    single-part bodies are really quoted-printable encoded (8-bit octets, `=`,
    control bytes, and trailing whitespace escaped; CRLF normalized; no line
    over 76 characters). Multipart body and attachment payloads are base64
    wrapped at 76 per RFC 2045 §6.8.
  - Multipart boundaries are derived from the content they delimit and verified
    not to occur in it, replacing a timestamp-plus-random string nothing ever
    checked. The same message now produces the same bytes.
  - ASCII-only messages are otherwise byte-compatible.

### Removed (internal)

- `fastmcp` and, with it, `mcp-proxy` and the transitive
  `@modelcontextprotocol/sdk` v1.
- `dist/cachedToolsList.js` (unused; the only raw v1 SDK import).
- `dist/sessionContext.js` and every `runWithSession` / `currentSessionKey` /
  `clearSession` call site.
- The `http.createServer` request-guard monkey-patch in `dist/httpAuth.js`
  (`startWithRequestGuard`, `createHttpRequestGuard`) and the FastMCP
  `createHttpAuthenticate` hook. One `checkHttpAuth` middleware now runs ahead
  of routing and covers every method and path.
- The `server.on('disconnect')` session-cleanup handlers.
- `dist/tools/drafts.js`, `labels.js`, `messages.js`, `settings.js`,
  `threads.js` — pre-consolidation Gmail tool forks left over from the
  `dist/tools/gmail/*` consolidation. Never imported (`dist/tools/index.js`
  always loaded Gmail tools via explicit `./gmail/*.js` paths); nobody could
  have been depending on a deep import of these paths, since none of the
  five ever registered a tool the server actually exposed. (#74)


## 2.0.0

First release since 1.2.12 (2026-06-01). Thirteen pull requests, one breaking change.

### Breaking

- **Gmail tool names are now camelCase, and the old `snake_case` names are opt-in** (#65).
  The Gmail surface was consolidated and renamed: `send_message` is now `sendMessage`,
  `get_thread` is now `getThread`, `create_draft` is now `createDraft`, and so on across
  the whole group. By default the server registers 156 tools, and the old Gmail names are
  not among them. (This rename covered Gmail only. The six `forms` tools still use
  snake_case and are unaffected.)

  If you have saved prompts, scripts, or client configs that call the old names, set:

  ```
  GOOGLE_MCP_ENABLE_LEGACY_ALIASES=true
  ```

  That registers the previous names as aliases alongside the new ones, for 228 tools
  total, and gives you time to migrate. The aliases are intended as a migration path
  rather than a permanent surface.

### Added

- **Google Maps and Places tools** (#66): `mapsDirections`, `mapsGeocode`,
  `mapsPlaceDetails`, `mapsReverseGeocode`, `mapsSearchNearby`, `mapsSearchPlaces`.
  Requires `GOOGLE_MAPS_API_KEY`, which is separate from OAuth. Without it the tools stay
  listed but fail with a clear error rather than disappearing.
- **Optional shared HTTP transport** (#59): set `GOOGLE_MCP_TRANSPORT=http` to run one
  long-lived server for many clients instead of spawning a process per client. Binds to
  `127.0.0.1` and requires a bearer token by default; refuses to start if you combine
  `GOOGLE_MCP_HTTP_NO_AUTH=1` with a non-loopback bind. Read-tracking state is isolated
  per session, but all clients share one process and one OAuth token.
- **Fidelity warnings when markdown is silently dropped** (#61, #69). Converting markdown
  to Docs previously discarded unsupported constructs without saying so. The markdown
  tools now report a warning count in their success line and list what was dropped.
  `readDocument` and `replaceDocumentWithMarkdown` also keep a local workspace copy so an
  edit-and-push cycle starts from current document state.
- **Optimistic concurrency on Docs writes** (#64). Replace, append, and modify now pass
  `WriteControl` with the revision they read, so a write fails instead of silently
  clobbering an edit someone else made in between.
- **Output size controls for Gmail threads and messages** (#63), so a large thread no
  longer blows past the response budget.
- **Trusted npm publishing** (#68). Releases publish from a tag via GitHub Actions OIDC
  with provenance, gated on environment approval. No npm token is stored in the repo.
  See `RELEASING.md`.
- **Startup timing on the server's ready line** (#70), plus a warning when startup exceeds
  5 seconds, to separate a slow server from a slow launcher.

### Fixed

- **Long email headers are folded per RFC 5322** (#60), resolving `Invalid Cc header` when
  sending to many recipients.
- **Ordered lists survive tab-scoped Docs reads** (#67); they previously came back
  flattened.
- **Emulated horizontal rules match Google's native line color** (#58).

### Changed

- `npx -y google-tools-mcp setup` now installs the package globally and points your MCP
  config at that install rather than at `npx` (#70). `npx` re-resolves the whole dependency
  tree on every launch, which on some machines takes long enough to lose the race against
  an MCP client's connection timeout. This widens the margin; it does not eliminate it.
  See #46, and #71 for the remaining dependency-size work.
- Documented that `dist/` is the hand-edited source for this repository, with no
  TypeScript, bundler, or build step (#62).
