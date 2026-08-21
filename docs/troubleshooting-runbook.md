# Diagnostics runbook

`google-tools-mcp` writes plain stderr-compatible logs and a redacted structured
tool-call log by default. The default files are `~/.config/google-tools-mcp/server.log`
and `~/.config/google-tools-mcp/server.jsonl` (under `XDG_CONFIG_HOME` when set).
`GOOGLE_MCP_LOG_FILE` changes or disables the plain file. `GOOGLE_MCP_JSONL_FILE`
changes or disables JSONL. Set either to `0`, `false`, or `off` to disable it.

At process startup, each file is rotated if it is already larger than 5 MB. During
runtime, the same threshold is checked before writes and the previous file becomes
`.1`, replacing any older `.1`; subsequent writes continue in a fresh primary file.

## JSONL format

Each line is one executed tool call, with exactly these fields:

- `ts`: ISO 8601 completion timestamp.
- `event`: always `tool_call`.
- `tool`: registered MCP tool name.
- `reqId`: monotonically increasing process-local call identifier.
- `durationMs`: elapsed execution time in milliseconds.
- `outcome`: `ok`, `user_error`, or `error`.
- `errCode`: `null` on success, otherwise a safe classification.
- `errMsg`: `null` on success, otherwise a redacted safe message.
- `argShape`: argument names with type and byte-length/count descriptors only.

`reqId` correlates a tool-call record with the last failures returned by the
`troubleshoot` tool during the same server process. It is not a cross-restart
or client identity. Validation failures rejected by the SDK before execution do
not produce a tool-call record.

No content bodies, OAuth credentials, bearer tokens, API keys, or raw argument
values are recorded. Pattern-shaped credentials and runtime-registered secrets
are redacted before either file is written, including values inside Error stacks
and logged objects.

## Diagnose a failure

Call `troubleshoot` first. Its recent activity summary gives per-tool counts,
error counts by code, and the last five failures. `USER_ERROR` means the tool
returned a deliberate caller-safe action message, commonly an OAuth or Google
API configuration problem. `HTTP_<status>` identifies an operation error with
a known API status. `INTERNAL_ERROR` intentionally withholds internal detail;
use the `reqId`, tool, duration, and surrounding plain log timestamp when
reporting it.

For feedback, `includeDiagnostics` defaults to false. The first call always
returns a reviewable draft. Set `confirmPublicPost: true` only after reviewing
that draft; only then can the tool submit through `gh`. When diagnostics are
explicitly enabled, the draft includes recent redacted JSONL records.

## Startup timing

The pre-handshake line `Loaded all N categories in Nms.` is emitted after tool
registration but before `server.start()` completes, so Claude Code captures it.
The later `MCP Server running ... in Nms.` ready line is normally visible only
when the server is run directly. `LOG_LEVEL=warn`, `error`, or `silent` hides
both info lines by operator choice.
