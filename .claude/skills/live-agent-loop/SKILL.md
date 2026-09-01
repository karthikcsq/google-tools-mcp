---
name: live-agent-loop
description: Prove google-tools-mcp tools actually work for a real AI agent by running goal-driven missions against the live Google API, collecting friction reports, fixing what they expose, and looping until an independent agent succeeds without workarounds. Use when asked to verify tools work "in the real world", "like an agent would use them", to validate a tool change end to end before release, when a tool works in unit tests but users report it failing, or when writing/running a live mission. Trigger phrases: "test it for real", "live test", "prove the tools work", "run a mission", "agent loop", "does this work end to end".
---

# Live agent loop

Unit tests prove a tool does what its author expected. They cannot prove a tool
is *usable* by an agent that was handed a goal and no instructions. Those are
different questions, and only the second one predicts what happens after release.

This skill runs the second test: give a subagent a real objective, make it reach
the objective using only the MCP tools against the real Google API, and treat
everything it struggled with as a defect.

## The core rule

**Friction is a bug.** If the agent needed three attempts, guessed a parameter
name, had to read the source, or worked around an error message that did not say
what was wrong, that counts as a failure even though the task eventually
succeeded. A future agent will hit the same wall with less patience.

Do not fix the mission to avoid the friction. Fix the tool.

## Safety, before anything else

Every run touches a **real Google account**. The envelope is non-negotiable:

- Every write is confined to the sandbox Drive folder named by
  `GOOGLE_MCP_TEST_FOLDER_ID` in `.env.live-smoke`. There is no default and no
  fallback; the runner refuses to start without it.
- Gmail send paths are blocked at the harness level. `sendMessage`, `sendDraft`
  and friends refuse in `BLOCKED_TOOLS`.
- Containment is re-verified at cleanup time, so a run trashes exactly what it
  created inside the sandbox and nothing else.

**Never disable, weaken, or route around any check in
`scripts/live-smoke/guard.mjs`.** If the guard blocks something you believe is
legitimate, that is a finding to report, not an obstacle to remove.

## The three harnesses, and when each applies

| Runner | Scope | Use it for |
| --- | --- | --- |
| `npm run live-smoke` | checked-in scenarios with assertions, `live/` | regression: things we already decided to assert |
| `npm run live-call` | one tool, one process | a quick probe of a single tool you just changed |
| `npm run live-mission` | one multi-step task, one process | **this loop**: goal-driven work with real session state |
| `npm run live-coverage` | no network; static | which of the 160 tools live code actually drives, and which it does not |

The distinction that matters: `live-call` starts a fresh process per call, so the
read tracker and read handles die between calls. A create-then-write sequence,
the most common real agent workflow, is structurally unprovable with it. A
mission runs the whole task in one process, which is what a real MCP client
session looks like.


After a mission lands a new tool in `live/`, run `npm run live-coverage` and put
the new number in the report. It also exits non-zero when a scenario calls a
tool that no longer exists, which is how a scenario goes quietly dead after a
rename.
## The loop

### 1. Set up

```bash
cp .env.live-smoke.example .env.live-smoke     # gitignored; already has the folder id
npm run live-call -- --list                    # confirm the harness starts and auth works
```

### 2. Pick a goal, not a script

A good goal names an *outcome a person would want* and leaves the route open:

- "Produce a formatted meeting-notes doc with headings, a table and a task list,
  then revise one section without touching the rest."
- "Find the spreadsheet in this folder, add a column of computed values, and
  format the header row."

A bad goal is a list of tool calls. If you specify the calls, you have written a
scenario, and you will only learn what you already knew.

### 3. Delegate the mission to a subagent

The subagent must be told:

- The goal, in plain language.
- That it may only use MCP tools through `ctx`, never the Google SDK directly.
- Where the docs are (`README.md`, tool descriptions) and that **discovering the
  docs are wrong is a finding worth more than finishing the task**.
- To call `ctx.note(...)` for observations and `ctx.friction(tool, ...)` every
  time a tool cost more than it should have.
- To report honestly, including its own dead ends. A report that hides a failed
  first attempt destroys the only signal this loop produces.

### 4. Run it

```bash
npm run live-mission -- live/missions/<name>.mjs
npm run live-mission -- live/missions/<name>.mjs --keep   # leave artifacts to inspect
```

