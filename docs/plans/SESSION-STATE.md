# Session state: MCP 2026-07-28 migration and full issue backlog

Living working file for the orchestrated session that started 2026-08-19. **The task
list in the agent task tool is the first source of truth; this file is the durable
backup of everything that would otherwise live only in chat context.** Update both.

Delete this file before the final release PR merges.

---

## The end state Elliot asked for

1. Every open issue acted on or closed as irrelevant. Nothing left open and unaddressed.
2. Every discussed feature fully implemented and working.
3. A new **major version** of google-tools-mcp shipped.

Multi-PR is fine. Batch related work into larger PRs; never combine unrelated work.
If two pieces would conflict or depend on each other, they go in the same PR.

## Working rules for this session

- Orchestrator model: delegate implementation, review everything myself, never take
  "done" at face value, commit and report myself.
- **No Codex subagents** (out of usage). Sonnet by default, Opus for large/hairy work.
- Cross-review rule: Fable cannot review its own work. Reviews go to a different agent.
- When review comments, ideas, or new context arrive mid-work: **log to the task list
  first**, finish the current piece, then act. Append later context to the same task.
- Handoff check each turn: update aged docs, give shipped moving parts a `docs/` page,
  log settled conventions and gotchas, open issues for unfixed things found.

## Repo facts that trip up every new agent

- `dist/*.js` is hand-written runtime source. **No `src/`, no build step, no TypeScript.**
- Tests are Jest ESM. Run `npm test` / `npm test -- <file>`. Bare `npx jest` FAILS
  (needs `--experimental-vm-modules`).
- `tests/toolRegistration.test.js` pins the tool count at **156** exactly, and
  `tests/documentationConsistency.test.js` derives README claims from the live registry.
  Any new tool breaks both deliberately.
- After changing tracked `dist/`/`tests/` files, regenerate the inventory snapshot:
  `node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json`
  Line-number shifts alone will fail `tests/mcpMigrationInventory.test.js`.
- Issue bodies are not trustworthy. Three claims across #105/#106 were verified false in
  an earlier pass. Check the code first.

## Where the work lives

- Primary checkout: `C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp` (stays on `main`, clean).
- PR #109 worktree: `C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-pr109`
  on branch `docs/mcp-plan-client-evidence`. Writable; an earlier session wrongly believed
  it needed relocating. It does not.

---

## PR #109 — the migration (IN PROGRESS)

https://github.com/karthikcsq/google-tools-mcp/pull/109

