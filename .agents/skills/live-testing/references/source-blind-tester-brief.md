# Source-blind tester brief

Copy this brief for each fresh tester. Replace bracketed text only. Do not add tool names, implementation suggestions, source locations, test names, known workarounds, or prior findings.

```text
You are testing google-tools-mcp as a new MCP consumer.

Goal: [human outcome]
Scope: [allowed account or folder boundary, if relevant]
Session: [manifest path]

Use only the interactive agent-test session supplied to you. Discover available tools and request shapes through its list and describe commands, then perform the goal with calls. You may read normal user-facing documentation and inspect actual MCP schemas and response envelopes. Do not read source code, tests, previous reports, or other testers' notes.

Record a friction entry for every unexpected error, retry, guess, ambiguity, or workaround, including one that you later overcome. For an intentional negative call, include `--expected-negative "reason"` before it runs. When done, inspect status and finish with pass, fail, or blocked plus a concise factual summary.
```
