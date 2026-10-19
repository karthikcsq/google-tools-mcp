# Legacy direct missions

`live-mission` is the older direct, in-process goal runner. It retains one process for a multi-step task and is useful as regression evidence for read-tracker or handle state. It does not test a real MCP client connection, so it cannot replace the interactive `agent-test` loop.

## Run a mission

```powershell
npm.cmd run live-mission -- live/missions/<name>.mjs
npm.cmd run live-mission -- live/missions/<name>.mjs --keep
```

The runner writes `live-smoke-results/mission-<name>-<runId>.json` and its
JSONL journal. `--keep` retains created artifacts for inspection; use the
printed `live-call -- --cleanup <ids>` commands when finished.

## Mission shape

Missions live under `live/missions/` and export a name, goal, and `run(ctx)`.
Use `note` for observations and `friction` for every unexpected retry, schema
guess, workaround, or misleading error. A later successful call does not erase
friction.

```js
export const name = 'meeting-notes';
export const goal = 'Create formatted meeting notes, then revise one section.';

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('notes'), '# Notes\n');
    ctx.note(`created ${doc.id}`);
    const attempt = await ctx.tryCall('insertTable', {
        documentId: doc.id, rows: 3, columns: 2,
    });
    if (!attempt.ok) ctx.friction('insertTable', attempt.error?.message ?? 'first attempt failed');
}
```

`ctx.call(tool, args)` throws on failure and `ctx.tryCall(tool, args)` returns
`{ ok, result, error }`. `createDoc`, `createFolder`, `title`, `folderId`,
`hasTool`, `toolNames`, `describe`, `readMirror`, `writeMirror`, and `sleep`
provide the controlled task environment. Call `describe(tool)` before treating
a tool as undocumented.

Creating tool results are auto-registered for cleanup. A successful creation
whose response names no resource id is reported as `UNTRACKED` and makes the
runner fail so it cannot silently leak a Drive artifact.

## Report and exit semantics

The report contains the mission status and reason, ordered calls, per-tool
failures and distinct errors, notes, frictions, cleanup state, registered
resources, untracked creations, and the journal path. Inspect it directly.

A mission may have status `fail` while the process exits zero: that is a product
finding. A nonzero process exit means the runner itself could not establish a
trustworthy result, including an unexpected safety refusal, stdout leakage,
untracked creation, failed cleanup, or unverified owned leftovers. For a
deliberate guard test, export the exact `expectsSafetyRefusals` count; any other
count remains a runner failure.

Classify each failure or friction as a tool defect, a documentation defect, or
a mission misuse only when a tester could actually find the correct instruction.
Fix the tool or documentation, run the affected regression smoke scenario, and
then use a fresh source-blind interactive tester for the final verdict.