Opened as docs-only; now carries the whole migration implementation. **Its body still
says "Docs only. No code changes." and must be rewritten before review** (task #7).

Plan of record: `docs/plans/mcp-2026-07-28-migration.md` (staged as plan-PRs 1-4;
Elliot wants them delivered as one PR with commits grouped by stage).

### Commits so far (oldest first)

| Commit | Stage | What |
|---|---|---|
| `a74b61f` | — | plan revision with client evidence + SDK defect table |
| `52e5634` | PR1 | inventory script + snapshot + guard test |
| `89499f7` | PR1 | SDK v2 compatibility spike, ADR, Zod v4, exact SDK deps |
| `8734529` | PR2 | `dist/errors.js` error boundary + logger redaction |
| `238eefc` | PR2/3 | WIP baseline: facade, requestContext, readHandles (unwired) |
| `4f26a9d` | PR2 | completed UserError migration (59 files) off fastmcp |
| `6277e4a` | PR2 | `dist/docsStructure.js` internal structural walker |
| `530a8f5` | PR2 | pinned SDK header enforcement + 4 missing wire tests |
| `e3a420a` | — | recorded verified #2589 state in defect table |
| `f22d245` | PR3 | **read handles wired**; cross-request isolation closed |
| `de93015` | fix | redact diagnostics before truncating |

Full suite at HEAD: **43 suites, 677 passed, 2 skipped, 0 failed.**

### Stage status

- **PR1 — DONE.** Inventory guard, Node 20/22 CI matrix (already existed), SDK v2 +
  `@modelcontextprotocol/node` 2.0.0 + Zod ^4.2 installed, ADR at
  `docs/decisions/2026-08-16-mcp-sdk-v2-compatibility-spike.md`. The dual-runtime decision
  gate PASSED: all 156 schemas register through both FastMCP and the official SDK under
  one root Zod v4 process. That authorizes the flag path (`GOOGLE_MCP_USE_SDK_V2`).
- **PR2 — DONE.** Facade `dist/mcpServer.js` (stdio + stateless HTTP, `/healthz`,
  middleware ordering, deterministic registration, `cacheHints`, `instructions`,
  `subscriptions/listen` close, stdin-EOF shutdown, error sanitization), structural walker,
  header enforcement pinned, wire tests.
- **PR3 — DONE** (`f22d245`). See below.
- **PR4 — NOT STARTED** (task #5). Cutover and removals.

### PR3 design decisions worth remembering

- **Context plumbing is ambient**, not a signature change: all 156 tools keep
  `execute(args, { log })`. `dist/handleRuntime.js` adds an AsyncLocalStorage annotation
  slot so a tool can attach a minted `readHandle` that the facade merges as a top-level
  result field. AsyncLocalStorage, not a context-keyed WeakMap, because a stdio context is
  per-*connection* and shared by concurrent calls.
- **Structural fingerprint**: `sha256-<nodeCount>-<hex>` over `walkDocument`, hashing kind,
  indices, depth, row/column, elementType, and text-run *length*. Text content deliberately
  excluded — it answers "same structure?", not "same content?".
- **On-disk layout** under `getWorkspaceDir()` (honours `GOOGLE_MCP_WORKSPACE_DIR`):
  - `<ws>/v2-handles/baselines/<baselineId>.baseline` — immutable, shared, refcounted
  - `<ws>/v2-handles/handles/<workspaceId>/content.md` — editable, one per handle
  - `<ws>/v2-handles/handles/<workspaceId>/manifest.json` — ownership manifest
  - `baselineId` = sha256 of (profile, fileId, tabId, revisionId, fingerprint, contentHash).
    **Content hash added to the plan's tuple** because one (document, revision) yields
    different bytes per read `format`, and a shared file must be addressed by its contents.
- **Cleanup** reads exact manifest paths, never a glob. A workspace whose file no longer
  hashes to its baseline is dirty and is never deleted by expiry. No background timer —
  cleanup runs on mint and on shutdown, so nothing holds the process open.
- **Rotation = restart** in this release (token and `GOOGLE_MCP_PROFILE` are read once in
  `dist/index.js`). Each runtime start mints a fresh epoch, so restart genuinely
  invalidates outstanding handles.
- **Isolation root cause fixed in `dist/readTracker.js` itself**: `logForCurrentSession()`
  now keys a WeakMap on the request context object and only falls through to
  `currentSessionKey()`/`DEFAULT_SESSION` when there is no context — i.e. never on v2,
  always on legacy. A v2 HTTP mutation starts with a structurally empty tracker.
- **Fail closed on v2 HTTP, no handle wiring yet**: `writeSpreadsheet`, `batchWrite`,
  `clearSpreadsheetRange`, `deleteFile`. Normal on legacy FastMCP and on v2 stdio.
- **Handle lifecycle**: single-use for mutation (consumed on success, replaced by a
  successor bound to the new revision), unlimited for validation. A successor's workspace
  is created *empty* — we know the post-write revision, not the post-write content, and
  seeding it with pre-write content would hand back a copy that silently reverts the edit.

### Plan text now stale, fix when touching the plan

- §2 says every guarded HTTP mutation declares a *required* `readHandle` field. It is
  schema-**optional** and runtime-required on v2 HTTP; schema-required would reject valid
  legacy and v2-stdio calls at parse time.
- §3's baseline key needs the content hash added (reason above).
- §2's "single-purpose only if the final tool contract requires it" is now decided (above).
- The plan assumes `expectedRevisionId` exists from #108; it does not yet. The comparison
  logic lives in `beginDocsMutation` and is tested through a test-only probe tool.
- §3 should note there is no background sweeper in this release.

---

## Open review findings on PR #109

Verified against code unless marked. Reply to each on the PR naming the fix, or with the
reasoning for declining, then resolve the thread.

### Still to fix (task #15) — all in `dist/mcpServer.js`

1. **Wrong error shape for missing `MCP-Protocol-Version`.** Returns `400` with
   `{error: "..."}`. The 2026-07-28 contract wants a JSON-RPC `-32020 HeaderMismatch`
   addressed to the pending request id, because the official v2 client treats a well-formed
   modern `400` JSON-RPC error as an in-band `ProtocolError` and a generic HTTP body takes
   the ordinary HTTP-error path. Test must assert code and body, not just status.
   (comment 5347936334)
2. **`closeListenResponse` produces an unexpected remote close, not a graceful one.** It
   forwards the first chunk (the `notifications/subscriptions/acknowledged` notification),
   cancels, and closes — never delivering the terminal empty result for the original
   `subscriptions/listen` request id. Clients then classify the close as remote and may
   re-listen. Test with a real client so `McpSubscription.closed` resolves `graceful`.
   (comment 5347938072)
3. **CORS headers only on preflight.** `corsPreflight()` sets
   `Access-Control-Allow-Origin` for `OPTIONS`, but real `/mcp` and `/healthz` responses
   never carry it, so a browser at an allowed origin completes the request and is then
   blocked from reading the response. Add `Access-Control-Allow-Origin` + `Vary: Origin`
   to every real response including consumable errors; test an authenticated POST with
   `Origin`. (comment 5347939420)

### Resolved

- **Cross-request read-tracker sharing** (comment 5347959657, task #17) — fixed in
  `f22d245`, proven by `tests/readHandleIntegration.test.js` "does not let request A's Docs
  read authorize request B's Docs mutation".
- **Redactor truncation-boundary leak** (inline comment 3816694515, task #18) — fixed in
  `de93015`.

### Refuted, with evidence — reply, do not change code

- **"UserError bypasses sanitization"** (inline 3792971848). Wrong at head:
  `toolFailure` (`dist/mcpServer.js:29-31`) runs `redactDiagnostic` on the public message.
  Error class decides whether a *generic message* replaces it, not whether redaction runs.
- **"Server-side logs keep the raw secret"** (inline 3792971850). Wrong at head:
  `formatArgs` (`dist/logger.js:68-81`) calls `redactDiagnostic` on every logged argument
  unconditionally. No test requires an unredacted secret to reach a log; the one test that
  shows a secret checks the *pre-redaction source object* to prove non-mutation.

---

## Remaining work after PR #109

Batching decided with Elliot. One PR per cluster; related issues share a PR.

- **PR4 of the migration** (task #5, part of #109): make the SDK path default, remove
  fastmcp, `mcp-proxy`, `dist/cachedToolsList.js`, `dist/sessionContext.js`, disconnect
  handlers, the `http.createServer` request-guard monkey-patch in `dist/httpAuth.js`,
  `/sse` and sessionful routes. Document the breaking change and client migration steps.
- **PR B — Docs cluster** (task #9), blocked on the migration: #105, #106, #96, #107, #88,
  #108, #14, and closing #87. Read in dependency order #105 -> #106 -> #87 -> #107 -> #88
  -> #108, not alphabetically. #106 and #108 must be re-read against the handle/workspace
  contracts above, which replaced #106's session-suffix filename contract. #105 builds on
  `dist/docsStructure.js`. #14 needs its acceptance criteria widened — they can pass while
  the reported `modifyText` path stays broken.
- **PR C — Gmail** (task #10): #73 MIME, #74 cleanup. #74 owns Gmail dead-module deletion;
  the migration deliberately does not.
- **PR D — ops/infra** (task #11): #82 config, #48 setup idempotency, #91 diagnostics
  (minus the classifier/redactor already landed in `dist/errors.js`), #75 narrowed
  post-migration scope. #75 or #48 must write `CODEX_MCP_PROTOCOL_VERSION=2026-07-28` into
  Codex stdio registration, or Codex pins the server to the legacy lifecycle.
- **PR E — independents** (task #12): #71 (hard-blocked on the migration; both rewrite
  every tool import — land migration first, rebase once), #56, #99, #86.
- **#50** (task #13) is admin-only. The `npm-publish` GitHub environment has zero
  protection rules; a repo admin must add required reviewers and a `v*` tag policy. No PR
  can fix it. Until then every valid release tag publishes to npm with no human gate —
  settle this before tagging the major release.
- **Major release** (task #14): breaking changes are sessionful HTTP removal, `/sse`
  removal, the `readHandle` contract, Zod v4, Node >=20.
