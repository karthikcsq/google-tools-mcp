# The live agent loop

How this project proves its tools work for the thing that actually uses them: an
AI agent that was handed a goal and no instructions.

The operational protocol lives in
[`.claude/skills/live-agent-loop/SKILL.md`](../.claude/skills/live-agent-loop/SKILL.md).
This document is the reference behind it: why the loop exists, what the harness
guarantees, what the report contains, and where the boundaries are.

## Why unit tests are not enough here

The test suite answers "does this tool do what its author expected". That is a
necessary question and an insufficient one, because every assertion in it was
written by someone who already knew the right answer.

The question that predicts what happens after release is different: **can an
agent that has never seen this codebase reach a real objective using only these
tools and their descriptions?** An agent cannot read the implementation. It has
the tool name, the parameter schema, the description string, and whatever the
error messages tell it. If any of those are wrong or incomplete, the tool fails
in the field while passing every test.

#135 is the case in point. `createSpreadsheet` never seeded read-tracker state,
so creating a spreadsheet and immediately writing to it was rejected with "this
file has not been read in this session". Every unit test passed. The tool was
unusable for the most obvious workflow it has, and it stayed that way through a
full review cycle because nothing exercised create-then-write against the real
API in one session.

## What live testing actually covers

`npm run live-coverage` prints this, so it never has to be typed by hand:

```
  registered tools     160
  live-covered         29  (18.1%)
  not live-covered     131
  blocked by design    2  (named by a scenario, never executed)
```

That number is the honest one, and it should not be rounded up. 29 of 160 tools
have been driven against the real Google API by checked-in code. The other 131
have unit tests and nothing else. "Checked-in code" means the scenarios and
missions that run green today; `live/missions/archive/` holds frozen iteration
transcripts that are not expected to pass, and the scan skips it. The scan also
credits `ctx.createDoc()` and `ctx.createFolder()` to the tools they call
(`createDocument`, `createFolder`), accepts any quote style around the tool
name, and exits 1 if it finds zero covered tools, since a silent 0 would mean
the scan is broken rather than the coverage. The two "blocked by design" are named by a
scenario only to prove the refusal holds (`forwardMessage`, which the runner
blocks before `execute()`, and `createPresentation`, which the guard denies at
the API layer), so they count as uncovered rather than covered.

The 29 are not a random sample. They are the tools whose behaviour changed in
3.0 in a way that could break at the API boundary: the whole Docs read/write
path, Docs comments, the Drive listing and copy paths, the Gmail MIME path, and
the Sheets create-then-write contract from #87/#135. The gap that matters is
smaller than 131, because most of the uncovered tools were touched only by the
mechanical SDK v2 migration, and that migration *is* verified across all 160 --
`registerAllTools` registers every one of them and `help` with `listTools=true`
returns all 160 names through the real server.

Four behavioural changes in 3.0 are deliberately not live-covered, and the
reason is the safety envelope rather than an oversight:

| Change | Why not live |
| --- | --- |
| #128 Maps error message | Needs a `GOOGLE_MAPS_API_KEY` that does not exist; the whole point of the fix is the message shown when it is missing. |
| #114 `feedback` shell injection | Running it files a real GitHub issue. |
| #125 browser-open helpers | Opens a browser window on the host. |
| #115 re-authentication | Replaces the live refresh token mid-run. |

`live-coverage` also exits non-zero if a scenario calls a tool that is no longer
registered, which is how a scenario goes quietly dead after a rename.

Growing the covered set is the useful next move for this harness. Each new
mission that reaches a real objective adds whatever tools it needed, and the
count moves on its own.

## The core rule

**Friction is a bug.**

If the agent needed three attempts, guessed a parameter name, had to read the
source, or worked around an error message that did not say what was wrong, that
is a failure even though the task eventually succeeded. The next agent will hit
the same wall with less patience and no orchestrator watching.

The temptation is to fix the mission so the friction disappears. That converts a
finding into a hidden defect. Fix the tool.

## Safety boundaries

Every run touches a real Google account. Six boundaries enforce the envelope, all
implemented in `scripts/live-smoke/`:

