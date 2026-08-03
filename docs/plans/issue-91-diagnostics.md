# Plan: actionable diagnostics — structured tool-call logs, visible startup timing, guidance (#91)

Issue: [#91](https://github.com/karthikcsq/google-tools-mcp/issues/91) (canonical for closed #78, #92) · Verified against `main` @ 8640240. Revised after adversarial review.

## Root cause

When a tool call fails in the field there is no deterministic path from "it failed" to "here's why", because three layers are each missing their half:

1. **No systematic per-call record exists.** A handful of tools log ad-hoc lines mid-execution (e.g. `deleteSheet.js:17,37`), but nothing records tool name / duration / outcome per call, and those ad-hoc lines can carry raw arguments. The logger (`dist/logger.js`) is plain-text with no fields, no redaction, no rotation, and swallows file-open failures silently (`:51-53`).
2. **Startup timing lands where Claude Code can't see it.** The ready line is emitted *after* `server.start()` (`index.js:195/:201`). A pre-start line exists — `Loaded all N categories at startup.` (`tools/index.js:234`) — but carries no timing.
3. **No interpretation guidance exists** — a runbook mapping symptom → layer (auth vs Google API vs internal).

The enabling fact: a single choke point wraps every tool's **execution** — `wrapServerWithAuthRetry` (`dist/tools/index.js:96-120`), with `toolName` (`:100`), `sessionKey` (`:107`) and a try/catch (`:109-113`) in scope, covering category tools, the four utility tools, and legacy aliases (all flow through the same patched `addTool`). Constraint: the second `addTool` patch at `:225-228` must stay outermost (alias double-wrap rationale at `:211-222`).

## Design decisions

- **JSONL to its own file; the plain log stays plain.** Mixing JSONL records into `server.log` would leave `troubleshoot` parsing a mixed-format file and change what existing consumers see. Structured records go to a **separate** `server.jsonl` (default: sibling of the resolved `server.log` path; override `GOOGLE_MCP_JSONL_FILE`). stderr keeps today's human format; `LOG_LEVEL=debug` additionally mirrors JSONL records to stderr.
- **Record shape, values never serialized:** `ts`, `event:'tool_call'`, `tool`, `session`, `reqId` (monotonic), `durationMs`, `outcome:'ok'|'user_error'|'error'`, `errCode`, `errMsg` (redacted, truncated), `argShape` (per-arg type + length/size only). Scope honesty: this instruments **executed** tool calls — schema-validation failures and unknown-tool errors happen in FastMCP dispatch before `execute` and produce no record. Acceptance wording reflects that; instrumenting the MCP dispatch boundary is noted as a follow-up, not smuggled into this plan.
- **Error classification:** export the currently-private classifiers (`isInvalidGrantError`, `isApiNotEnabledError` — `clients.js:59-82`) plus a small `classifyError(err)` that extracts HTTP status from gaxios shapes and recognizes errors already converted to `UserError` by `withAuthRetry` (`clients.js:197-222`).
- **Centralized redaction with two mechanisms:** (a) pattern-based — `Bearer …`, `key=`/`token=`/`client_secret=` params, base64url runs ≥ 24 chars; (b) **registered live secrets** — a `registerSecret(value)` API; `mapsClient` registers `GOOGLE_MAPS_API_KEY` (its current value-replacement at `mapsClient.js:19-24` must not regress to patterns-only, since the key also travels in the `X-Goog-Api-Key` header), and `index.js` registers the generated HTTP token (`index.js:88`) so it can never reach any log file even though it is deliberately printed to stderr. Redaction applies to **every string written to either file**, including the plain logger's formatted output of objects and error stacks (`logger.js:61-79`) — not just the JSONL `errMsg`.
- **Rotation: at open only.** On `initLogFile`, if the target exceeds 5 MB → rename to `.1` (replace; Windows rename-over-existing needs unlink-first, do that explicitly), then open fresh. No mid-run rotation — avoids async-write/rename races entirely; a single process appends unboundedly only in pathological cases, which the runbook notes. File-open failure warns once to stderr (fixing the silent `:51-53` swallow).
- **Startup timing on the pre-start line:** `tools/index.js:234` → `Loaded all ${N} categories in ${ms}ms.` Stated plainly: it measures registration (pre-`server.start`), is emitted at `info`, and is therefore visible at the default `LOG_LEVEL` — with `warn`/`error`/`silent` the operator has opted out of info-class output, ready line included; the runbook says so. Keep the post-start ready line for direct runs.
- **`troubleshoot` aggregates; `feedback` gets opt-in diagnostics.** `troubleshoot` (`tools/index.js:286-411`) replaces its raw 20-line tail with: parse last ~200 `server.jsonl` records → per-tool counts, error counts by code, last 5 failures (tool + code + redacted message); falls back to the raw tail when no JSONL exists. `feedback` is **not** a review gate when `gh` is available — it submits immediately (`tools/index.js:22-48`); therefore diagnostics are attached only when the caller passes a new `includeDiagnostics: true` parameter (default false), and the parameter description states exactly what gets attached. No silent expansion of what an auto-submitted issue contains.
- **Runbook as a docs page:** `docs/troubleshooting-runbook.md` — log locations per platform, the JSONL schema (with a test asserting the documented field list equals the emitted field set), auth vs API vs internal failure signatures, correlation via `session`/`reqId`. Linked from README troubleshooting.

## Implementation

1. `dist/logger.js`: `redact()` + `registerSecret()`; redaction applied in the single write path for both files; JSONL stream + `logToolCall(record)`; rotation-at-open; open-failure warning.
2. `dist/tools/index.js` wrapper (`:102-115`): timer + outcome classification + `argShape` + `logToolCall`. (~20 lines.)
3. Export classifiers from `dist/clients.js`; add `classifyError`.
4. `tools/index.js:234`: timing on the category-loaded line.
5. `troubleshoot` aggregate + fallback; `feedback` `includeDiagnostics` param.
6. `mapsClient.redactSecrets` → delegates to shared redactor (keeping value-registration); `index.js` registers the HTTP token.
7. Audit the existing ad-hoc `logger.*` calls inside tools (`deleteSheet.js:17,37`, `ungroupAllRows.js:58`, registration-time lines) for argument leakage — file-layer redaction now catches secrets, but trim raw-argument logging where found.
8. `docs/troubleshooting-runbook.md` + README link.

## Tests

- Redaction: table-driven patterns; registered-secret replacement (Maps key, HTTP token shape); **object/Error arguments** — `logger.error('x', errWithSecretInStack)` produces no secret in either file; clean strings pass through.
- Wrapper: mock server with one passing tool, one throwing tool, one `UserError` tool → three records with correct `outcome`/`errCode`, `durationMs ≥ 0`; a distinctive argument string does **not** appear in the record. Coverage across registration paths: one category tool, one utility tool (`help`), and one legacy alias (aliases enabled) — exactly **one** record per invocation (the alias double-wrap regression).
- Rotation-at-open: oversized fixture file → `.1` replaced (including when a stale `.1` exists — Windows path), fresh file opened; open-failure warns.
- Startup line: `tests/toolRegistration.test.js` asserts `/Loaded all \d+ categories in \d+ms\./`.
- Schema/doc sync: emitted fields ≡ runbook's documented list.
- `troubleshoot`: fixture JSONL → correct aggregates, no raw values; no-JSONL → raw-tail fallback. `feedback`: default omits diagnostics; `includeDiagnostics: true` attaches the aggregate.

## Acceptance criteria

- Every **executed** tool call (success, UserError, failure) produces one redacted JSONL record with duration and outcome, across all three registration paths, with zero per-tool code changes.
- A failure can be diagnosed from `server.jsonl` + the runbook without debug mode pre-enabled.
- At default `LOG_LEVEL`, startup elapsed time appears on the pre-start line Claude Code captures.
- No secret — pattern-matched or registered — can reach either log file, including via object/stack logging; tests prove it.

## Sequencing

After #82 (config file must be able to set the log/JSONL paths and level). The wrapper edit touches `tools/index.js`, which #71 also edits — small, coordinate freely.
