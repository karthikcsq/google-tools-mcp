# Regression smoke

Regression smoke runs checked-in, in-process scenarios against the configured Google test account. Use it to guard behavior already represented under `live/` after a related change. It does not prove interactive client transport or source-blind discovery; use [interactive sessions](interactive-sessions.md) for that.

## Set up and choose a run

Create a throwaway Drive folder, put its id in the gitignored `.env.live-smoke` file (see `.env.live-smoke.example`), and use the exact worktree that contains the change. The harness refuses to run without that explicit folder.

```powershell
npm.cmd run live-smoke                         # all scenarios
npm.cmd run live-smoke -- docs                 # one cluster
npm.cmd run live-smoke -- docs gmail           # several clusters
npm.cmd run live-smoke -- issue-122-read-overwrites-mirror
npm.cmd run live-smoke -- --list               # discover scenarios; makes no calls
npm.cmd run live-smoke -- docs --keep          # retain artifacts for inspection
```

Selectors accept a cluster, file, scenario name, or issue number. Pick the narrowest cluster matching the change: Docs/read-state/markdown work uses `docs`; Drive tools use `drive`; Gmail or MIME work uses `gmail`; comments, lists, and section editing use `checklist`.

A PR touching one of those clusters must include the complete passing `live-smoke <cluster>` summary table from the submitted branch, including any expected failures and the `BASE` comparison. When fixing an issue with an existing scenario, update its `expectedOnBase` to `pass`. Do not omit failed rows from the evidence.

## Probe one tool from this worktree

`live-call` loads `dist/` relative to itself, rather than through an installed MCP registration. Check its reported resolved path before trusting the result.

```powershell
npm.cmd run live-call -- --list
npm.cmd run live-call -- createDocument '@create-document.json'
npm.cmd run live-call -- readDocument '@read.json'
npm.cmd run live-call -- modifyText '@edit.json'
npm.cmd run live-call -- --cleanup
npm.cmd run live-call -- --cleanup 1abc 1def
```

The CLI accepts `key=value` pairs, one JSON object, or `@path/to/args.json`, but PowerShell inline JSON strips quotes. Use a quoted `@path/to/args.json` payload for every tool call in PowerShell. `live-call` notes when its schema drops an undeclared argument, which is evidence about the client-facing shape rather than a successful call.

## Read results and clean up

The harness permits only configured-folder mutations, run-scoped local mirrors, and owned-resource cleanup. It blocks mail sending and non-Drive writes such as Calendar, Tasks, Forms, and Apps Script. Do not weaken `scripts/live-smoke/guard.mjs` or route around it.

The scenario command fails when a scenario fails, cleanup leaves an owned resource, or a created draft remains. `--keep` prints the exact cleanup command for retained ids; run it when inspection ends. Read the summary and its JSONL journal under `live-smoke-results/`, including reported stdout leaks and cleanup state, rather than treating exit status alone as proof.

For new regression coverage, add a deterministic `.mjs` scenario under the relevant `live/<cluster>/` directory, create inputs inside the sandbox, and assert the observed result strictly. Use fixtures for document inputs, register anything the helpers do not auto-track, and never depend on arbitrary pre-existing Drive state.

`npm.cmd run live-coverage` is static inventory. It identifies registered tools named by checked-in scenario code, excludes tools blocked by design, and detects stale scenario names. Its live-covered total is scenario presence, not measured successful Google API coverage, a pass rate, or proof that every named call reached Google. Run it for the current inventory instead of publishing a hardcoded count.

For the retained direct goal-runner format, read [legacy missions](legacy-missions.md). New fresh-agent validation uses `agent-test`, not a direct mission.
