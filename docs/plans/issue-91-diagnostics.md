# Plan: actionable diagnostics — structured tool-call logs, visible startup timing, guidance (#91)

Issue: [#91](https://github.com/karthikcsq/google-tools-mcp/issues/91) (canonical for closed #78, #92) · Verified against `main` @ 8640240.

## Root cause

When a tool call fails in the field there is no deterministic path from "it failed" to "here's why," because three layers are each missing their half:

1. **Nothing records tool calls.** Grep confirms zero per-call logging in `dist/tools/**` — the only tool-adjacent log lines are registration-time. The logger itself (`dist/logger.js`) is plain-text `${ISO} [LEVEL] msg` with no fields, no redaction, no rotation, and it swallows file-open failures silently (`:51-53`).
2. **Startup timing lands where Claude Code can't see it.** The ready line with `readyMs` is emitted *after* `server.start()` (`index.js:195/:201`); Claude Code captures early stderr but the observed gap (closed #78) is that the post-start line is missed. A pre-start line already exists — `Loaded all N categories at startup.` (`tools/index.js:234`) — but carries no timing.
3. **No interpretation guidance exists** — logs, once they exist, need a runbook mapping symptom → layer (auth vs Google API vs internal).

The enabling fact from recon: **a single choke point already exists.** `wrapServerWithAuthRetry` (`dist/tools/index.js:96-120`) wraps every tool's `execute` — including the four utility tools registered later, since the patch mutates the same server object — with `toolName` (`:100`), `sessionKey` (`:107`), and a try/catch (`:109-113`) already in scope. Per-call logging is an insertion at that one point, not a 156-tool sweep. Constraint to respect: the second `addTool` patch layered at `:225-228` must stay *outermost* to avoid double-wrapping legacy aliases (rationale at `:211-222`).

## Design decisions

- **JSONL, one line per call, shape-not-content.** Fields: `ts`, `event:'tool_call'`, `tool`, `session` (opaque key or null), `reqId` (monotonic counter), `durationMs`, `outcome:'ok'|'user_error'|'error'`, `errCode` (HTTP status or classifier name from the existing helpers `isInvalidGrantError`/`isApiNotEnabledError` at `clients.js:59-115`), `errMsg` (redacted, truncated), `argShape` (per-arg: type + length/size only — never values). Content bodies, tokens, credentials never appear by construction because values are never serialized.
- **Centralized redaction with tests.** One `redact(str)` in the logger module: patterns for `Bearer …`, `key=`/`token=`/`client_secret=` query/body params (generalizing the Maps-only `redactSecrets` at `mapsClient.js:19-25`, which should delegate to it), base64url runs ≥ 24 chars. Applied to `errMsg` and to *every* line written to the log file. The generated HTTP token printed at `index.js:93-98` writes to stderr by design (client needs it) but must never reach the file stream — assert that in tests.
- **Structured lines go to the file; stderr stays human.** stderr keeps today's format (MCP clients show it to humans); the JSONL stream goes to the log file (`GOOGLE_MCP_LOG_FILE`), which becomes genuinely machine-readable. `LOG_LEVEL=debug` additionally mirrors JSONL to stderr for live debugging.
- **Rotation: size-capped, two files.** At open and every N writes, if `server.log` > 5 MB → rename to `server.log.1` (replacing), reopen. Bounded at ~10 MB total, no timers, no deps. Document default path + `GOOGLE_MCP_LOG_FILE`/`LOG_LEVEL` in README (depends on #82 so the file settings work from user config).
- **Startup timing: add elapsed-ms to the pre-start line.** Change `tools/index.js:234` to `Loaded all ${N} categories in ${Math.round(process.uptime()*1000)}ms.` — this line is emitted before `server.start()` and is reliably captured. Keep the post-start ready line unchanged for direct runs. This is deliberately the *minimal* fix for the visibility gap the closed #78 documented.
- **`troubleshoot`/`feedback` get a privacy-safe recent-activity summary.** `troubleshoot` (`tools/index.js:286-411`) currently tails 20 raw lines; replace with: parse last ~200 JSONL lines → aggregate (per-tool counts, error counts by code, last 5 failures as tool+code+redacted message). `feedback` (`:414-510`) appends the same aggregate **into the pre-filled body the user already reviews before submitting** — the existing flow (gh CLI writes a body the user confirmed; browser fallback opens a prefilled form) is the explicit-review gate; state in the tool description that diagnostics are included so the caller knows before invoking.
- **Runbook as a docs page, not a repo "skill".** `docs/troubleshooting-runbook.md`: where logs live per platform, the JSONL schema (kept adjacent to the code that emits it, with a test asserting the documented field list matches emitted fields — the cheap sync guarantee), how to distinguish auth failures (`invalid_grant`, `SERVICE_DISABLED`) vs API errors (4xx/5xx with code) vs internal errors (no HTTP code), and correlation via `session`/`reqId`. Link from README troubleshooting.

## Implementation

1. `dist/logger.js`: add `logToolCall(record)` (JSONL to file stream), `redact()`, rotation in `initLogFile`; warn once to stderr when file logging was requested but failed (fixing the silent `:51-53` swallow).
2. `dist/tools/index.js` `wrapServerWithAuthRetry` (`:102-115`): start timer before `withAuthRetry`, classify outcome in the existing catch (UserError → `user_error`), build `argShape` from `args[0]`, emit via `logToolCall`. ~20 lines.
3. `tools/index.js:234`: timing on the category-loaded line.
4. `troubleshoot`: replace `recentLogs` (`:378-391`) with the aggregate; keep raw-tail as a fallback when the file predates JSONL.
5. `feedback`: append aggregate to the issue body (`:463-474`).
6. `docs/troubleshooting-runbook.md` + README links.
7. `mapsClient.redactSecrets` delegates to the shared `redact`.

## Tests

- Redaction: table-driven — bearer tokens, key/token/secret params, base64url runs, the generated-HTTP-token shape; assert none survive `redact`; assert clean strings pass through.
- Wrapper: mock server + one passing and one throwing tool → two JSONL lines with correct `outcome`, `durationMs` ≥ 0, `argShape` has types not values (pass a distinctive string; assert it does NOT appear in the line).
- Rotation: write past the cap with a tiny threshold override → `.1` exists, sizes bounded.
- Startup line: registration test asserts the category-loaded message matches `/Loaded all \d+ categories in \d+ms\./` (extends `tests/toolRegistration.test.js`).
- Schema/doc sync: emitted field set equals the list in the runbook page.
- troubleshoot aggregate: fixture JSONL → counts and last-failures correct; no raw values leak.

## Acceptance criteria

- Every tool call (success and failure) produces one redacted JSONL record with duration and outcome, with zero per-tool code changes.
- A failure can be diagnosed from the log + runbook without debug mode having been pre-enabled.
- Startup elapsed time appears on a line Claude Code demonstrably captures.
- Redaction is centralized, tested, and applied to all file output.

## Sequencing

After #82 (config file must be able to set `GOOGLE_MCP_LOG_FILE`/`LOG_LEVEL` for this to be usable in stdio deployments). The wrapper edit touches `tools/index.js`, which #71 also edits — small, coordinate merge order freely.
