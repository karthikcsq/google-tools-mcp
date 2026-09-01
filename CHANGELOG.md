# Changelog

## 3.0.0 - 2026-08-31

Migration to MCP specification **2026-07-28** on the official MCP TypeScript
SDK v2. FastMCP, mcp-proxy, and the v1 SDK are gone. The breaking changes are
all in shared HTTP mode. **stdio users: nothing in your config changes, with one
exception — Codex.** Codex pins stdio servers to the legacy lifecycle unless it
is told otherwise, so a Codex stdio registration needs
`CODEX_MCP_PROTOCOL_VERSION=2026-07-28` added to its `env` block. Every other
stdio client is unaffected. See
[docs/http-mode.md](docs/http-mode.md#codex).

### Breaking

- **Sessionful HTTP is removed.** HTTP is stateless: every request is
  authenticated, served, and forgotten. Removed, all now returning `404` after
  the same bearer-token and `Origin` checks as any other request:
  - `GET /sse` and its `POST /messages` companion — the legacy SSE
    compatibility transport mcp-proxy always stood up alongside the configured
    endpoint, with no supported way to turn it off.
  - `GET /ping` — mcp-proxy's unauthenticated liveness route. Replaced by
    authenticated `GET /healthz`, which returns exactly
    `{"status":"ok","pid":<number>}` and no server, version, profile, tool,
    handle, or client identity. The pid is there because `setup` and `status`
    compare it against the recorded state file to prove the process answering
    the port is the one they started.
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

### Testing

- **The live agent loop.** `npm run live-mission` runs a whole multi-step task in
  one process against the real Google API, written by an agent that was given a
  goal rather than a script. This closes a structural gap: `live-call` starts a
  fresh process per call, so the read tracker and read handles die between them,
  making create-then-write (the most common real agent workflow, and the subject
  of #87 and #135) impossible to prove. The runner records every call, failure,
  retry, and friction note to a JSON report. Protocol in
  [`.claude/skills/live-agent-loop/SKILL.md`](.claude/skills/live-agent-loop/SKILL.md),
  reference in [docs/live-agent-loop.md](docs/live-agent-loop.md).
- `npm run live-coverage` reports which of the 160 registered tools are driven
  against the real Google API by checked-in code (28) and which have unit tests
  only (132), and exits non-zero if a scenario calls a tool that is no longer
  registered. Tools that provably cannot reach Google are reported separately
  rather than counted as covered, because a scenario names them only to assert
  the refusal holds: `forwardMessage`, which the runner blocks before
  `execute()`, and `createPresentation`, which `guard.mjs` denies outright
  because the Slides API creates in Drive root whatever parent it is given. It
  runs offline, registering every category against a recording
  stub. The point is that "all suites pass" and "this tool works" are different
  claims, and the gap between them should be a number rather than a feeling.
- Jest `testTimeout` raised to 30s. The four suites that call `registerAllTools`
  dynamically import all 12 tool categories (~180 modules): about 750ms warm, but
  measured past Jest's 5s default against a cold filesystem cache. That is
  exactly the CI shape, since both workflows run `npm ci` and then the suite, and
  it reproduced on 1 of 3 cold cycles while never failing across 12 consecutive
  warm runs. The module loading is legitimate work, so the time budget was what
  was wrong.
- The live harness could leave real files in a real Drive and still report a
  clean run. `live-mission` and `live-call` each kept their own copy of the
  "tools that create something" map, under a comment saying the two were kept in
  sync, and both then read `JSON.parse(result).id` and nothing else. That
  silently dropped two of the eight tools they listed: `createPresentation`
  answers with `presentationId`, and `createDocumentFromTemplate` answers in
  prose, so `JSON.parse` threw and the id was discarded. Anything not registered
  is never trashed, and the cleanup line still printed `N/N` because `N` only
  counted what the runner had noticed. One shared extractor now handles every
  shape including the prose form, and a creating call whose id cannot be found
  is reported as `UNTRACKED` and fails the run rather than passing quietly.

### Security

- **The OAuth callback is now bound to the request that started it.** The
  loopback redirect server accepted any request carrying a `code`, and the
  authorization URL carried no `state`. During the five-minute sign-in window,
  a page the user happened to visit could point their browser at
  `http://localhost:<port>/?code=<the attacker's code>`; the exchange succeeded
  and this server persisted the **attacker's** refresh token, so every later
  tool call ran against someone else's Google account while looking entirely
  normal. `authenticate()` now issues a random `state`, compares it in constant
  time on return, and ignores any callback that does not match — ignores rather
  than rejects, so nobody who can reach the port can cancel a sign-in that is
  still in progress. PKCE (`S256`) is sent on the same flow, so an
  authorization code observed on the loopback redirect is useless without the
  verifier, which never leaves the process. Matches
  [Google's OAuth guidance](https://developers.google.com/identity/protocols/oauth2/resources/best-practices).
- **Seven production `npm audit` findings cleared, and the manifest floors moved
  past the vulnerable ranges** (#129). `hono` advances 4.12.9 to 4.13.5 and
  `markdown-it` 14.1.1 to 14.3.1, pulling their affected transitive dependencies
  (`@hono/node-server`, `@xmldom/xmldom`, `linkify-it`, `qs`) with them. Bumping
  only the lockfile would have left `hono: ^4.11.4` and `markdown-it: ^14.1.1`
  in `package.json`, so a consumer resolving fresh could land back inside the
  advisory range; the declared floors moved too. `diff` advances 7.0.0 to 9.0.0
  after checking every `diffLines`/`createPatch` call site in this repository
  against v7, v8, and v9 output for all four label shapes the Docs diff path
  produces. The v9 changes are confined to `parsePatch` and `formatPatch`,
  which this server never calls.
- **The `feedback` tool could execute arbitrary shell commands through a crafted
  issue title** (#114). Titles and bodies were interpolated into a `gh` command
  string, so shell metacharacters in user-supplied text reached the shell. Every
  `gh` invocation now passes an argv array to `execFile` with no shell involved.
- **The three browser-open helpers no longer build shell command strings around
  a URL** (#125). `start`, `open`, and `xdg-open` were invoked through a shell
  with the URL concatenated in; they now go through a shared `runArgv` helper
  that passes the URL as a single argv element.
- **Re-authentication could report success without replacing the refresh token**
  (#115). `authenticate()` now requests re-consent on every call, including the
  explicit `google-tools-mcp auth` path and the `invalid_grant` recovery path,
  and throws instead of reporting "Authentication successful!" when the exchange
  returns no refresh token. The token file is written atomically and chmodded
  `0600`, and its directory `0700`.

### Added

- `GET /healthz`, authenticated, liveness only. Part of making the shared HTTP
  transport production-ready before it could be considered as a default (#75).
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
- `readDocument` gains `format='index'` (#105): a compact structural map of the
  document — headings with levels, list items with nesting and orderedness,
  tables with per-cell indices, section breaks, horizontal rules, inline object
  anchors — carrying the raw `startIndex`/`endIndex` every index-addressed tool
  needs. It fetches a narrow field mask rather than `fields:'*'`, including for
  tabbed documents, and it mints a `readHandle` like any other read. Paginates
  at element boundaries via `maxResponseChars` / `fromIndex` / `nextFromIndex`.
  Every tool description and error string that used to recommend `format='json'`
  for index discovery now names `format='index'`.
- `readDocument` gains `stripInheritedStyles` (opt-in, `format='json'` only),
  which drops inherited `textStyle`/`documentStyle`/`namedStyles` and every
  `suggested*` map while preserving every index.
- `replaceRangeWithMarkdown`: replaces an index range in a Google Doc with
  parsed Markdown in one call, instead of a `deleteRange` + `appendMarkdown`
  pair. Part of replacing destructive full-body rewrites with safe structured
  editing (#88).
- `updateComment`: edits the body of an existing Google Docs comment.
- `batchModifyText`: applies multiple `modifyText`-style edits to a document
  in a single call, so multi-edit workflows no longer need one round trip per
  edit.
- `listHeadings`: returns the document's heading outline (text, level, and
  `startIndex`/`endIndex`) without paginating through the full `format='index'`
  structural map.
- Text inserted by this server now carries the document's `NORMAL_TEXT`
  foreground color explicitly across every insertion tool — `insertMarkdown`,
  `modifyText`, `batchModifyText`, `appendText`, `createDocument`'s raw path,
  and `insertTableWithData` — instead of leaving it to inherit (#14).
- `readDocument` gains `plainMarkdown`: return a plain-text variant of the
  response body while the rich markdown still mints the read handle, seeds the
  local working-copy file, and feeds diffing/tracking, so a plain read can
  never cause a later push to drop existing formatting (#96).
- `applyParagraphStyle` gains `bulletNestingLevel` (0-8): set a paragraph's
  list depth explicitly by resolving whole-paragraph ranges and emitting
  `deleteParagraphBullets` / leading-tab adjustment / `createParagraphBullets`
  in one batchUpdate, with `bulletPreset` to set the glyph style explicitly
  (#107).
- `batchModifyText` and `modifyText` refuse an explicit-index write when a
  concurrent change since the read cannot be proven not to touch the target
  range, and re-resolve a `textToFind` target against the current document
  when it can; every rejection names what changed and where (#108).

- `listFolderContents` gains `depth` and `maxItems` for bounded recursive
  traversal (#99). Mapping one subtree previously took 14 sequential calls. A
  single-page listing that hit its cap now says so through `truncated` and a
  `truncationReason` naming the fix, instead of silently returning a short list.
- A shared machine configuration file is loaded before startup and applied
  across MCP clients (#82), so settings no longer have to be duplicated into
  every client's config block.
- Diagnostics are actionable rather than decorative (#91): structured
  tool-call logs, startup timing visible where the README says to look, and a
  troubleshooting runbook. Caller-supplied text never reaches persisted
  diagnostics.
- `setup` and `update` are idempotent and repair existing client configs
  instead of appending duplicates or leaving a half-written entry (#48).
- `modifyText` can create bullets and numbered lists (#120), so a mid-document
  insert can match the formatting of the rest of the document.
- `readDocument` surfaces link targets that disagree with their display text
  (#117), including `mailto:` links, rather than leaving the mismatch for the
  reader to notice.

### Fixed

- **A busy OAuth callback port hung the whole sign-in instead of reporting
  itself.** `authenticate()` awaited `server.listen()` on a Promise with no
  rejection path, and `listen` reports failure by emitting `error`, never by
  throwing. With `GOOGLE_MCP_OAUTH_PORT` set to a port already in use, the flow
  never settled: the `EADDRINUSE` went to the process-level handler in
  `index.js`, which logs and returns, and the caller waited forever. The
  `port_in_use` remedy `clients.js` has always carried was unreachable as a
  result. It now rejects with that remedy named, and the port in it.
- **Authentication was not concurrency-safe, and HTTP mode is concurrent.**
  `ensureAuth()` checked `authClient` and then awaited, with nothing holding the
  gap, so requests arriving before the first authorization finished each started
  their own — six concurrent cold requests produced six authorizations, which on
  a cold machine means six browser windows racing for one loopback port.
  `reauthorize()` had the same hole and a worse consequence: a revoked refresh
  token fails every in-flight call at once, and each failure nulled the shared
  clients out from under the others mid-rebuild. Both now hold the in-flight
  Promise, and both release it when it settles, so a declined consent screen is
  never replayed to the next caller.
- **`GET /healthz` reported a closed runtime as healthy.** The health branch sat
  above the `closed` check, so a drained handler answered `200 {"status":"ok"}`
  while `/mcp` already answered `503` — the one probe meant to notice a dead
  runtime was the only route that never did. It now answers
  `503 {"status":"closed"}`, still behind the same auth gate.
- **`readDocument(format='markdown')` wrapped every run in a colour span nobody
  asked for, which made read-back verification impossible.** #14 requires every
  run this server writes to carry an explicit `foregroundColor`, and Google's
  Color endpoint drops an all-zero RGB value, so the fallback is the nearest
  representable explicit black: `#000001`. That landed on every run of every
  document created from markdown, and the reader echoed it back as author
  intent. A document created from `## Next steps` read back as
  `## <span style="color:#000001">Next steps</span>`. The reader now suppresses
  that one sentinel value, which is indistinguishable from black on screen and
  means "no colour was chosen" by construction; a colour the author actually
  picked still exports, and other styling on the same run is untouched. Found
  by the live agent loop, whose agent read the mangled markdown, concluded its
  own edit had deleted the heading, and spent three documents and seven calls
  chasing a data-loss bug that was never happening.

  Known limitation, stated plainly: text a human deliberately coloured
  `#000001` now exports without its colour span. There is no way to avoid this.
  Google's API drops an all-zero RGB value, so #14 forces *some* non-zero
  stand-in for "explicitly the default", and whichever value is chosen is a
  colour a person could in principle pick. The trade is one indistinguishable-
  from-black shade against a reader that was unusable for verification on every
  document this server writes.
- **`modifyText` rejected a wrong-shaped `target` with an unreadable union
  dump.** Passing `startIndex`/`endIndex` at the top level (the natural mistake
  for anyone who has not seen the schema) produced three parallel branches each
  saying "expected object, received undefined", which reads as "you passed
  nothing" to a caller who passed plenty. The union now carries an explicit
  message naming all three accepted shapes and showing the nesting, with the
  wrong form next to the right one.
- `documentEnd` in a `format='index'` read is now documented as what it is: one
  past the last addressable index, because the Docs body always ends with a
  final newline no range may cover. The README said element ranges "can be
  handed straight to a mutating tool", and a caller reasonably extended that to
  `documentEnd` and got a rejection. Use `documentEnd - 1`.
- **`readDocument(format='index')` was rejected by Google for every document,
  including an empty one.** The field mask asked for
  `lists(listProperties(nestingLevels(glyphType)))`, but `Document.lists` is a
  `map<string, List>` and Google's field-mask syntax does not allow
  sub-selecting inside map values, so `documents.get` failed the whole request
  with "Request contains an invalid argument. (Code: 400)". The mask now names
  `lists` whole. No unit test caught this because every Docs test mocks
  `documents.get`, and a mock cannot validate a field mask; all 92 suites passed
  before and after. Found by the live agent loop, on the first mission.
- **`help` can now return one tool at a time.** `help` previously returned the
  entire 39,279-character README on every call, which is enough to push a real
  agent into skipping discovery and guessing argument names. `help` now accepts
  `tool` (returns that tool's description and JSON Schema, ~3,000 characters)
  and `listTools` (just the registered names). Calling it with no arguments
  still returns the full manual, so nothing that worked before changed.
- **`formatCells` now names its accepted arguments when none are supplied.**
  The tool takes flat options with hex-string colors, not the nested Google
  Sheets API `CellFormat` shape, which is what a caller who knows the underlying
  API reaches for first. When they did, every key landed in the unknown-key
  bucket and the old message ("At least one formatting option must be
  provided.") read as "you passed nothing" while they had in fact passed a full
  format object. The message now lists the seven real options and shows the
  wrong-shape example next to the right one.
- `createSpreadsheet` and `copyFile` now seed read-tracker state, so creating a
  spreadsheet or copying a file and immediately writing to it no longer fails
  with "this file has not been read in this session". Sheets writes are guarded
  (`writeSpreadsheet`, `batchWrite`, `clearSpreadsheetRange`), so this made the
  most obvious workflow those tools have unusable. Docs copies re-fetch content
  and revision and mint a read handle; Sheets copies and creates record the same
  metadata-only baseline `readSpreadsheet` does; binary copies stay deliberately
  unseeded, because claiming a read that never happened would convert a loud
  rejection into a silent overwrite (#87, #135).
- Maps authorization failures now name the specific Google Cloud API that needs
  enabling (Places API (New), Geocoding API, or Routes API), derived from the
  request URL, plus the console pages for enabling it and for checking key
  restrictions. `PERMISSION_DENIED`, `REQUEST_DENIED`, and bare `403` all
  qualify; every other error is byte-identical to before. Previously the message
  was "The caller does not have permission", which reads as broken OAuth when
  the real cause is a separate, unconfigured `GOOGLE_MAPS_API_KEY` (#128, #133).
- `resolveComment` now posts a resolve-action reply and verifies it
  persisted, **throwing** if the comment still reports unresolved, instead of
  silently writing an ignored field and returning a soft note asking the user
  to resolve it manually; `listComments` paginates (`maxResults`/`pageToken`)
  (#86).
- `insertImage` acquires its mutation lease before any Drive upload, on both
  the standard and Apps Script local-file paths, so a rejected mutation
  (unauthorized/expired/never-read document) can no longer leave an uploaded
  file behind in the user's Drive; `createDocument` and `createFromTemplate`
  now seed post-create read state on success, so an immediate follow-up
  mutation no longer fails as "unread" (#87).
- `docsJsonToMarkdown` ordered-list export uses real ordinals (previously
  every item rendered as `1.`), nested-list indentation matches each
  ancestor's actual rendered marker width instead of a flat two spaces, and a
  blank line now separates a list from the following block so re-importing
  the exported markdown preserves nesting depth (#106).

- A failed `textToFind` now says *where* matching diverged — the longest
  matching prefix, the divergence offset, and the surrounding document text —
  instead of a bare "could not find it". Rendered by `modifyText`,
  `getFormatting`, and `applyParagraphStyle`.
- `readDocument format='json'` no longer emits an unbounded raw document when no
  `maxLength` was given; over the response budget it fails with a directive
  naming `format='index'`. `maxLength` is validated as a positive integer
  instead of treating `0` as "unlimited", and its description now says it
  applies to text, markdown, and json.
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

- `createDraft` and `updateDraft` no longer double-decode quoted-printable,
  which was stripping every `=` from the body (#116).
- `replaceDocumentWithMarkdown` no longer emits literal `**` or `~~` into the
  document when a delimiter carries a trailing space, as in `**text **` (#118).
- `modifyText` no longer raises a phantom staleness error when the document has
  not actually changed and the diff is empty; an immediate identical retry used
  to succeed, which is the signature of a false positive (#119).
- `modifyText` replacement text no longer silently inherits the character style
  of the text it replaced, which italicized whole inserted sections (#121).
- `readDocument` no longer overwrites the local mirror file and destroys pending
  edits (#122).
- Markdown export is round-trip safe across a header that follows a list (#123).
  The blank line between them survived export but was lost on push, merging the
  header into the last list item.
- `copyFile` no longer ignores its `name` parameter (#124).
- `listFolderContents` scopes depth-1 listings to the shared drive that contains
  the folder (#126). The originally filed symptom, empty results for every
  second-level subfolder, did not reproduce under four independent lines of
  investigation; the real adjacent defect was silent truncation, now reported.
- The umbrella `googleapis` dependency is replaced by the ten per-API
  `@googleapis/*` packages the server actually uses (#71). Installed size drops
  from 195 MB across 1,823 files to 8.1 MB across 148, `node_modules` as a whole
  from 303 MB / 11,591 files to 117 MB / 9,916, and cold import from roughly
  1,120 ms to 149 ms. `npx` re-verifies the tree per file on every launch, so
  the file count is paid back on every start.

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
