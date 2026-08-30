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
- **Delegate to Codex models ONLY** (changed 2026-08-20). Claude subagents are no longer used
  for implementation. Routing:
  - `gpt-5.6-terra` — default worker. Scoped tasks with a clear file set and gates to run.
  - `gpt-5.6-luna` — easier, shorter, unambiguous tasks and quick fixes, where the brief can
    say exactly what to do.
  - `gpt-5.6-sol` — large, hairy, complex work, or when an alternative perspective is needed.
  Invocation that works on this machine (Bash tool, NOT PowerShell; `-a` does not exist in
  this build, use `-s`):
  ```
  codex exec --skip-git-repo-check -C "<worktree>" -s workspace-write -m gpt-5.6-terra     -o "<outfile>.md" "<prompt>" < /dev/null
  ```
  `< /dev/null` is mandatory or it hangs forever. `-s read-only` for review/recon.
  Long runs go through the Bash tool's `run_in_background`.
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

Opened as docs-only; now carries the whole migration implementation. Body and title
rewritten 2026-08-20 to describe the implementation; PR is awaiting Elliot's review.

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
| `a84a3f0` | fix | protocol error shape, graceful listen close, CORS on real responses |
| `0c8fcb8` | PR4 | **cutover and removals**; fastmcp gone, SDK v2 is the only runtime |

Full suite at HEAD: **44 suites, 672 passed, 2 skipped, 0 failed.**
(Count moved from 678: the removed dual-runtime surface took ~9 tests with it -
FastMCP's `createHttpAuthenticate` hook and the `createHttpRequestGuard`
monkey-patch - and PR4 added `tests/entrypointSmoke.test.js`, 3 real spawns of
`dist/index.js`.)

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
- **PR4 — DONE.** Cutover and removals. `GOOGLE_MCP_USE_SDK_V2` and
  `selectRuntimeKind` deleted; `dist/index.js` starts `startV2Stdio` /
  `startV2HttpServer` directly, keeping env/config resolution, tool preloading,
  startup diagnostics, the update nudge, and the stdin-EOF path. Deleted:
  `fastmcp` from package.json (which took `mcp-proxy` and the transitive
  `@modelcontextprotocol/sdk` v1 out of the lockfile), `dist/cachedToolsList.js`,
  `dist/sessionContext.js`, the disconnect handlers, `startWithRequestGuard` /
  `createHttpRequestGuard` / `createHttpAuthenticate`. `dist/readTracker.js`'s
  keyed session map collapsed to one no-context Map (the request-context branch
  is untouched) and `clearSession` is gone with it. Docs: new
  `docs/http-mode.md`, README HTTP section rewritten, `docs/architecture.md`
  de-sessioned, CHANGELOG `## Unreleased (next: 3.0.0)` entry, breaking-change
  note in the setup wizard's outro. Inventory snapshot: 0 fastmcp imports,
  0 raw v1 SDK imports, 156 tools.

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

### Resolved

- **Three facade HTTP findings** (comments 5347936334/5347938072/5347939420, task #15,
  closed) — all fixed in `a84a3f0`: JSON-RPC `-32020` HeaderMismatch envelope for a
  missing `MCP-Protocol-Version` on modern POSTs; `subscriptions/listen` now emits the
  terminal empty result for the original request id before closing (no per-subscription
  SDK close API exists in 2.0.0, so the wrapper writes the SDK-shaped frame itself);
  allowed Origins get `Access-Control-Allow-Origin` + `Vary: Origin` on every real
  response. Replies posted on the PR naming the commit.

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

- ~~**PR4 of the migration**~~ (task #5) — **done**, see the stage status above.
  One item deliberately left out: writing `CODEX_MCP_PROTOCOL_VERSION=2026-07-28`
  into the wizard's Codex registration. The plan assigns that to whichever of
  #75/#48 lands the client-registration work; PR4 documents it in
  `docs/http-mode.md` instead of touching `codex mcp add` here.
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
