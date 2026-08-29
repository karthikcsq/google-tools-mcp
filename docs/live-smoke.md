# Live smoke

Unit tests are green on every open PR and users still hit bugs that only show up
against real Google Docs, Drive and Gmail: markdown that exports but does not
re-import, a read that silently wipes a locally edited mirror, a draft whose `=`
characters vanish. None of those are catchable with a mocked Google client,
because none of them are wrong at the call site — they are wrong at the far end.

Live smoke closes that gap. It runs the real tools, in-process, against a real
Google account, confined to one throwaway Drive folder, and asserts on what
comes back.

There are two entry points and they answer different questions.

| | question it answers |
|---|---|
| `npm run live-call` | "I just changed X. What does X actually do against the real API?" |
| `npm run live-smoke` | "Is this branch safe to merge?" |

---

## For agents: you changed X, here is the command

The MCP server your client has registered points at **one fixed install
directory**. If you are working in a worktree on a branch, that server is not
running your code, and no amount of restarting will make it. `live-call` is the
way around that: it loads `dist/` **relative to itself**, so it always runs the
build in the worktree you are working in. It prints the resolved path at
startup — check that line before trusting a result.

```bash
export GOOGLE_MCP_TEST_FOLDER_ID=<your throwaway folder id>

# what does this build actually register?
npm run live-call -- --list

# run one tool. $FOLDER expands to the test folder id.
npm run live-call -- createDocument title="probe" parentFolderId=$FOLDER
npm run live-call -- readDocument '{"documentId":"1abc...","format":"text"}'
npm run live-call -- modifyText @edit.json

# trash everything your live-call pokes created
npm run live-call -- --cleanup

# ...or specific ids, which is what "live-smoke --keep" prints for you
npm run live-call -- --cleanup 1abc... 1def...
```

Argument forms are the same three `scripts/call-local-tool.js` accepts:
`key=value` pairs, one JSON object, or `@path/to/args.json`.

Pick the check that matches what you touched:

| you changed | run this |
|---|---|
| a Docs read/write tool, the markdown transformer, `readTracker`, `docsHandles` | `npm run live-smoke -- docs` |
| `copyFile`, `listFolderContents`, anything under `dist/tools/drive/` | `npm run live-smoke -- drive` |
| draft or message construction, `dist/helpers.js` MIME assembly | `npm run live-smoke -- gmail` |
| comment tools, section-scoped editing, list handling | `npm run live-smoke -- checklist` |
| one specific issue's fix | `npm run live-smoke -- issue-118-bold-trailing-space` (or just `118`) |
| a tool's schema, and you want to see the shape of one call | `npm run live-call -- <toolName> ...` |

Two things worth knowing before you read a result:

- **`live-call` tells you when a schema drops your argument.** Passing a key the
  tool does not declare prints `note: the tool's schema dropped "name"`. That
  silent strip is the whole of issue #124, and it is invisible from the result
  alone.
- **A repro that passes on a branch without the fix is a broken repro.** The
  `BASE` column in the summary records what each scenario is expected to do on a
  branch that has none of the fixes. A scenario that disagrees with its
  `expectedOnBase` is called out by name at the bottom of the table — look at it
  before you believe it.

---

## What it will and will not touch

These are enforced in `scripts/live-smoke/guard.mjs`, in code, not in this
document. The scenarios cannot opt out of them.

**Will:**

- Create files inside `GOOGLE_MCP_TEST_FOLDER_ID`, and mutate files whose parent
  chain reaches that folder.
- Create Gmail **drafts**, addressed to the authenticated account's own address.
- Read anything the account can read (a couple of scenarios need a real inbound
  message with an attachment, which nothing in a smoke run can create).
- Write to `live-smoke-results/` (gitignored) — one JSONL journal per run, plus
  a run-scoped workspace for the local markdown mirror.

**Will not:**

- **Send mail.** `sendMessage`, `sendDraft`, `replyMessage` and `forwardMessage`
  throw in the runner before the tool's `execute()` is entered. Underneath that,
  `users.messages.send`, `users.drafts.send`, `users.messages.insert` and
  `users.messages.import` are denied by name at the Gmail client. Two
  independent layers, because this one is unrecoverable if it leaks.
- **Write outside the test folder.** Every mutation naming an existing file id
  has that id's parent chain walked first; every creation must name a parent
  inside the folder. A creation with no parent would land in Drive root, so it
  is refused rather than allowed.
- **Touch your real working copies.** `readDocument` writes a local markdown
  mirror. The runner points `GOOGLE_MCP_WORKSPACE_DIR` at a run-scoped sandbox,
  so a smoke run can never overwrite a file a human has pending edits in.
- **Delete anything it did not create.** Cleanup walks the ids the run tracked,
  in reverse creation order, re-verifies containment on each one, and reports
  anything it could not clean. The folder is listed afterwards and the count
  goes in the summary.
- **Write to Calendar, Tasks, Forms or Apps Script at all.** Those resources do
  not live under a Drive folder, so there is nothing to confine them to.

The default is deny. Any Google client method whose name looks like a mutation
(`create`, `update`, `delete`, `batchUpdate`, `send`, …) and has no explicit
confinement rule fails closed. Adding a scenario that needs a new mutating
method means adding a rule with its containment check — that is deliberate.

### Setting up the folder

Make a throwaway folder in your own Drive, copy its id out of the URL, and put
it in `.env.live-smoke` (gitignored; see `.env.live-smoke.example`). Nothing
runs without it — there is no default and no fallback, because an unset variable
must never quietly degrade into "write somewhere in My Drive".