1. **No implicit target.** `requireTestFolderId()` refuses to start unless
   `GOOGLE_MCP_TEST_FOLDER_ID` is set to a plausible Drive folder id. There is no
   default, because an unset variable must never degrade into "write somewhere in
   My Drive".
2. **Containment on every mutation.** `guard.mjs` intercepts the Drive client and
   resolves each mutation's parent chain to the sandbox folder. Anything outside
   it is refused.
3. **Blocked tools.** `BLOCKED_TOOLS` in `context.mjs` refuses every Gmail send
   path outright. A mission cannot email anyone, deliberately or accidentally.
4. **Containment re-verified at cleanup.** Before trashing anything, the runner
   re-checks that the item is still inside the sandbox. A run trashes exactly
   what it created and nothing else.
5. **Full journal.** Every tool call, with arguments, outcome, duration and
   error, lands in `live-smoke-results/<runId>.jsonl`.
6. **Stdout lock.** Nothing on the tool code path may write to stdout, because
   stdio is the MCP transport. Leaks are counted and reported.

**Do not disable, weaken, or route around any of these.** If the guard blocks
something you believe is legitimate, that is a finding to report, not an
obstacle to remove.

## The three runners

| Runner | Process model | Answers |
| --- | --- | --- |
| `npm run live-smoke` | one per scenario | "does the behavior we asserted still hold" |
| `npm run live-call` | one per call | "did the tool I just changed work at all" |
| `npm run live-mission` | one per whole task | "can an agent get real work done with these" |

### Why `live-mission` had to exist

`live-call` starts a fresh Node process for every invocation. The read tracker
and the read-handle registry are process state, so they die between calls. A
create-then-write sequence, which is the most common real agent workflow and the
exact subject of #87 and #135, is **structurally unprovable** with `live-call`:
the second call always starts with an empty tracker regardless of whether seeding
works.

`live-smoke` runs multi-step scenarios in one process and could prove it, but a
scenario is written against a known answer. It regresses; it does not discover.

`live-mission` runs a whole task in one process with real control flow, written
by an agent chasing a goal. That is what a real MCP client session looks like.

## Writing a mission

Missions live in `live/missions/`. Same shape as a `live/` scenario, with
`ctx.friction()` and `ctx.note()` for recording what the agent ran into. The
`ctx.assert*` helpers are still there; a mission that hits one just ends with a
`fail` status instead of a friction entry. Worked example:
`live/missions/harness-selftest.mjs`.

```js
export const name = 'meeting-notes';
export const goal = 'Produce a formatted meeting-notes doc, then revise one section.';

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('notes'), '# Notes\n');
    ctx.note(`created ${doc.id}`);

    const attempt = await ctx.tryCall('insertTable', { documentId: doc.id, rows: 3, columns: 2 });
    if (!attempt.ok) ctx.friction('insertTable', `first attempt failed: ${attempt.error?.message}`);
}
```

### Context API

| Call | Behavior |
| --- | --- |
| `await ctx.call(tool, args)` | throws on failure |
| `await ctx.tryCall(tool, args)` | returns `{ok, result, error}`, never throws |
| `await ctx.createDoc(title, markdown)` | seeded doc inside the sandbox |
| `await ctx.createFolder(name, parent?)` | folder inside the sandbox |
| `ctx.title(label)` | label + run id, so concurrent runs cannot collide |
| `ctx.folderId` | the sandbox folder id |
| `ctx.note(text)` | observation, recorded in the report |
| `ctx.friction(tool, text)` | the signal this whole exercise exists to produce |
| `ctx.hasTool(name)`, `ctx.toolNames()` | what this build actually registers |
| `ctx.describe(name)` | the tool's description string, as a real MCP client sees it in `tools/list` |
| `ctx.readMirror()`, `ctx.writeMirror()` | the local working copy for mirror flows |
| `ctx.sleep(ms)` | eventual-consistency waits |

Call `ctx.describe(tool)` before recording an "undocumented" friction. Missions
invoke tools by name, so without it a mission is strictly blinder than the agent
it stands in for. The iteration-2 mission recorded `help` as undiscoverable while
`help`'s own description said `Pass tool='<toolName>'` in plain text.

### Automatic cleanup