The runner writes `live-smoke-results/mission-<name>-<runId>.json` containing
every call, its args, outcome, duration and error, plus a per-tool rollup of
failures and every distinct error message.

**Exit code semantics:** a failed mission exits 0, because a mission that failed
is a finding, not a runner error. The runner exits non-zero only when it could
not do its own job: a safety refusal, a stdout leak from the tool code path, or
cleanup leaving something behind. Read the status line, never the exit code
alone.

### 5. Triage the report

For every entry in `perTool` with `failures > 0`, and every `frictions` entry,
decide which it is:

- **Tool defect.** Wrong behavior, or an error that does not name the fix. Fix
  the tool.
- **Documentation defect.** The tool works but its description or the README
  sent the agent the wrong way. Fix the description.
- **Mission defect.** The agent genuinely misused the tool and a correct reading
  of the docs would have prevented it. Only valid if you can point at the
  sentence that says so. If you cannot, it is a documentation defect.

The third category is the one to be suspicious of. It is the comfortable answer
and it is usually wrong.

### 6. Fix, then loop

Re-run the same mission after fixing. Then run it with a **fresh subagent that
has not seen the previous attempt**, because an agent that already knows the
answer cannot tell you whether the fix helped.

### 7. Exit criteria

Stop when a fresh subagent, given only the goal, reaches it with:

- zero `frictions` recorded,
- no failed tool calls other than ones that are *supposed* to fail (guard
  rejections, deliberate negative checks),
- no source reading required, and
- the agent stating plainly that it would use these tools again unassisted.

Anything short of that is another iteration.

## Writing a mission

Missions live in `live/missions/` and are the same shape as a `live/` scenario
minus the assertions. See `live/missions/harness-selftest.mjs` for a worked
example.

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

Context API:

| Call | Behavior |
| --- | --- |
| `await ctx.call(tool, args)` | throws on failure |
| `await ctx.tryCall(tool, args)` | returns `{ok, result, error}`, never throws |
| `await ctx.createDoc(title, markdown)` | seeded doc in the sandbox |
| `ctx.title(label)` | label + run id, so concurrent runs cannot collide |
| `ctx.folderId` | the sandbox folder id |
| `ctx.note(text)` | observation, lands in the report |
| `ctx.friction(tool, text)` | **the point of the exercise** |
| `ctx.hasTool(name)` / `ctx.toolNames()` | what this build actually registers |
| `ctx.sleep(ms)` | for eventual-consistency waits |

Anything created by a creating tool (`createDocument`, `createSpreadsheet`,
`copyFile`, `uploadFile`, `createFolder`, `createPresentation`,
`createDocumentFromTemplate`, `createDraft`) is registered for cleanup
automatically. You do not need to call `ctx.track()`, and forgetting to is not
supposed to leak files into a real Drive.

**Before recording an "undocumented" friction, call `ctx.describe(toolName)`.**
It returns the description a real MCP client sees in `tools/list`. A mission
calls tools by name, so without it you are strictly blinder than the agent you
stand in for, and you will report things the description states plainly.
Iteration 2 did exactly that to `help`, whose description already said
`Pass tool='<toolName>'`.

**Before recording a "this write destroyed my content" friction, confirm it with
`readDocument(format='index')`, not `format='markdown'`.** Markdown is a
rendering; the index is the document. Iteration 2 burned three documents and
seven calls chasing a data-loss bug that was never happening, because the
markdown reader was wrapping every run in a colour span and its heading check
stopped matching.

## Pitfalls

- **Reading `Tests:` instead of `Test Suites:`.** A suite that fails to link
  reports zero failed tests while being completely broken. This bites on the
  unit side, and the same instinct bites here: read the status line, not the
  exit code.
- **Letting the subagent read the tool source.** It will then use the tool
  correctly for reasons no future agent will have access to. If it needs the
  source, that is the finding.
- **Re-running with the same agent and calling it fixed.** It remembers. Use a
  fresh one for the verification pass.
- **Treating an eventual success as a pass.** Three attempts is a fail.
- **`--keep` and forgetting.** Artifacts stay in the sandbox. Clean up with
  `npm run live-call -- --cleanup [ids...]`.

## Reference

Deep documentation, including the report schema and the safety boundaries:
[`docs/live-agent-loop.md`](../../../docs/live-agent-loop.md).