---

## Running the scenarios

```bash
npm run live-smoke                                  # everything
npm run live-smoke -- docs                          # one cluster
npm run live-smoke -- docs gmail                    # several
npm run live-smoke -- issue-122-read-overwrites-mirror
npm run live-smoke -- --list                        # what exists, calls nothing
npm run live-smoke -- docs --keep                   # skip cleanup and go look at the artifacts
```

Exit code is non-zero if any scenario failed, if cleanup could not remove
something it created, or if a draft the run created is still in the mailbox.
`--keep` prints the exact `live-call -- --cleanup <ids>` command for whatever it
left behind. `--list` and a scenario selector both accept a cluster
name, a file name, a scenario name, or an issue number.

The summary table is the only thing written to stdout. Progress, tool logs and
Google's own chatter go to stderr, and `process.stdout.write` is swapped for a
forwarder while scenarios run, so a tool that writes to stdout is counted and
reported (`Stdout leaks from tool code paths:`) instead of corrupting the table.

Every tool call lands in `live-smoke-results/<run-id>.jsonl`: name, arguments
with long strings truncated, the arguments after the tool's own zod parse,
outcome, duration, and the result or error. When a scenario fails and the reason
line is not enough, that file is where to look.

---

## Adding a scenario

Drop a `.mjs` file in `live/<cluster>/` — clusters are `docs`, `drive`, `gmail`,
`checklist`. Discovery is by directory and file name, sorted, so ordering is
stable across runs and machines.

```js
export const name = 'issue-999-something-specific';
export const issue = 999;
export const description = 'One sentence: what must be true.';
export const expectedOnBase = 'fail';   // 'fail' until the fix lands, then 'pass'

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#999 probe'), ctx.fixture('issue-999.md'));
    await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });
    const text = await ctx.call('readDocument', { documentId: doc.id, format: 'text' });
    ctx.assertNotIncludes(text, '**', 'What the reporter said was wrong (#999).');
}
```

What `ctx` gives you:

| | |
|---|---|
| `call(tool, args)` | in-process, journalled, guarded. Parses arguments through the tool's own zod schema first, exactly as the MCP transport does — so an undeclared parameter gets stripped here the same way it did for the reporter |
| `tryCall(tool, args)` | same, returns `{ ok, result, error }` instead of throwing |
| `folderId`, `runId`, `self` | the sandbox, this run's id, the authenticated address |
| `fixture(name)` | read `live/fixtures/<name>` |
| `title(label)` | a title carrying the run id, so concurrent runs cannot collide |
| `createDoc`, `createFolder` | create inside the sandbox and track for cleanup |
| `track(id, 'drive' \| 'draft')` | register anything else you created |
| `assert`, `assertEqual`, `assertIncludes`, `assertNotIncludes`, `assertMatch`, `fail`, `skip` | assertions; the message becomes the reason line in the table |
| `readMirror`, `writeMirror`, `mirrorExists`, `rememberMirror(result)` | the local markdown working copy `readDocument` writes |
| `hasTool(name)` | for acceptance checks on a tool that may not exist on this branch |

Rules that keep a run deterministic and worth trusting:

1. **Seed from a fixture.** Documents come from a checked-in file under
   `live/fixtures/`, never from text generated at run time. Two runs must
   exercise byte-identical input.
2. **Do not read pre-existing Drive state.** Create what you need inside the
   sandbox. (`checklist-5` is the one exception, and it skips rather than
   guesses when the mailbox has nothing suitable.)
3. **Replicate the reporter's steps, in their order, with their parameter
   names.** If they passed `name`, pass `name` — not the parameter the tool
   actually declares.
4. **Assert strictly.** Compare read-back text byte for byte, or check
   `format='text'` for literal markdown characters. A scenario that passes on a
   build that still has the bug is worthless.
5. **Assert on the observed outcome, not the reporter's diagnosis.** Two of the
   scenarios here do exactly that, and say so in their file header, because the
   mechanism the reporter guessed turned out not to be the mechanism.
6. **Say when it is an acceptance check.** Some issues describe a design gap
   with no reproducible steps. Those scenarios say so in the first lines of the
   file and take their assertions from the issue's own stated acceptance.
7. **Read before you write.** `createDocument` does not register as a read, so
   the first mutation after it is rejected. Call `readDocument` first.

---

## The rule for PRs

**A PR that touches a cluster must include a passing `live-smoke <cluster>` run
in its description** — the summary table, pasted verbatim, from the branch as
submitted. Paste the whole table, including the scenarios that failed: the
`BASE` column and the "disagreed with expectedOnBase" line are what make it
readable, and hiding a failure that was expected is as unhelpful as hiding one
that was not.

Which cluster a change touches:

- `dist/tools/docs/`, `dist/markdown-transformer/`, `dist/readTracker.js`,
  `dist/docsHandles.js`, `dist/googleDocsApiHelpers.js` → **docs**
- `dist/tools/drive/` → **drive**
- `dist/tools/gmail/`, the MIME assembly in `dist/helpers.js` → **gmail**
- comment tools, section-scoped editing, list handling → **checklist**

If a PR fixes an issue that has a scenario, flip that scenario's
`expectedOnBase` to `'pass'` in the same PR, and the table in the description is
the evidence. This repo has no pull request template; when one is added, this
rule gets a line in it.
