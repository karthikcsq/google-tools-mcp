---
name: live-testing
description: Test google-tools-mcp as an MCP consumer would, using regression smoke scenarios or an interactive goal-first agent session. Use for end-to-end tool validation, live Google checks, agent usability testing, or diagnosing friction that unit tests miss.
---

# Live testing

Use this skill when the question is whether a real MCP client can complete a goal, rather than whether a tool implementation passes a known assertion.

Choose the mode before you run anything:

- **Regression smoke** runs the existing in-process scenarios. It verifies behavior already encoded in `live/`; its static coverage output is scenario presence, not measured successful API coverage. Read [regression smoke](references/regression-smoke.md).
- **Interactive agent test** gives a source-blind tester an outcome, then drives the same MCP transport and session state that a client uses. It is the required mode for a fresh-agent usability verdict. Read [interactive sessions](references/interactive-sessions.md) and use the [tester brief](references/source-blind-tester-brief.md).

## Interactive loop

1. Start an owned session with `npm.cmd run agent-test -- start ...`; retain the JSON manifest path it prints.
2. Search with `list --search <keywords>`, then `describe` the candidates before calling them. Use full `list` only when broad inventory is useful. Do not inspect source or give the tester implementation hints.
3. Record each unexpected error, retry, ambiguity, or workaround with `friction` even if the goal is eventually reached. For an intentional negative call, add `--expected-negative "reason"` to that `call` command before it runs.
4. Read `status` and the generated report/artifacts directly. Exit status alone is never the verdict.
5. Fix the discovered product or documentation issue, run the applicable regression, then repeat with a fresh source-blind tester. Default to at most three repair iterations; report the unresolved blocker after that bound.

An interactive test passes only when the tester explicitly finishes `pass`, has meaningful successful calls, no unexpected failures or friction, and the report shows cleanup and session health are clean. Unsupported offline behavior is `blocked`, never a pass. The live backend remains deliberately bounded and cannot establish E2E behavior for every tool.

## Safety and evidence

Use the exact worktree under test. The live backend requires an existing project OAuth token and a configured test folder through `GOOGLE_MCP_TEST_FOLDER_ID` or `start --folder-id`; it keeps mutations inside a per-run child folder. Do not weaken existing guards or use the test session to perform mail, calendar, tasks, forms, script, auth, feedback, browser, Maps, local upload/download, image insertion, or permission-changing side effects.

Preserve the manifest, report, JSONL, resource/cleanup evidence, backend and transport, and code identity with the result. The main agent independently checks the actual resource result and report before calling the loop successful.

## References

- [Interactive sessions](references/interactive-sessions.md): CLI contract, verdict, artifacts, and live/offline boundaries.
- [Regression smoke](references/regression-smoke.md): existing scenario runner and how to interpret its coverage output.
- [Legacy direct missions](references/legacy-missions.md): retained in-process multi-step runner, its report, and cleanup behavior.
- [Source-blind tester brief](references/source-blind-tester-brief.md): template for a fresh goal-only test pass.
