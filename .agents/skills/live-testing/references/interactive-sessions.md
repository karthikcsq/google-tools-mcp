# Interactive MCP agent-test sessions

`agent-test` tests an instrumented MCP connection. It composes the production MCP server factory and its standard stdio or HTTP transport, rather than invoking the `dist/index` CLI entrypoint or calling a tool implementation directly. Stdio retains one owned connection for the session; HTTP uses the server's real stateless request behavior.

## Start and control a session

Use PowerShell and `npm.cmd`. Put complex call arguments in a JSON file to avoid shell quoting changes.

```powershell
npm.cmd run agent-test -- start --backend offline --transport stdio --goal "Create a project tracker and add two tasks"
# prints a manifest path under live-smoke-results/agent-test/<runId>/

npm.cmd run agent-test -- list --session <manifest>
npm.cmd run agent-test -- list --search document --session <manifest>
npm.cmd run agent-test -- describe createDocument --session <manifest>

# Save every PowerShell call payload as JSON, then pass its path. Inline JSON
# loses its quotes under this shell.
npm.cmd run agent-test -- call createDocument --session <manifest> --args '@request.json'
npm.cmd run agent-test -- note --session <manifest> --text "Document was created"
npm.cmd run agent-test -- friction --session <manifest> --tool createDocument --text "Schema did not make the required parent clear"
npm.cmd run agent-test -- status --session <manifest>
npm.cmd run agent-test -- finish --session <manifest> --outcome fail --summary "Parent requirement was not discoverable"
```

The command surface is:

```text
npm run agent-test -- start --backend offline|live --transport stdio|http --goal "..." [--timeout-ms N] [--folder-id id]
npm run agent-test -- list [--search <text>] --session <manifest>
npm run agent-test -- describe <tool> --session <manifest>
npm run agent-test -- call <tool> --session <manifest> --args <JSON or @file> [--expected-negative "reason"]
npm run agent-test -- note|friction --session <manifest> --text "..." [--tool name]
npm run agent-test -- status --session <manifest>
npm run agent-test -- finish --session <manifest> --outcome pass|fail|blocked --summary "..."
```

The manifest is the session handle. Use `status` to learn the session's fixture folder, workspace, and backend limitations. Treat the manifest as sensitive operational state: it may hold the local broker credential. Do not copy its token, credentials, or raw environment into a brief, report, issue, or PR. If `finish` cannot reach the broker, use the controller's recovery guidance and report the cleanup state rather than killing processes by name.

On PowerShell, use `@request.json` for every `call`; do not pass inline JSON. Other shells may accept inline JSON, but file-backed payloads are the portable form used in these instructions.

## Fresh tester rules

Give the tester a goal and scope only. It should search with `list --search` using outcome words, then inspect candidates with `describe`; full `list` remains available for broad discovery. It may call tools, inspect MCP response envelopes and schemas, and read normal user-facing documentation. It must not read source code, tests, prior reports, or another tester's notes. A source-informed recovery is a finding, not a clean pass.

Every failure, confusing schema, guess, retry, workaround, or unexpected error is friction. Record it immediately through `friction`; eventual success does not erase it. For an intentional negative call, include `--expected-negative "reason"` on that `call` command before execution. The controller records the marker first, so an expected-negative label cannot be added retroactively to erase a failure.

## Backend boundary

`offline` is a stateful, limited Docs/Drive/Sheets fixture. It proves the MCP session and supported flows without network or Google credentials. An operation outside its supported surface returns `blocked` or inconclusive and cannot make the session pass.

`live` requires an existing saved project OAuth token. It also requires `GOOGLE_MCP_TEST_FOLDER_ID` or `start --folder-id <id>`, then creates an isolated child folder for the run. It preserves the existing in-server guards for every client connection and cleans only owned resources. The test broker blocks Maps, `uploadFile`, `downloadFile`, `insertImage`, `addPermission`, `updatePermission`, and `removePermission`, along with mail, authentication, feedback, browser-opening, and other configured side effects. Existing read-only service restrictions remain in force. Live success is evidence for the exercised flow, not a claim that every registered tool works E2E.

## Verdict and review

Finish with `pass` only when all of these are true:

- the tester explicitly selects `pass`;
- it made at least one successful tool call;
- no unexpected call failure or recorded friction exists;
- it did not block or time out; and
- the report records clean resource cleanup and session health.

The main agent verifies the report, JSONL, manifest identity, and actual created or changed resource before accepting the result. A process exit code, a successful `finish` invocation, or a report written to disk alone is not proof. After a finding, fix it, run the affected regression smoke suite, and give the same outcome-only brief to a new tester. Stop after three repair iterations by default and report the remaining defect or explicit external blocker.