Checked-in scenarios call `ctx.track()` by hand, which is fine because a human
reviewed them. A mission is written by an agent chasing a goal, and "remember to
register every file you create" is exactly the bookkeeping an agent drops.
Forgetting it leaks real files into a real Drive.

So `live-mission` wraps `ctx.call` and `ctx.tryCall` and auto-registers anything
returned by a creating tool: `createDocument`, `createFolder`,
`createDocumentFromTemplate`, `createSpreadsheet`, `createPresentation`,
`copyFile`, `uploadFile`, `createDraft`. The map, and the id extraction that
reads each tool's result shape (JSON keyed `id` or `presentationId`, or the
prose `createDocumentFromTemplate` returns), live once in
`scripts/live-smoke/createdResource.mjs` and are shared with `live-call`.
`tests/liveHarnessCreatedResource.test.js` pins every listed tool to a result
shape the extractor can read.

A creating call that succeeds but names no id the extractor can find is
reported as `UNTRACKED` next to the cleanup line and fails the run. Without
that, the cleanup count only ever described the files the runner had noticed.

This was itself found by running the loop on the harness: the first self-test
created four files and cleaned up one.

## The report

Written to `live-smoke-results/mission-<name>-<runId>.json`.

| Field | Meaning |
| --- | --- |
| `status`, `reason` | `pass` / `fail` / `skip`, and why |
| `totals.toolCalls`, `totals.failedCalls` | volume and failure count |
| `totals.safetyRefusals` | guard refusals; any non-zero value needs explaining |
| `totals.stdoutLeaks` | writes to stdout from the tool code path; must be zero |
| `perTool[]` | per tool: `calls`, `failures`, and every distinct error message |
| `notes[]` | what the mission observed |
| `frictions[]` | **what the tools cost the agent** |
| `cleanup` | attempted, cleaned, and anything left behind |
| `calls[]` | the full ordered log with args, outcome, duration, error |
| `journalFile` | the raw JSONL for anything the rollup omits |

### Exit codes

A **failed mission exits 0**. A mission that failed is a finding, not a runner
error, and making it exit non-zero would train everyone to ignore the exit code.

The runner exits non-zero only when it could not do its own job:

- a safety refusal fired that the mission did not declare (see below),
- the tool code path wrote to stdout,
- cleanup left something behind,
- a creating tool succeeded but its result named no id the runner could
  register (`UNTRACKED`), which is a file in the sandbox nothing will trash.

A mission may export `expectsSafetyRefusals = N` when its purpose is to prove a
guard deny still holds (Slides creation, for instance, is denied outright
because the Slides API creates in Drive root). Exactly `N` refusals are then
forgiven; one more or one fewer is still a runner failure, so this cannot be
used to wave refusals through.

Read the status line. Never the exit code alone.

## Triage

For every `perTool` entry with failures, and every `frictions` entry, pick one:

- **Tool defect.** Wrong behavior, or an error that does not name the fix.
- **Documentation defect.** The tool works, but its description or the README
  sent the agent the wrong way.
- **Mission defect.** The agent genuinely misused the tool, and a correct reading
  of the docs would have prevented it. Only valid if you can point at the
  sentence that says so.

Be suspicious of the third. It is the comfortable answer and it is usually a
documentation defect wearing a disguise. If the agent could not find the sentence,
the sentence does not exist for practical purposes.

## Exit criteria

Stop looping when a **fresh** subagent, one that has not seen the previous
attempt, given only the goal, reaches it with:

- zero `frictions`,
- no failed calls other than ones that are supposed to fail (guard rejections,
  deliberate negative checks),
- no source reading, and
- an explicit statement that it would use these tools again unassisted.

Re-running with the same agent proves nothing. It remembers.

## Known pitfalls

- **Letting the subagent read the tool source.** It will then use the tool
  correctly for reasons no future agent has access to. If it needs the source,
  that is the finding.
- **Treating eventual success as a pass.** Three attempts is a fail.
- **`--keep` and forgetting.** Artifacts stay in the sandbox. Clean them with
  `npm run live-call -- --cleanup [ids...]`.
- **Assuming a green unit suite means a working tool.** That is the entire reason
  this document exists.
