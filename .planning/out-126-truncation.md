OpenAI Codex v0.151.0
--------
workdir: C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
model: gpt-5.6-terra
provider: openai
approval: on-request
sandbox: workspace-write [workdir, /tmp, $TMPDIR]
reasoning effort: medium
reasoning summaries: none
session id: 01a052c8-f0d4-7e73-9f79-bc29e3f68341
--------
user
# listFolderContents silently truncates at depth 1 (issue #126, reframed)

Work only in the worktree `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE`,
branch `feat/independents`. Commit as you go. Do not push. Do not post to GitHub.
Do not touch any other worktree.

## What is actually wrong

Issue #126 was filed as "listFolderContents returns empty for every second-level subfolder".
I investigated against the real Drive API and **that claim is not reproducible**. The folders in
question are genuinely empty. Do not try to fix that. Evidence, for your context:

- Depth-1 listing, the batched depth-2 traversal, and a completely separate third-party Drive
  client all independently report those folders as empty.
- A control run of `listFolderContents(depth: 2)` on a different tree correctly returned
  15 second-level folders with correct paths, so recursion works.
- `dist/tools/drive/listFolderContents.js` already passes `supportsAllDrives: true` and
  `includeItemsFromAllDrives: true` on the depth-1 call, and already scopes recursive calls to
  `driveId` for shared drives. That part is well built. Leave it alone.

The investigation did surface a real defect, which is what you are fixing.

**The depth-1 path silently truncates.** It passes `pageSize: maxResults` (default 50, max 100),
takes one page, never looks at `nextPageToken`, and returns a bare `{folders, files}`. The caller
cannot tell a complete listing from a truncated one.

Proven against real Drive, on a folder containing 59 subfolders and hundreds of files:

```
listFolderContents(folderId, maxResults: 5, includeSubfolders: false)
  -> {"folders": [], "files": [ ...exactly 5 items... ]}
```

Nothing in that response says "there is more". An agent walking a large tree sees a fraction and
believes it saw everything. This is the reporter's actual stated harm: no way to distinguish a
complete answer from an incomplete one.

The depth>1 response already solves this. It returns `truncated`, `truncationReason`, `unreadable`
and `apiCalls`. Depth 1 returns none of it. That inconsistency is the bug.

## What to do

In `dist/tools/drive/listFolderContents.js`, in the `if (depth === 1)` branch:

1. Capture `nextPageToken` from the `files.list` response.
2. Add a `truncated` boolean to the depth-1 result. Set it true when Drive reports more pages.
3. When truncated, add a `truncationReason` string in the same spirit as the depth>1 path, naming
   the cap that was hit and what the caller can do (raise `maxResults`, up to its maximum of 100,
   or use `depth` with `maxItems`). Keep the wording concrete.
4. Do **not** start auto-paginating depth 1. The legacy contract is one page, and quota pacing
   matters. Report the truncation, do not silently fix it by fetching more.
5. Keep `folders` and `files` exactly as they are, same field names, same order. Existing callers
   must not break. `truncated` is additive.
6. Update the tool's `.describe()` text so the depth-1 description states that the result is a
   single page capped by `maxResults` and that `truncated` reports when it was cut off. The current
   description says the depth-1 response is "the legacy `{folders, files}` result", which will be
   wrong once you add the field.

## Tests

In the existing Drive test file for this tool, add cases that fail before your change and pass
after. Say so explicitly in your report, with the before/after output:

- Drive returns a `nextPageToken`: result has `truncated: true` and a non-empty `truncationReason`.
- Drive returns no `nextPageToken`: result has `truncated: false` and no `truncationReason`.
- A genuinely empty folder: `folders: []`, `files: []`, `truncated: false`. This is the case that
  distinguishes "empty" from "cut off", so assert it directly.
- The existing depth-1 shape assertions still pass unchanged apart from the added field.

## Standing constraints

- `dist/*.js` is hand-written runtime source. No `src/`, no TypeScript, no build step.
- Tests are Jest ESM: `npm test`. Bare `npx jest` FAILS. **Read the `Test Suites:` line**, not just
  `Tests:` — a suite that fails to *load* reports zero failed tests and looks green.
- The registered tool count is **160**. Do not add or remove a tool.
- After changing tracked `dist/` or `tests/` files, regenerate the snapshot **after staging**:
  `node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json > /dev/null`
  (redirect stdout, it is extremely verbose).
- Never interpolate a caught error's message into `publicError()`; use `wrapOperationError()` or
  `getApiErrorDetail()` from `dist/errors.js`.
- Stdout purity is absolute on stdio transport.
- Do not run the live smoke harness. It is not on this branch and I will run it myself.

## Report

FIXED `<sha>` with the exact before/after of the three test cases, the changed `.describe()` text,
and the `Test Suites:` line. If you think the truncation signal belongs in a different shape than
what I described, say so with your reasoning rather than silently doing something else.

warning: Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.
hook: SessionStart
hook: SessionStart Completed
codex
I’ll make the additive depth‑1 truncation signal, cover it in the existing Jest suite, regenerate the required staged snapshot, and commit locally without pushing. I’m first loading the repository’s required guidance and the Git/JS conventions that govern this work.
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -Raw 'C:\\Users\\2supe\\.claude\\CLAUDE.md'" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
 succeeded in 208ms:
# CLAUDE.md

Your Bible, your Constitution, your Source of Truth

## Your Role Here

- Your job is to be a collaborative partner that works with Elliot to accomplish his work to the highest quality, standard and degree. 

- Elliot holds himself to the highest standard and always gives 150%, so you do the same.

- You also act as a thinking and brainstorming partner, so formulate your own opinions, push back, all with the goal of helping Elliot get to a better, more impactful, more meaningful, and higher-quality outcome.

## Global Directives

- **Clarify before acting:** Before starting any task, exhaust all available context and tools (prior messages, provided files, permitted browsing, and accessible tools like relative dates via a `date` call, locations via WebSearch, config/state via reading the actual file) to gather relevant information. Then keep asking focused clarifying questions (1-5 at a time), IF the intent, inputs, constraints, output format, audience/tone, or success criteria are unclear, or if you cannot complete this request successfully (accurately, completely, and to the required standard).

- **Cite factual data:** If you cite a source, you must have fetched it this session and include the real URL. A source name without a same-session URL is a fabricated citation.

- **ExaSearch:** Any time you start a **new** general search and don't already know exactly what you want, **open with one** Exa Web Search call, then build on what it returns (refine with `WebSearch`). Use this only as a last resort, if regular `WebFetch` is failing you, try Exa Web Fetch.

- **How to properly address comments:** Comments left on anything, Google Docs, PRs, issues, review threads, or anything else must always always get properly addressed. Either act on it and reply naming what changed, or reply with the reasoning for declining. Then, if relevant, mark the thread resolved (like on GitHub), in the same pass.

- **Global knowledge never goes in per-project memory.** The moment you notice something that holds across all my projects â€” a workflow I repeat everywhere, a tool invocation pattern, a standing preference, a correction that isn't repo-specific â€” route it out of memory: a multi-step procedure with a trigger phrase becomes a **skill**; a short standing fact becomes a **line in `~/.claude/CLAUDE.md`**. Say which one you're doing and why, then do it.

- **"Clean up" never includes backups.** Anything named `backup` / `BEFORE-` / `.bak` is there on purpose, whether I made it or you did. Surface it in one line and let me decide; never delete one without an explicit per-file say-so.

- **Keep `.ps1` files pure ASCII.** PowerShell 5.1 parses BOM-less files as ANSI, so a UTF-8 em dash inside a *string literal* decodes into a smart quote that silently terminates the string.

- **Never hand a `/tmp` path to a Windows program.** Git-bash maps `/tmp` to `%LOCALAPPDATA%\Temp`; Windows `python` and `gh` read it as `C:	mp`. So `bash > /tmp/x.md` then `gh --body-file /tmp/x.md` silently reads the wrong (or an empty) file, which is one keystroke away from wiping a PR description. Write scratch files into the repo working tree and delete them, or pass the content inline.

- In this chat, we have a lot going on. For the rest of this session, use to-do list tools `TaskCreate`, `TaskUpdate`, `TaskList` to stay on top of everything and not forget something. **Religiously **update the `TaskList` to be the source of truth for everything that we have to do, are working on, and did. 
  
  ## Subagents

- Subagents are the same as employees, so make sure to treat them as such. Remember that when dealing with them, you must act like a leader:
  
  - Leadership without follow-through is abdication = giving direction isnâ€™t enough. A leader has to make sure the thing actually happens.
  - Management is the act of aligning peopleâ€™s actions, behaviors, and attitudes with the needs of the organization and making sure that little problems donâ€™t become big ones.

## Standard Of Work

- **Boil the Ocean:** The marginal cost of completeness is near zero with AI, so complete the whole thing, with tests and documentation. Do it well enough to genuinely impress Elliot. Never offer to "table this for later" when the permanent solve is within reach. Never leave a dangling thread when tying it off takes five more minutes. Never present a workaround when the real fix exists. Search before building. Test before shipping. Ship the complete thing. The standard is a finished, verified solution. When Elliot asks for something, the deliverable is the finished product, not a plan to build it. Time, fatigue, and complexity are not excuses.

- **Dig to the root, not the symptom.** When diagnosing or debugging, treat the first symptom as a starting point, not the answer. Keep asking "what's underneath this?" until the chain bottoms out. When there's nothing left to dig into, that's how you know you've hit the root. Don't get distracted by red herrings. Never pass off a symptom-level patch as a real fix. A stopgap is fine, but say it's a stopgap.

## Writing Style

- **No canned openers.** Never open with "Great question," "I'd be happy to help," "Absolutely," "Certainly," or any warm-up acknowledgment. Just answer.
- **Speak directly and plainly.** No metaphors or analogies.
- **State what things are.** Avoid contrastive framing such as "not just X, but Y", "it's not X, it's Y", or "not X, not Y, just Z". including the version stretched across several sentences for effect.
- **Describe things at their real size.** No hyperbole, no drama, no selling.
- **Write like a person texting a peer.** Keep the conversation casual and direct, not pitchy.
- **Let the rhythm be uneven.** Mix a short sentence with a longer one. Avoid tidy parallelism, balanced triplets, wordplay, and neat summary lines that tie a bow around the point.
- **Use specifics.** A real detail beats a polished abstraction. A small aside or hedge is fine when it is true -- "bit of a long shot," "promise i'm not here to pitch."
- **No filler or performance.** Cut generic enthusiasm, intensifiers, stacked adjectives, corporate throat-clearing, and templated parenthetical sign-offs. Do not restate one idea in new words.
- **Avoid AI punctuation habits.** No em dashes. Use commas, periods, parentheses, or other relevant punctuation.

## Chat Output Format

- **Section every reply.** Each distinct topic gets its own heading, with a horizontal rule between topics, so context-switching is cheap.

- **Always link.** Anything referenced that Elliot might open (PRs, issues, specific comments, files) carries its direct URL inline. 

- **One thing at a time during discussions or conversations.** When in a discussion about something, give Elliot exactly one thing to react to, respond to, or review per turn. Everything else that needs a decision, a reply, or a discussion goes into the task list so it doesn't get dropped. Work the queue one item per turn.

- **Every branch of a question has to be equally cheap to pick.** Never pose "tell me what you meant, or I'll skip it and move on," where one branch is open-ended homework and the other is just the default happening anyway. Saying yes to that buys Elliot nothing. Do the legwork first, then offer named candidates he can choose with one word, with an explicit skip as a real option. If you genuinely can't produce candidates, say what you already looked at and ask one narrow question rather than handing the search back.

- **Say what's running right now.** Any reply sent while a background agent, delegated CLI run, or monitor is live ends with a short "In flight" section naming each one: the task, the exact items it's handling, and what it should return. With focus mode on Elliot only sees the final message of a turn, so a background process he doesn't know about can't be planned around or interrupted. "A run is going" doesn't count, name it. Say so explicitly when nothing is running.

## Skill Routing

- **Skills:** If you think there is even a 1% chance a skill might apply, you ABSOLUTELY MUST invoke the skill. When the user's request matches an available skill, ALWAYS invoke it using the Skill tool as your FIRST action. Do NOT answer directly, do NOT use other tools first. The skill has specialized workflows that produce better results than ad-hoc answers.
- Starting substantive work in a project with a matching stack (currently JS/TS) â†’ use the `tech-preferences` skill
- Producing any document you'll keep, edit, or hand to someone â†’ use the `doc-preferences` skill


exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "rg -n -i \"Google-Tools-MCP|listFolderContents|issue #126|truncat\" 'C:\\Users\\2supe\\.codex\\memories\\MEMORY.md'" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
 succeeded in 286ms:
89:- The verified `google-dev` entry is local stdio: `node C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-dev/dist/index.js`. Codex may report OAuth `Unsupported` because the local server, not Codex, performs Google OAuth on its first tool call. [Task 1]
98:- Symptom: `EPERM` reading `C:\Users\2supe\.config\google-tools-mcp\.env` or Google access fails in sandbox. Cause: sandbox access boundary. Fix: use normal Windows context for live authorization/testing; never expose the `.env` contents. [Task 1]
225:applies_to: cwd=C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp; reuse_rule=recheck live GitHub state, `origin/main`, the registered PR worktree, dependency versions, and tests before treating this partial rollout or its counts as current.
231:- rollout_summaries/2026-08-16T12-56-28-6FMg-google_tools_mcp_sdk_v2_migration_orchestration_partial.md (cwd=C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp, rollout_path=C:\Users\2supe\.codex\sessions\2026\08\16\rollout-2026-08-16T08-56-28-01a00aa5-1dd7-79b3-be38-a556503df2d4.jsonl, updated_at=2026-08-17T00:05:29+00:00, thread_id=01a00aa5-1dd7-79b3-be38-a556503df2d4, live state revalidated; migration remains partial)
235:- google-tools-mcp, docs/plans/mcp-2026-07-28-migration.md, docs/plans/README.md, #71, #75, #87, #108, origin/main, fastmcp, @modelcontextprotocol/server, readTracker
241:- rollout_summaries/2026-08-16T12-56-28-6FMg-google_tools_mcp_sdk_v2_migration_orchestration_partial.md (cwd=C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp, rollout_path=C:\Users\2supe\.codex\sessions\2026\08\16\rollout-2026-08-16T08-56-28-01a00aa5-1dd7-79b3-be38-a556503df2d4.jsonl, updated_at=2026-08-17T00:05:29+00:00, thread_id=01a00aa5-1dd7-79b3-be38-a556503df2d4, two committed foundations; handle/facade changes uncommitted)
251:- rollout_summaries/2026-08-16T22-31-48-RJj2-assess_and_delete_redundant_temp_memory_files.md (cwd=C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp, rollout_path=C:\Users\2supe\.codex\sessions\2026\08\16\rollout-2026-08-16T18-31-48-01a00cb3-db5d-7be1-bf77-a0b893d8b818.jsonl, updated_at=2026-08-16T22:39:14+00:00, thread_id=01a00cb3-db5d-7be1-bf77-a0b893d8b818, canonical docs retained; two named untracked files deleted)
280:- Symptom: Git says `fatal: detected dubious ownership`. Fix: inspect with `git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp' ...`. [Task 3]
1604:applies_to: cwd=C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp; reuse_rule=recheck live tool registration and current documentation counts before applying count- or API-specific guidance.
1610:- rollout_summaries/2026-08-01T03-52-27-UnRA-google_tools_mcp_documentation_coverage_pr_103.md (cwd=C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp, rollout_path=C:\Users\2supe\.codex\sessions\2026\07\31\rollout-2026-07-31T23-52-27-019fbb73-a8b6-7e10-90b8-a7eb286f2766.jsonl, updated_at=2026-08-01T12:11:16+00:00, thread_id=019fbb73-a8b6-7e10-90b8-a7eb286f2766, runtime/documentation drift verified)
1614:- google-tools-mcp, README, package.json, 156 tools, Slides, Tasks, REQUIRED_APIS, tasks.googleapis.com, dist/tools/index.js, npm run local:tool -- list
1620:- rollout_summaries/2026-08-01T03-52-27-UnRA-google_tools_mcp_documentation_coverage_pr_103.md (cwd=C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp, rollout_path=C:\Users\2supe\.codex\sessions\2026\07\31\rollout-2026-07-31T23-52-27-019fbb73-a8b6-7e10-90b8-a7eb286f2766.jsonl, updated_at=2026-08-01T12:11:16+00:00, thread_id=019fbb73-a8b6-7e10-90b8-a7eb286f2766, draft PR #103 and full validation)
1645:applies_to: cwd=C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp; reuse_rule=recheck live GitHub state, current `main`, and tests before closing or consolidating issues.
1651:- rollout_summaries/2026-08-01T03-39-06-cLWJ-github_issue_triage_consolidation_google_tools_mcp.md (cwd=C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp, rollout_path=C:\Users\2supe\.codex\sessions\2026\07\31\rollout-2026-07-31T23-39-06-019fbb67-729e-7ed1-930a-24994dafb915.jsonl, updated_at=2026-08-01T04:04:12+00:00, thread_id=019fbb67-729e-7ed1-930a-24994dafb915, tests and live inventory verified)
1655:- google-tools-mcp, dist/, GitHub App, gh auth, safe.directory, npm.cmd ci, npm.cmd test, 33 suites, 561 passed
1661:- rollout_summaries/2026-08-01T03-39-06-cLWJ-github_issue_triage_consolidation_google_tools_mcp.md (cwd=C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp, rollout_path=C:\Users\2supe\.codex\sessions\2026\07\31\rollout-2026-07-31T23-39-06-019fbb67-729e-7ed1-930a-24994dafb915.jsonl, updated_at=2026-08-01T04:04:12+00:00, thread_id=019fbb67-729e-7ed1-930a-24994dafb915, 39 open issues consolidated to 17 canonical issues)
1671:- rollout_summaries/2026-08-01T03-39-06-cLWJ-github_issue_triage_consolidation_google_tools_mcp.md (cwd=C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp, rollout_path=C:\Users\2supe\.codex\sessions\2026\07\31\rollout-2026-07-31T23-39-06-019fbb67-729e-7ed1-930a-24994dafb915.jsonl, updated_at=2026-08-01T04:04:12+00:00, thread_id=019fbb67-729e-7ed1-930a-24994dafb915, open and mergeable; not merged)
1675:- PR #77, google-tools-mcp@2.0.0, scratch-install, timed startup pipe, CI passing, mergeable
1684:- Local inspection may need `git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp'`; use the connected GitHub App for live issue/PR operations when local `gh auth status` is invalid. [Task 1]
1707:- All Coding, Google-Tools-MCP, google-tools-mcp, karthikcsq/google-tools-mcp, gh repo clone, outer folder, exact GitHub repository name
1738:- Verified examples: `All Coding\Google-Tools-MCP\google-tools-mcp` for `karthikcsq/google-tools-mcp`, and `All Coding\buildpurdue-website\buildpurdue-website` for `karthikcsq/buildpurdue-website`. [Task 1][Task 3]

exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -Raw 'C:\\Users\\2supe\\.agents\\skills\\commit\\SKILL.md'; Get-Content -Raw 'C:\\Users\\2supe\\.agents\\skills\\tech-preferences\\SKILL.md'" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
 succeeded in 526ms:
---
name: commit
description: (commit) Invoke any time you're talking about or committing, pushing, or staging anything in git/GitHub. These are Elliot's preferences and best practices for how to handle it.
---

# Commit

## Arguments

Parse the invocation args (case-insensitive, order-independent). Scope args are mutually exclusive â€” if both are passed, `all` wins.

- **`chat`** â€” only commit files we touched in this chat session. This is the default!
- **`all`** â€” commit *every* uncommitted file in the working tree.
- **`review`** â€” show the commit plan and wait for user approval before running any `git commit`. Default is to commit immediately.
- **`asyougo`** (also `as-you-go`, or the user saying "as you go" / "commit as you go" in plain words, even mid-task without the slash command) â€” turn on **as-you-go mode** for the rest of the session: instead of one commit pass now, commit each group of work the moment it's complete. See the "As-you-go mode" section below.

Examples: `/commit`, `/commit chat`, `/commit all`, `/commit review`, `/commit all review`, `/commit chat review`, `/commit asyougo`, `/commit asyougo review`.

## Repo state (auto-run)

```!
echo "=== git status ==="
git status --short
echo ""
echo "=== unstaged diff (stat) ==="
git diff --stat
echo ""
echo "=== staged diff (stat) ==="
git diff --staged --stat
echo ""
echo "=== last 10 commits (style reference) ==="
git log -n 10 --pretty=format:"%h %s"
echo ""
echo "=== current branch ==="
git branch --show-current
```

## Workflow

1. **Read repo state above.** It's already fetched. Run `git diff <file>` (no `--stat`) on the specific files you plan to commit to read the actual line-level changes â€” you need those to write detailed message bodies. Note the repo's commit style from the log (prefixes like `feat:`/`fix:`, tone, length).

2. **Filter by scope:**
   - Default / `chat`: only include files *you* modified or created in this chat session. If a file shows up in `git status` but you didn't touch it here, leave it alone.
   - `all`: include every modified, staged, and untracked file in `git status`.

3. **Group files by purpose.** Files that work together = one commit. Unrelated changes = separate commits. Prefer specific commits over catch-alls.

4. **Draft a message per group that mirrors the repo's existing commits.** Read the full text of the last 10 commits (`git log -n 10 --pretty=fuller` or `git show <hash>` for any whose body you need) and match them on every dimension:
   - **Style:** prefix conventions (`feat:`, `fix(scope):`, none), capitalization, punctuation, imperative vs. past tense.
   - **Format:** subject length, blank line before body, bullet points vs. prose, line wrap width, trailers (e.g., `Co-Authored-By`, `Refs #123`).
   - **Level of detail:** if prior commits write three-paragraph bodies with rationale, do that. If they're one-line subjects, do that. Don't exceed or undershoot the established norm â€” match it.

   Each message tells the story of the change: subject, then body covering *what* changed, *how* it was implemented, and *why* (pull the why from this chat). When prior commits are terse, keep the *what* and trim the rest. When prior commits are detailed, go full depth.

   If there are no prior commits to mirror, default to Conventional Commits with a substantive body.

5. **Approval gate (only if `review` was passed):** Show the plan in this format and wait for explicit user approval:

   ```
   ### Group 1: <label>
   Files: file1, file2
   Message: <subject>

   <body>
   ```

   If `review` was not passed, skip this step and commit immediately â€” invoking the skill is the approval.

6. **Commit each group.** `git add <specific files>` (never `-A`/`.`), then `git commit` with a heredoc for multi-line messages. After all commits, run `git status` to confirm a clean tree and summarize what was committed.

7. **Do NOT push.** Pushing requires a direct, explicit user instruction in this session ("push it", "push to origin", etc.). The skill ends at local commits. Same rule for `git push --force`, opening PRs, or anything else that publishes the work â€” wait for the user to say so.

## As-you-go mode

A standing mode for the rest of the session, activated by `/commit asyougo` or by the user saying "as you go" / "commit as you go" / "commit as you work" in plain words â€” including mid-task, while you're in the middle of other work. When triggered mid-task, turn the mode on, handle the activation sweep, then return to the interrupted work.

**On activation:**
1. Acknowledge in one line that as-you-go mode is on.
2. Sweep what's already done: if work completed earlier this session forms one or more finished groups, commit them now using the normal workflow (steps 1â€“6). Leave anything half-finished uncommitted.

**Standing rule â€” for the rest of the session:** the moment a group of work becomes *commit-ready*, commit it immediately without being asked, then continue working. A group is commit-ready when ALL of these hold:

- The logical unit is finished â€” the feature works, the bug is fixed, the refactor is complete. Never commit a half-edited or broken intermediate state.
- It's verified to the standard the task allows (tests/build/lint run and passing, if the project has them and they apply).
- You have enough context to write the full message: what changed, how, and why.

**Granularity:** one commit per logical unit â€” not per file, not per edit, and not one catch-all at the end. If three edits serve one purpose, they're one group; wait until the purpose is fulfilled. This is the same grouping judgment as step 3, applied incrementally.

**Mode rules:**
- Scope is always `chat` â€” commit only files you touched this session. Never sweep in unrelated dirty files.
- If `review` was also passed (e.g. `/commit asyougo review`), show each group's plan (step 5 format) and wait for approval before each commit. Otherwise commit without pausing and mention each commit briefly in your next message to the user.
- Before declaring a task done, commit any remaining commit-ready work so none of your changes are left uncommitted.
- Deactivate when the user says so ("stop committing as you go", "stop as you go", "back to normal commits") â€” confirm and return to one-shot behavior. The mode also ends with the session; it never persists across sessions.
- Every other rule in this skill still applies in this mode: message style-matching (step 4), no `-A`/`.`, secrets check, hook-failure handling, and **never push**.

## Notes

- Nothing to commit (after scope filter) â†’ say so, stop.
- Files that look like secrets (`.env`, keys) â†’ stop and flag before including.
- Pre-commit hook fails â†’ fix the underlying issue and make a new commit. Never `--amend`, never `--no-verify`.

---
name: tech-preferences
description: >-
  Standing technical setup conventions to apply when starting substantive work in a
  project with a matching stack (currently JS/TS). Covers git hook setup (husky +
  lint-staged pre-commit/pre-push suite) and other standing preferences added over
  time. Use whenever starting non-trivial work in a JS/TS repo that doesn't already
  have this tooling, or when the user asks to set up hooks/tooling/conventions "the
  way I usually do it".
---

# Tech preferences

Standing conventions for how projects on this machine should be wired up, independent of
any single project's own CLAUDE.md. Add a new section here whenever a setup pattern gets
repeated across projects rather than re-deriving it each time.

## How to use this skill

This skill is not passive reference material â€” every time it's triggered, actively check
the current repo against each section below that applies to its stack.

1. **Decide relevance per section.** Skip any section whose stack doesn't match this repo
   (e.g. the pre-commit/pre-push section only applies to JS/TS projects). If nothing in this
   file is relevant to the repo, say nothing about tech-preferences at all â€” don't mention
   the skill or that it found nothing to do.
2. **For each relevant section, check compliance.** Look at what's actually in the repo
   (`package.json` scripts, `.husky/`, lockfiles, config files â€” whatever the section
   describes) rather than assuming it's already set up.
3. **If the repo is already compliant, stay silent** about that section â€” no "confirmed
   you're already following X" noise.
4. **If a relevant section isn't met, flag it and offer to fix it.** Name the specific gap,
   then ask whether to bring the repo up to date with that preference. Don't apply the
   change without asking first â€” surfacing the gap is mandatory, fixing it is the user's
   call.

## JS/TS: pre-commit / pre-push hooks

Every substantive JS/TS project should have husky + lint-staged wired up so bad commits
can't land and bad code can't reach `origin`. Reference implementations: `buildpurdue-website`
(the original pattern; also runs vitest and Supabase/edge-function checks in `prepush`) and
`elliotdrel-com` (typecheck + lint + build only â€” no test runner in that repo).

**Division of labor:**
- `pre-commit` â€” fast, staged-files-only formatting fix (lint-staged). Never run the full
  suite here; it should stay fast enough not to annoy a normal commit.
- `pre-push` â€” the full, slow verification suite: typecheck, lint, build, and test (if a
  test runner exists in the project). This is where nothing broken should slip through.

**Setup steps:**

1. `npm install -D husky lint-staged`
2. Add to `package.json` scripts:
   - `"prepare": "husky"` â€” regenerates the `.husky/_` shim on every `npm install`, so it
     never needs to be committed (husky drops its own nested `.gitignore` with `*` in
     `.husky/_`).
   - `"typecheck"` â€” `tsc --noEmit`, or the framework-appropriate variant (e.g. Next.js
     needs `next typegen && tsc --noEmit` so generated route types exist first).
   - `"precommit": "lint-staged"`
   - `"prepush": "npm run typecheck && npm run lint && npm run build"` â€” append
     `&& npm run test` if the project has a real test runner already configured. Don't
     invent a test script/framework just to fill this slot.
3. Add a `lint-staged` config block targeting the project's actual formatter (Biome, or
   Prettier + ESLint `--fix`, whatever the repo already uses) against staged
   `*.{js,jsx,mjs,cjs,ts,tsx,json,jsonc,css}`.
4. Run `npx husky` once to generate `.husky/_`.
5. Write `.husky/pre-commit` and `.husky/pre-push` by hand (husky v9 style â€” no
   `husky.sh` sourcing needed):
   ```sh
   #!/usr/bin/env sh
   npm run precommit
   ```
   ```sh
   #!/usr/bin/env sh
   npm run prepush
   ```
   `chmod +x` both.
6. Confirm `git config core.hooksPath` reads `.husky/_` (set automatically by step 4).
7. Verify before trusting it: run `precommit`/`prepush` manually first, and if you want to
   confirm the hook actually fires end-to-end, test through a disposable scratch
   branch/commit rather than the user's real work â€” then delete the branch and restore
   any stashed state immediately after.

**Gotcha:** the `prepush` build step must not require network access (e.g. a `prebuild`
script that clones a remote repo). Check any pre-build/codegen scripts for external calls
before including `build` in the chain â€” a hook that fails on flaky network is worse than
no hook.

**Gotcha:** if the repo isn't already ignoring `.claude/settings.local.json`, decide once
per machine (not per project) whether it's tracked or gitignored â€” don't let it get
force-formatted and committed by accident just because a linter matched it.


exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' status --short; git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' diff --stat; git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' diff --staged --stat; git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' log -n 10 --pretty=format:'%h %s'; git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' branch --show-current" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Get-Content -Raw package.json; if (Test-Path .husky) { Get-ChildItem -Force .husky | Select-Object Name,Mode; Get-ChildItem -Force .husky -File | ForEach-Object { "--- $($_.Name) ---"; Get-Content -Raw $_.FullName } }; git config --get core.hooksPath' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
 succeeded in 0ms:
warning: unable to access 'C:\Users\2supe/.config/git/ignore': Permission denied
warning: unable to access 'C:\Users\2supe/.config/git/ignore': Permission denied
warning: unable to access 'C:\Users\2supe/.config/git/ignore': Permission denied
4f76e3f Request re-consent unconditionally and cover the refresh-token contract
61512c9 Regenerate MCP migration inventory snapshot
b2a82c9 Distinguish partial from total initial-content failure in createDocument (review finding 3)
5e3ee6f Add regression tests for review findings 1, 2, and 4
473b60d Classify 403 reasons, scope shared-drive corpora, and stop pagination once maxItems is met (review findings 1, 2, 4)
2e75a22 Accept "name" for copyFile and reject unknown parameters (issue #124)
aa8bf49 Fail loudly instead of reporting fake success on a re-auth that got no refresh token (issue #115)
5e91562 Return pages already fetched when the API budget runs out
b2e09e4 Close test and package blind spots (#56)
cc34e96 List folders recursively with explicit bounds (#99)feat/independents

 exited 1 in 76ms:
{
  "name": "google-tools-mcp",
  "version": "2.0.0",
  "description": "The easiest MCP server for Google Workspace â€” Drive, Docs, Sheets, Gmail, Calendar, Forms, Slides, and Tasks. 156 tools with one-click browser auth. Read Word docs, PDFs, and spreadsheets straight from Drive.",
  "type": "module",
  "bin": {
    "google-tools-mcp": "dist/index.js"
  },
  "files": [
    "dist",
    "!dist/**/*.test.js"
  ],
  "keywords": [
    "mcp",
    "mcp-server",
    "model-context-protocol",
    "google",
    "google-workspace",
    "google-drive",
    "google-docs",
    "google-sheets",
    "google-calendar",
    "google-forms",
    "gdrive",
    "gmail",
    "email",
    "send-email",
    "read-email",
    "email-drafts",
    "email-labels",
    "email-filters",
    "sheets",
    "spreadsheet",
    "docs",
    "calendar",
    "forms",
    "drive",
    "pdf",
    "read-pdf",
    "word",
    "docx",
    "read-docx",
    "file-reader",
    "oauth",
    "easy-auth",
    "browser-auth",
    "claude",
    "ai",
    "llm",
    "ai-tools"
  ],
  "scripts": {
    "local:tool": "node scripts/call-local-tool.js",
    "start": "node dist/index.js",
    "test": "node --experimental-vm-modules node_modules/jest/bin/jest.js",
    "test:ci": "node --experimental-vm-modules node_modules/jest/bin/jest.js --ci --coverage"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/karthikcsq/google-tools-mcp.git"
  },
  "homepage": "https://github.com/karthikcsq/google-tools-mcp#readme",
  "bugs": {
    "url": "https://github.com/karthikcsq/google-tools-mcp/issues"
  },
  "license": "MIT",
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "@modelcontextprotocol/node": "2.0.0",
    "@modelcontextprotocol/server": "2.0.0",
    "@clack/prompts": "^1.2.0",
    "chalk": "^5.6.2",
    "diff": "^7.0.0",
    "google-auth-library": "^10.5.0",
    "googleapis": "^171.4.0",
    "hono": "^4.11.4",
    "mammoth": "^1.9.0",
    "markdown-it": "^14.1.0",
    "pdf-parse": "^1.1.1",
    "zod": "^4.2.0"
  },
  "devDependencies": {
    "@jest/globals": "^30.3.0",
    "jest": "^30.3.0"
  }
}


exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "rg -n -C 8 \"depth === 1|legacy \\{folders, files\\}|listFolderContents\" dist/tools/drive/listFolderContents.js; rg -n -l \"listFolderContents\" tests" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
 succeeded in 135ms:
39-]);
40-
41-function isRateLimitStatus(error) {
42-    return getStatus(error) === 403 && RATE_LIMIT_REASONS.has(getErrorReason(error));
43-}
44-
45-export function register(server) {
46-    server.addTool({
47:        name: 'listFolderContents',
48:        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns the legacy {folders, files} result. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the legacy depth-1 response. Use getFilePath for the inverse, upward path lookup.",
49-        parameters: z.object({
50-            folderId: z.string().describe('ID of the folder to list contents of. Use "root" for the root Drive folder.'),
51-            includeSubfolders: z.boolean().optional().default(true).describe('Whether to include subfolders in results.'),
52-            includeFiles: z.boolean().optional().default(true).describe('Whether to include files in results.'),
53-            maxResults: z.number().int().min(1).max(100).optional().default(50).describe('Maximum number of items to return at depth 1. Ignored for recursive traversal.'),
54-            depth: z.union([z.number().int().min(1).max(10), z.literal('all')]).optional().default(1).describe("How many levels to list: 1 (default) through 10, or 'all'."),
55-            maxItems: z.number().int().min(1).max(5000).optional().describe('Hard cap across a recursive traversal. Defaults to 500; only valid when depth is greater than 1.'),
56-        }).superRefine((args, context) => {
57-            if (!args.includeSubfolders && !args.includeFiles) context.addIssue({ code: 'custom', message: 'At least one of includeSubfolders or includeFiles must be true.' });
58:            if (args.maxItems !== undefined && args.depth === 1) context.addIssue({ code: 'custom', message: 'maxItems is only valid when depth is greater than 1.' });
59-            if (!args.includeSubfolders && args.depth !== 1) context.addIssue({ code: 'custom', message: 'includeSubfolders must be true when depth is greater than 1.' });
60-        }),
61-        execute: async (args, { log }) => {
62-            const drive = await getDriveClient();
63-            log.info(`Listing contents of folder: ${args.folderId}`);
64-            try {
65-                const depth = args.depth ?? 1;
66-                const includeSubfolders = args.includeSubfolders ?? true;
67-                const includeFiles = args.includeFiles ?? true;
68-                const maxResults = args.maxResults ?? 50;
69-                // Keep the legacy depth-1 request and response shape intact.
70:                if (depth === 1) {
71-                    let queryString = `'${escapeDriveQueryValue(args.folderId)}' in parents and trashed=false`;
72-                    if (!includeSubfolders) queryString += ` and mimeType!='${FOLDER_MIME_TYPE}'`;
73-                    else if (!includeFiles) queryString += ` and mimeType='${FOLDER_MIME_TYPE}'`;
74-                    const response = await drive.files.list({
75-                        q: queryString, pageSize: maxResults, orderBy: 'folder,name',
76-                        fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
77-                        supportsAllDrives: true, includeItemsFromAllDrives: true,
78-                    });
tests\fixtures\mcp-migration-inventory.json
tests\listFolderContents.test.js
tests\toolRegistration.test.js

exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'rg -n "register.*tool|tools.*length|160" dist tests package.json | Select-Object -First 40' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
 exited 1 in 176ms:
tests\docsHandleLeaseFailure.test.js:84:const { register: registerReadDocument } = await import('../dist/tools/docs/readGoogleDoc.js');
tests\docsHandleLeaseFailure.test.js:85:const { register: registerAppendText } = await import('../dist/tools/docs/appendToGoogleDoc.js');
tests\createDocument.test.js:18:const { register } = await import('../dist/tools/drive/createDocument.js');
tests\createDocument.test.js:22:    register({ addTool(definition) { tool = definition; } });
tests\copyFile.test.js:14:const { register } = await import('../dist/tools/drive/copyFile.js');
tests\copyFile.test.js:18:    register({ addTool(definition) { tool = definition; } });
tests\extraDocsToolsWriteControl.test.js:25:const { register: registerInsertPageBreak } = await import('../dist/tools/docs/insertPageBreak.js');
tests\extraDocsToolsWriteControl.test.js:26:const { register: registerApplyParagraphStyle } = await import('../dist/tools/docs/formatting/applyParagraphStyle.js');
tests\extraDocsToolsWriteControl.test.js:27:const { register: registerInsertTableWithData } = await import('../dist/tools/docs/insertTableWithData.js');
tests\extraDocsToolsWriteControl.test.js:28:const { register: registerInsertTable } = await import('../dist/tools/docs/insertTable.js');
tests\extraDocsToolsWriteControl.test.js:29:const { register: registerAddTab } = await import('../dist/tools/docs/addTab.js');
tests\extraDocsToolsWriteControl.test.js:30:const { register: registerRenameTab } = await import('../dist/tools/docs/renameTab.js');
tests\extraDocsToolsWriteControl.test.js:31:const { register: registerInsertImage } = await import('../dist/tools/docs/insertImage.js');
tests\documentationConsistency.test.js:5:import { registerAllTools } from '../dist/tools/index.js';
tests\gmailThreads.test.js:19:        const { register } = await import('../dist/tools/gmail/threads.js');
tests\gmailThreads.test.js:20:        register({ addTool: tool => tools.set(tool.name, tool) });
tests\gmailThreads.test.js:222:        // but 5 of them combined (~16000 chars) is not — this must be caught at
tests\gmailConsolidation.test.js:43:    ({ register: registerSettings } = await import('../dist/tools/gmail/settings.js'));
tests\gmailConsolidation.test.js:44:    ({ register: registerLabels } = await import('../dist/tools/gmail/labels.js'));
tests\gmailConsolidation.test.js:82:    it('no longer registers the old granular settings tools directly', () => {
tests\drivePermissions.test.js:8:const { register: registerList } = await import('../dist/tools/drive/listPermissions.js');
tests\drivePermissions.test.js:9:const { register: registerAdd } = await import('../dist/tools/drive/addPermission.js');
tests\drivePermissions.test.js:10:const { register: registerUpdate } = await import('../dist/tools/drive/updatePermission.js');
tests\drivePermissions.test.js:11:const { register: registerRemove } = await import('../dist/tools/drive/removePermission.js');
tests\drivePermissions.test.js:15:    register({ addTool(definition) { tool = definition; } });
tests\appendMarkdownRevisionRefresh.test.js:28:const { register } = await import('../dist/tools/utils/appendMarkdownToGoogleDoc.js');
dist\mcpServer.js:8:import { registerAllTools } from './tools/index.js';
tests\legacyAliasAuthRetry.test.js:72:    ({ registerAllTools } = await import('../dist/tools/index.js'));
tests\listFolderContents.test.js:8:const { register } = await import('../dist/tools/drive/listFolderContents.js');
tests\listFolderContents.test.js:12:    register({ addTool(definition) { tool = definition; } });
tests\maps.test.js:16:    const { registerMapsTools } = await import('../dist/tools/maps/index.js');
tests\markdownToolSuccessMessages.test.js:37:const { register: registerAppend } = await import('../dist/tools/utils/appendMarkdownToGoogleDoc.js');
tests\markdownToolSuccessMessages.test.js:38:const { register: registerReplace } = await import('../dist/tools/utils/replaceDocumentWithMarkdown.js');
tests\mcpSdkV2Compatibility.test.js:5:import { registerAllTools } from '../dist/tools/index.js';
tests\mcpServerFacade.test.js:6:import { registerAllTools } from '../dist/tools/index.js';
tests\mcpServerFacade.test.js:74:    it('registers the current 156-tool catalog through the production facade', async () => {
tests\mutatingDocsToolsWriteControl.test.js:25:const { register: registerAppendText } = await import('../dist/tools/docs/appendToGoogleDoc.js');
tests\mutatingDocsToolsWriteControl.test.js:26:const { register: registerDeleteRange } = await import('../dist/tools/docs/deleteRange.js');
tests\mutatingDocsToolsWriteControl.test.js:27:const { register: registerFindAndReplace } = await import('../dist/tools/docs/findAndReplace.js');
tests\publicErrorBoundary.test.js:48:const { register: registerGetPresentation } = await import('../dist/tools/slides/getPresentation.js');

codex
The worktree is clean and on `feat/independents`; the change is contained to the requested runtime source, its Drive tests, and the generated inventory snapshot. I’m leaving the repository’s missing Husky/lint-staged setup untouched because it is unrelated to this scoped bug fix.
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'rg -n -C 3 "160|156|tool catalog|registered" dist/tools tests/fixtures/mcp-migration-inventory.json tests/toolRegistration.test.js tests/mcpServerFacade.test.js' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
 succeeded in 145ms:
tests/mcpServerFacade.test.js-71-}
tests/mcpServerFacade.test.js-72-
tests/mcpServerFacade.test.js-73-describe('official SDK v2 facade', () => {
tests/mcpServerFacade.test.js:74:    it('registers the current 156-tool catalog through the production facade', async () => {
tests/mcpServerFacade.test.js-75-        const factory = await prepareMcpServerFactory({ registerTools: registerAllTools });
tests/mcpServerFacade.test.js-76-        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
tests/mcpServerFacade.test.js-77-        try {
tests/mcpServerFacade.test.js-78-            const list = await (await handler.fetch(modern('tools/list'))).json();
tests/mcpServerFacade.test.js:79:            expect(list.result.tools).toHaveLength(156);
tests/mcpServerFacade.test.js:80:            expect(new Set(list.result.tools.map((tool) => tool.name)).size).toBe(156);
tests/mcpServerFacade.test.js-81-        } finally { await handler.close(); }
tests/mcpServerFacade.test.js-82-    });
tests/mcpServerFacade.test.js-83-
--
tests/mcpServerFacade.test.js-630-        expect(stderr).toContain('closed-before-exit');
tests/mcpServerFacade.test.js-631-    });
tests/mcpServerFacade.test.js-632-
tests/mcpServerFacade.test.js:633:    it('cleans up the handler and registered bearer if HTTP binding fails', async () => {
tests/mcpServerFacade.test.js-634-        const occupied = http.createServer();
tests/mcpServerFacade.test.js-635-        await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
tests/mcpServerFacade.test.js-636-        const port = occupied.address().port;
--
tests/toolRegistration.test.js-124-        });
tests/toolRegistration.test.js-125-
tests/toolRegistration.test.js-126-        it('registers multiple sheets tools', () => {
tests/toolRegistration.test.js:127:            // Just verify a reasonable number of tools are registered
tests/toolRegistration.test.js-128-            expect(tools.size).toBeGreaterThanOrEqual(20);
tests/toolRegistration.test.js-129-        });
tests/toolRegistration.test.js-130-
--
tests/toolRegistration.test.js-301-    // (help/logout/troubleshoot/feedback) that the real server also registers.
tests/toolRegistration.test.js-302-    // Pin the exact counts through the real `registerAllTools` production path
tests/toolRegistration.test.js-303-    // too, so the number a client actually sees by default is covered, not just
tests/toolRegistration.test.js:304:    // the test-helper subset. 156 = 150 pre-Maps + the 6 `maps` tools; 228 = 222
tests/toolRegistration.test.js-305-    // pre-Maps (with aliases) + the same 6 (maps tools have no aliases).
tests/toolRegistration.test.js:306:    it('registerAllTools (real production path) registers exactly 156 tools by default (aliases opt-in, unset)', async () => {
tests/toolRegistration.test.js-307-        const server = createMockServer();
tests/toolRegistration.test.js-308-        const { registerAllTools } = await import('../dist/tools/index.js');
tests/toolRegistration.test.js-309-        await registerAllTools(server);
tests/toolRegistration.test.js:310:        expect(server.getTools().size).toBe(156);
tests/toolRegistration.test.js-311-    });
tests/toolRegistration.test.js-312-
tests/toolRegistration.test.js-313-    it('registerAllTools (real production path) registers exactly 228 tools with legacy aliases explicitly enabled', async () => {
--
tests/fixtures/mcp-migration-inventory.json-1830-    ],
tests/fixtures/mcp-migration-inventory.json-1831-    "userErrorImports": [],
tests/fixtures/mcp-migration-inventory.json-1832-    "contextLogCallSites": [],
tests/fixtures/mcp-migration-inventory.json:1833:    "loadedDefaultToolCount": 156
tests/fixtures/mcp-migration-inventory.json-1834-  }
tests/fixtures/mcp-migration-inventory.json-1835-}
--
dist/tools\legacyAliases.js-380-};
dist/tools\legacyAliases.js-381-
dist/tools\legacyAliases.js-382-// ---------------------------------------------------------------------------
dist/tools\legacyAliases.js:383:// Register all legacy aliases on `server`. `registeredTools` is a Map of
dist/tools\legacyAliases.js:384:// name -> toolDef for the already-registered new tools (used to look up the
dist/tools\legacyAliases.js-385-// target's execute/parameters). No-op if aliases are disabled via env var.
dist/tools\legacyAliases.js-386-// ---------------------------------------------------------------------------
dist/tools\legacyAliases.js:387:export function registerLegacyAliases(server, registeredTools) {
dist/tools\legacyAliases.js-388-    if (!legacyAliasesEnabled()) {
dist/tools\legacyAliases.js-389-        logger.info(`Legacy snake_case tool aliases are opt-in — set ${ENABLE_LEGACY_ALIASES_ENV}=true to register them.`);
dist/tools\legacyAliases.js-390-        return 0;
--
dist/tools\legacyAliases.js-392-    let count = 0;
dist/tools\legacyAliases.js-393-
dist/tools\legacyAliases.js-394-    for (const [alias, targetName] of Object.entries(PURE_RENAMES)) {
dist/tools\legacyAliases.js:395:        const target = registeredTools.get(targetName);
dist/tools\legacyAliases.js-396-        if (!target) {
dist/tools\legacyAliases.js:397:            logger.warn(`Legacy alias "${alias}" skipped: target "${targetName}" not registered.`);
dist/tools\legacyAliases.js-398-            continue;
dist/tools\legacyAliases.js-399-        }
dist/tools\legacyAliases.js-400-        server.addTool({
--
dist/tools\legacyAliases.js-407-    }
dist/tools\legacyAliases.js-408-
dist/tools\legacyAliases.js-409-    for (const [alias, spec] of Object.entries(CONSOLIDATED_ALIASES)) {
dist/tools\legacyAliases.js:410:        const target = registeredTools.get(spec.target);
dist/tools\legacyAliases.js-411-        if (!target) {
dist/tools\legacyAliases.js:412:            logger.warn(`Legacy alias "${alias}" skipped: target "${spec.target}" not registered.`);
dist/tools\legacyAliases.js-413-            continue;
dist/tools\legacyAliases.js-414-        }
dist/tools\legacyAliases.js-415-        server.addTool({
--
dist/tools\index.js-209-    // Wrap server so every tool auto-retries on invalid_grant (expired refresh token)
dist/tools\index.js-210-    const wrappedServer = wrapServerWithAuthRetry(server);
dist/tools\index.js-211-
dist/tools\index.js:212:    // Capture each registered tool so the legacy alias layer can look up the
dist/tools\index.js-213-    // new tools' implementations to forward to. We snapshot a shallow copy of
dist/tools\index.js-214-    // toolDef *before* handing it to wrappedAddTool: wrapServerWithAuthRetry
dist/tools\index.js-215-    // mutates toolDef.execute in place to add the auth-retry wrapper, and since
dist/tools\index.js:216:    // registeredTools would otherwise hold a reference to that same (mutated)
dist/tools\index.js-217-    // object, aliases would forward to an already-retry-wrapped execute. Then,
dist/tools\index.js:218:    // because each alias is itself registered through this same addTool (which
dist/tools\index.js-219-    // gets retry-wrapped again), a persistent invalid_grant would invoke the
dist/tools\index.js-220-    // real handler up to 4x and reauthorize repeatedly instead of the
dist/tools\index.js-221-    // documented single retry. The snapshot keeps the map pointing at the raw,
dist/tools\index.js-222-    // unwrapped implementation so the outer (alias-level) wrapper is the only
dist/tools\index.js-223-    // retry layer applied.
dist/tools\index.js:224:    const registeredTools = new Map();
dist/tools\index.js-225-    const wrappedAddTool = wrappedServer.addTool.bind(wrappedServer);
dist/tools\index.js-226-    wrappedServer.addTool = function (toolDef) {
dist/tools\index.js:227:        registeredTools.set(toolDef.name, { ...toolDef });
dist/tools\index.js-228-        return wrappedAddTool(toolDef);
dist/tools\index.js-229-    };
dist/tools\index.js-230-
--
dist/tools\index.js-236-
dist/tools\index.js-237-    // Register backward-compatible snake_case aliases for the renamed/consolidated
dist/tools\index.js-238-    // tools. Opt-in: set GOOGLE_MCP_ENABLE_LEGACY_ALIASES=true to register them.
dist/tools\index.js:239:    registerLegacyAliases(wrappedServer, registeredTools);
dist/tools\index.js-240-
dist/tools\index.js-241-    // --- Help tool (always available) ---
dist/tools\index.js-242-    server.addTool({

exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -Raw 'dist/tools/drive/listFolderContents.js'; Get-Content -Raw 'tests/listFolderContents.test.js'" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
 succeeded in 185ms:
import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME_TYPE = 'application/vnd.google-apps.shortcut';
const PARENT_CHUNK_SIZE = 50;
const RECURSIVE_PAGE_SIZE = 100;
const API_CALL_BUDGET = 50;

function escapeDriveQueryValue(value) {
    return value.replace(/'/g, "\\'");
}

function getStatus(error) {
    return Number.isInteger(error?.code) ? error.code : undefined;
}

// Drive's structured error payload carries a `reason` per sub-error that is
// far more specific than the bare HTTP status. googleapis clients attach it
// either directly on the thrown error (`error.errors`) or nested under the
// gaxios response shape (`error.response.data.error.errors`) depending on
// version/transport, so both are checked.
function getErrorReason(error) {
    const reason = error?.errors?.[0]?.reason ?? error?.response?.data?.error?.errors?.[0]?.reason;
    return typeof reason === 'string' ? reason : undefined;
}

// A 403 with one of these reasons is Drive asking the caller to back off, not
// telling it a folder is inaccessible â€” Google documents these as quota/rate
// conditions to retry with backoff, not permission failures to isolate:
// https://developers.google.com/workspace/drive/api/guides/limits
const RATE_LIMIT_REASONS = new Set([
    'rateLimitExceeded',
    'userRateLimitExceeded',
    'quotaExceeded',
    'dailyLimitExceeded',
    'sharingRateLimitExceeded',
]);

function isRateLimitStatus(error) {
    return getStatus(error) === 403 && RATE_LIMIT_REASONS.has(getErrorReason(error));
}

export function register(server) {
    server.addTool({
        name: 'listFolderContents',
        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns the legacy {folders, files} result. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the legacy depth-1 response. Use getFilePath for the inverse, upward path lookup.",
        parameters: z.object({
            folderId: z.string().describe('ID of the folder to list contents of. Use "root" for the root Drive folder.'),
            includeSubfolders: z.boolean().optional().default(true).describe('Whether to include subfolders in results.'),
            includeFiles: z.boolean().optional().default(true).describe('Whether to include files in results.'),
            maxResults: z.number().int().min(1).max(100).optional().default(50).describe('Maximum number of items to return at depth 1. Ignored for recursive traversal.'),
            depth: z.union([z.number().int().min(1).max(10), z.literal('all')]).optional().default(1).describe("How many levels to list: 1 (default) through 10, or 'all'."),
            maxItems: z.number().int().min(1).max(5000).optional().describe('Hard cap across a recursive traversal. Defaults to 500; only valid when depth is greater than 1.'),
        }).superRefine((args, context) => {
            if (!args.includeSubfolders && !args.includeFiles) context.addIssue({ code: 'custom', message: 'At least one of includeSubfolders or includeFiles must be true.' });
            if (args.maxItems !== undefined && args.depth === 1) context.addIssue({ code: 'custom', message: 'maxItems is only valid when depth is greater than 1.' });
            if (!args.includeSubfolders && args.depth !== 1) context.addIssue({ code: 'custom', message: 'includeSubfolders must be true when depth is greater than 1.' });
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Listing contents of folder: ${args.folderId}`);
            try {
                const depth = args.depth ?? 1;
                const includeSubfolders = args.includeSubfolders ?? true;
                const includeFiles = args.includeFiles ?? true;
                const maxResults = args.maxResults ?? 50;
                // Keep the legacy depth-1 request and response shape intact.
                if (depth === 1) {
                    let queryString = `'${escapeDriveQueryValue(args.folderId)}' in parents and trashed=false`;
                    if (!includeSubfolders) queryString += ` and mimeType!='${FOLDER_MIME_TYPE}'`;
                    else if (!includeFiles) queryString += ` and mimeType='${FOLDER_MIME_TYPE}'`;
                    const response = await drive.files.list({
                        q: queryString, pageSize: maxResults, orderBy: 'folder,name',
                        fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
                        supportsAllDrives: true, includeItemsFromAllDrives: true,
                    });
                    const items = response.data.files || [];
                    const folders = items.filter((f) => f.mimeType === FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
                    const files = items.filter((f) => f.mimeType !== FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime }));
                    return JSON.stringify({ folders, files }, null, 2);
                }

                const maxItems = args.maxItems ?? 500;
                let apiCalls = 0;
                const countApiCall = () => {
                    if (apiCalls >= API_CALL_BUDGET) throw new Error('API_CALL_BUDGET_EXHAUSTED');
                    apiCalls += 1;
                };
                let startFolder;
                try {
                    countApiCall();
                    const response = await drive.files.get({ fileId: args.folderId, fields: 'id,name,driveId', supportsAllDrives: true });
                    startFolder = response.data;
                }
                catch (error) {
                    if (error?.message === 'API_CALL_BUDGET_EXHAUSTED') throw error;
                    if (getStatus(error) === 404) throw publicError('Folder not found. Check the folder ID.');
                    if (isRateLimitStatus(error)) throw publicError('Google Drive rate limit or quota exceeded while accessing this folder. Wait and retry with backoff (see https://developers.google.com/workspace/drive/api/guides/limits).');
                    if (getStatus(error) === 403) throw publicError('Permission denied. Make sure you have access to this folder.');
                    throw wrapOperationError('get folder details', error, { status: getStatus(error) });
                }
                // For a shared-drive root, scope every recursive files.list call to
                // that drive. Without this, files.list defaults to corpora='user'
                // (files the caller has personally accessed) even with
                // includeItemsFromAllDrives:true, so descendants the caller has
                // access to via the shared drive but never individually opened are
                // silently omitted from a traversal that reports truncated: false â€”
                // see https://developers.google.com/workspace/drive/api/guides/enable-shareddrives#search_for_content_on_a_shared_drive
                const sharedDriveId = startFolder.driveId || undefined;

                const entries = [];
                const entriesById = new Map();
                const visitedFolders = new Set([startFolder.id]);
                const unreadable = [];
                let currentLevel = [{ id: startFolder.id, path: startFolder.name, depth: 0 }];
                let truncated = false;
                let truncationReason;
                const addEntry = (file, parentNodes) => {
                    if (!file.id || entriesById.has(file.id)) {
                        const existing = entriesById.get(file.id);
                        if (existing) for (const parentId of file.parents || []) if (!existing.parentIds.includes(parentId)) existing.parentIds.push(parentId);
                        return { entry: existing, added: false };
                    }
                    if (entries.length >= maxItems) return { entry: null, added: false };
                    const parentId = (file.parents || []).find((id) => parentNodes.some((parent) => parent.id === id)) || parentNodes[0]?.id;
                    const parent = parentNodes.find((node) => node.id === parentId) || parentNodes[0];
                    const entry = { id: file.id, name: file.name, mimeType: file.mimeType, path: `${parent.path}/${file.name}`, parentIds: [...new Set(file.parents || [parent.id])], modifiedTime: file.modifiedTime };
                    if (file.mimeType !== FOLDER_MIME_TYPE && file.size !== undefined) entry.size = file.size;
                    if (file.mimeType === SHORTCUT_MIME_TYPE && file.shortcutDetails?.targetId) entry.shortcutDetails = { targetId: file.shortcutDetails.targetId };
                    entries.push(entry);
                    entriesById.set(entry.id, entry);
                    return { entry, added: true };
                };
                // Pages are handed to `onPage` as soon as each arrives (instead of
                // being buffered for the whole chunk before anything downstream
                // sees them) so that a maxItems cap already satisfied by an
                // earlier page can stop pagination before the next page is
                // requested â€” a 1-item request must not still page through
                // thousands of children first (PR #113 review finding 2).
                const listParentChunk = async (parentNodes, onPage) => {
                    const query = `(${parentNodes.map((parent) => `'${escapeDriveQueryValue(parent.id)}' in parents`).join(' or ')}) and trashed=false`;
                    let pageToken;
                    let budgetExhausted = false;
                    let stopped = false;
                    do {
                        try {
                            countApiCall();
                        }
                        catch (error) {
                            if (error?.message !== 'API_CALL_BUDGET_EXHAUSTED') throw error;
                            budgetExhausted = true;
                            break;
                        }
                        const response = await drive.files.list({
                            q: query, pageSize: RECURSIVE_PAGE_SIZE, pageToken, orderBy: 'folder,name',
                            fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,shortcutDetails)',
                            supportsAllDrives: true, includeItemsFromAllDrives: true,
                            ...(sharedDriveId ? { corpora: 'drive', driveId: sharedDriveId } : {}),
                        });
                        pageToken = response.data.nextPageToken || undefined;
                        stopped = onPage(response.data.files || []) === true;
                    } while (pageToken && !stopped);
                    return { budgetExhausted, stopped };
                };
                const listWithIsolation = async (parentNodes, onPage) => {
                    try { return await listParentChunk(parentNodes, onPage); }
                    catch (error) {
                        // Drive uses 403 for both "you can't read this folder" and
                        // "you're over quota/rate limit right now" â€” the latter is
                        // Google explicitly documenting exponential backoff, not a
                        // per-folder access problem, so it must never be fabricated
                        // into an `unreadable` entry or trigger isolation bisection
                        // (which would only spend more calls while the service is
                        // asking the client to back off) (finding 1).
                        if (isRateLimitStatus(error)) throw error;
                        if (getStatus(error) !== 403 && getStatus(error) !== 404) throw error;
                        if (parentNodes.length === 1) {
                            const parent = parentNodes[0];
                            unreadable.push({ id: parent.id, path: parent.path, reason: getStatus(error) === 404 ? 'Folder not found or no longer available.' : 'Permission denied or folder unavailable.' });
                            return { budgetExhausted: false, stopped: false };
                        }
                        const midpoint = Math.ceil(parentNodes.length / 2);
                        const first = await listWithIsolation(parentNodes.slice(0, midpoint), onPage);
                        if (first.budgetExhausted || first.stopped) return first;
                        const second = await listWithIsolation(parentNodes.slice(midpoint), onPage);
                        return { budgetExhausted: second.budgetExhausted, stopped: second.stopped };
                    }
                };

                const maxDepth = depth === 'all' ? Infinity : depth;
                while (currentLevel.length > 0 && currentLevel[0].depth < maxDepth && !truncated) {
                    const nextLevel = [];
                    const onPage = (files) => {
                        for (const file of files) {
                            if (file.mimeType !== FOLDER_MIME_TYPE && !includeFiles) continue;
                            const result = addEntry(file, currentLevel);
                            if (!result.entry && entries.length >= maxItems) {
                                truncated = true;
                                truncationReason = `maxItems (${maxItems}) reached at depth ${currentLevel[0].depth + 1}; ${nextLevel.length} discovered folders not expanded`;
                                return true;
                            }
                            if (file.mimeType === FOLDER_MIME_TYPE && result.added && visitedFolders.add(file.id)) nextLevel.push({ id: file.id, path: result.entry.path, depth: currentLevel[0].depth + 1 });
                        }
                        return false;
                    };
                    for (let index = 0; index < currentLevel.length && !truncated; index += PARENT_CHUNK_SIZE) {
                        let chunkResult;
                        try { chunkResult = await listWithIsolation(currentLevel.slice(index, index + PARENT_CHUNK_SIZE), onPage); }
                        catch (error) { throw error; }
                        if (!truncated && chunkResult.budgetExhausted) {
                            truncated = true;
                            truncationReason = `API call budget (${API_CALL_BUDGET}) exhausted`;
                        }
                    }
                    currentLevel = nextLevel;
                }
                if (!truncated && maxDepth !== Infinity && currentLevel.length > 0 && currentLevel[0].depth === maxDepth) {
                    truncated = true;
                    truncationReason = `depth (${maxDepth}) reached; ${currentLevel.length} discovered folders not expanded`;
                }
                return JSON.stringify({ entries, count: entries.length, truncated, ...(truncationReason ? { truncationReason } : {}), unreadable, apiCalls }, null, 2);
            }
            catch (error) {
                if (isPublicError(error)) throw error;
                log.error('Error listing folder contents.');
                if (getStatus(error) === 404) throw publicError('Folder not found. Check the folder ID.');
                if (isRateLimitStatus(error)) throw publicError('Google Drive rate limit or quota exceeded while listing folder contents. Wait and retry with backoff (see https://developers.google.com/workspace/drive/api/guides/limits).');
                if (getStatus(error) === 403) throw publicError('Permission denied. Make sure you have access to this folder.');
                throw wrapOperationError('list folder contents', error, { status: getStatus(error) });
            }
        },
    });
}

import { describe, expect, it, jest } from '@jest/globals';

let fakeDrive;
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDriveClient: async () => fakeDrive,
}));

const { register } = await import('../dist/tools/drive/listFolderContents.js');

function getTool() {
    let tool;
    register({ addTool(definition) { tool = definition; } });
    return tool;
}

const noopLog = { info() {}, error() {}, warn() {}, debug() {} };
const folder = (id, name, parents) => ({ id, name, mimeType: 'application/vnd.google-apps.folder', parents, modifiedTime: '2026-08-21T00:00:00Z' });
const file = (id, name, parents) => ({ id, name, mimeType: 'text/plain', parents, modifiedTime: '2026-08-21T00:00:00Z', size: '12' });

describe('listFolderContents recursive traversal', () => {
    it('keeps the omitted-depth request and {folders, files} response byte-for-byte compatible', async () => {
        const list = jest.fn(async () => ({ data: { files: [
            { id: 'child', name: 'Child', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01' },
            { id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' },
        ] } }));
        fakeDrive = { files: { list, get: jest.fn() } };

        const result = await getTool().execute({ folderId: "ro'ot", includeSubfolders: true, includeFiles: true, maxResults: 50, depth: 1 }, { log: noopLog });

        expect(result).toBe(JSON.stringify({
            folders: [{ id: 'child', name: 'Child', modifiedTime: '2026-01-01' }],
            files: [{ id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' }],
        }, null, 2));
        expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "'ro\\'ot' in parents and trashed=false", pageSize: 50 }));
    });

    it('validates recursive parameter combinations and boundaries', () => {
        const parameters = getTool().parameters;
        expect(parameters.safeParse({ folderId: 'x', depth: 0 }).success).toBe(false);
        expect(parameters.safeParse({ folderId: 'x', depth: 11 }).success).toBe(false);
        expect(parameters.safeParse({ folderId: 'x', depth: 1.5 }).success).toBe(false);
        expect(parameters.safeParse({ folderId: 'x', depth: 'all' }).success).toBe(true);
        expect(parameters.safeParse({ folderId: 'x', depth: 1, maxItems: 2 }).success).toBe(false);
        expect(parameters.safeParse({ folderId: 'x', depth: 2, includeSubfolders: false }).success).toBe(false);
        expect(parameters.safeParse({ folderId: 'x', depth: 2, maxItems: 5001 }).success).toBe(false);
    });

    it('lists depth two with one batched child query and reconstructable paths', async () => {
        const list = jest.fn(async ({ q }) => {
            if (q.includes("'root-id'")) return { data: { files: [folder('a', 'A', ['root-id']), folder('b', 'B', ['root-id']), folder('c', 'C', ['root-id'])] } };
            return { data: { files: [file('a-file', 'a.txt', ['a']), file('b-file', 'b.txt', ['b']), file('c-file', 'c.txt', ['c'])] } };
        });
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'My Drive' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 2, includeSubfolders: true, includeFiles: true }, { log: noopLog }));

        expect(result.apiCalls).toBe(3);
        expect(list).toHaveBeenCalledTimes(2);
        expect(list.mock.calls[1][0].q).toContain("'a' in parents or 'b' in parents or 'c' in parents");
        expect(result.entries.find((entry) => entry.id === 'b-file')).toMatchObject({ path: 'My Drive/B/b.txt', parentIds: ['b'], size: '12' });
        expect(result.truncated).toBe(false);
    });

    it('terminates depth all for multi-parent folders and upward shortcuts', async () => {
        const list = jest.fn(async ({ q }) => {
            if (q.includes("'root-id'")) return { data: { files: [folder('a', 'A', ['root-id']), folder('b', 'B', ['root-id'])] } };
            if (q.includes("'a' in parents") || q.includes("'b' in parents")) return { data: { files: [
                folder('c', 'C', ['a', 'b']),
                { id: 'up', name: 'Up', mimeType: 'application/vnd.google-apps.shortcut', parents: ['a'], shortcutDetails: { targetId: 'root-id' } },
            ] } };
            return { data: { files: [folder('a', 'A', ['c'])] } };
        });
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 'all' }, { log: noopLog }));

        expect(result.entries.filter((entry) => entry.id === 'a')).toHaveLength(1);
        expect(result.entries.find((entry) => entry.id === 'a').parentIds).toEqual(['root-id', 'c']);
        expect(result.entries.find((entry) => entry.id === 'c').parentIds).toEqual(['a', 'b']);
        expect(result.entries.find((entry) => entry.id === 'up').shortcutDetails).toEqual({ targetId: 'root-id' });
        expect(list).toHaveBeenCalledTimes(3);
    });

    it('reports maxItems truncation instead of silently returning a partial tree', async () => {
        const list = jest.fn(async () => ({ data: { files: [folder('a', 'A', ['root-id']), file('f', 'f.txt', ['root-id'])] } }));
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 'all', maxItems: 1 }, { log: noopLog }));

        expect(result).toMatchObject({ count: 1, truncated: true });
        expect(result.truncationReason).toMatch(/maxItems \(1\).*discovered folders not expanded/);
        expect(result.entries).toEqual([expect.objectContaining({ id: 'a', path: 'Root/A', parentIds: ['root-id'] })]);
    });

    it('returns buffered pages when the API-call budget ends during a parent chunk', async () => {
        let childPageCalls = 0;
        const list = jest.fn(async ({ q, pageToken }) => {
            if (q.includes("'root-id' in parents")) {
                return { data: { files: Array.from({ length: 50 }, (_, index) => folder(`folder-${index}`, `Folder ${index}`, ['root-id'])) } };
            }
            childPageCalls += 1;
            return { data: {
                files: [file(`partial-${childPageCalls}`, `partial-${childPageCalls}.txt`, ['folder-0'])],
                nextPageToken: `page-${childPageCalls + 1}`,
            } };
        });
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 'all' }, { log: noopLog }));

        expect(result).toMatchObject({ truncated: true, truncationReason: 'API call budget (50) exhausted', apiCalls: 50 });
        expect(result.entries).toHaveLength(98);
        expect(result.entries.find((entry) => entry.id === 'partial-48')).toMatchObject({
            path: 'Root/Folder 0/partial-48.txt',
            parentIds: ['folder-0'],
        });
        expect(result.entries.find((entry) => entry.id === 'partial-49')).toBeUndefined();
    });

    it('returns all entries fetched before the depth limit stops expansion', async () => {
        const list = jest.fn(async ({ q }) => q.includes("'root-id' in parents")
            ? ({ data: { files: [folder('a', 'A', ['root-id'])] } })
            : ({ data: { files: [folder('b', 'B', ['a'])] } }));
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 2 }, { log: noopLog }));

        expect(result).toMatchObject({ count: 2, truncated: true, truncationReason: 'depth (2) reached; 1 discovered folders not expanded' });
        expect(result.entries).toEqual([
            expect.objectContaining({ id: 'a', path: 'Root/A', parentIds: ['root-id'] }),
            expect.objectContaining({ id: 'b', path: 'Root/A/B', parentIds: ['a'] }),
        ]);
    });

    it('reports API-budget truncation after bounding a deep traversal', async () => {
        const list = jest.fn(async ({ q }) => {
            const parentId = q.match(/'([^']+)' in parents/)?.[1];
            return { data: { files: [folder(`child-of-${parentId}`, 'Child', [parentId])] } };
        });
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 'all' }, { log: noopLog }));

        expect(result).toMatchObject({ truncated: true, truncationReason: 'API call budget (50) exhausted', apiCalls: 50 });
        expect(list).toHaveBeenCalledTimes(49);
    });

    it('isolates an unreadable subfolder without losing readable siblings', async () => {
        const list = jest.fn(async ({ q }) => {
            if (q.includes("'root-id'")) return { data: { files: [folder('a', 'A', ['root-id']), folder('b', 'B', ['root-id'])] } };
            if (q.includes("'a' in parents") && q.includes("'b' in parents")) { const error = new Error('forbidden'); error.code = 403; throw error; }
            if (q.includes("'b' in parents")) { const error = new Error('forbidden'); error.code = 403; throw error; }
            return { data: { files: [file('a-file', 'a.txt', ['a'])] } };
        });
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 'all' }, { log: noopLog }));

        expect(result.entries.some((entry) => entry.id === 'a-file')).toBe(true);
        expect(result.unreadable).toEqual([{ id: 'b', path: 'Root/B', reason: 'Permission denied or folder unavailable.' }]);
    });

    it('fully paginates a level before descending and deduplicates page overlap', async () => {
        const calls = [];
        const list = jest.fn(async ({ q, pageToken }) => {
            calls.push({ q, pageToken });
            if (q.includes("'root-id'") && !pageToken) return { data: { files: [folder('a', 'A', ['root-id'])], nextPageToken: 'second' } };
            if (q.includes("'root-id'")) return { data: { files: [folder('a', 'A', ['root-id']), file('root-file', 'root.txt', ['root-id'])] } };
            return { data: { files: [] } };
        });
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 'all' }, { log: noopLog }));

        expect(calls.map((call) => call.pageToken)).toEqual([undefined, 'second', undefined]);
        expect(result.entries.map((entry) => entry.id)).toEqual(['a', 'root-file']);
    });

    it('omits files when requested but still descends through folders', async () => {
        const list = jest.fn(async ({ q }) => q.includes("'root-id'")
            ? ({ data: { files: [folder('a', 'A', ['root-id']), file('root-file', 'root.txt', ['root-id'])] } })
            : ({ data: { files: [file('nested-file', 'nested.txt', ['a'])] } }));
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 2, includeFiles: false }, { log: noopLog }));

        expect(result.entries.map((entry) => entry.id)).toEqual(['a']);
        expect(list).toHaveBeenCalledTimes(2);
    });

    // Review finding 1: Drive uses 403 for both "you can't read this folder"
    // and "you're temporarily over quota/rate limit" â€” the latter must be
    // propagated (and retried by the caller per Drive's own guidance), never
    // fabricated into an `unreadable` entry or used to trigger the isolation
    // bisection that burns more calls exactly when Drive is asking the
    // client to back off.
    it('propagates a rate-limited 403 instead of fabricating an unreadable entry or bisecting the chunk', async () => {
        let combinedChunkAttempts = 0;
        const list = jest.fn(async ({ q }) => {
            if (q.includes("'root-id'")) return { data: { files: [folder('a', 'A', ['root-id']), folder('b', 'B', ['root-id'])] } };
            if (q.includes("'a' in parents") && q.includes("'b' in parents")) {
                combinedChunkAttempts += 1;
                const error = new Error('User Rate Limit Exceeded');
                error.code = 403;
                error.errors = [{ domain: 'usageLimits', reason: 'userRateLimitExceeded', message: 'User Rate Limit Exceeded' }];
                throw error;
            }
            throw new Error('must not bisect into a singleton-parent query on a rate-limit 403');
        });
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        await expect(getTool().execute({ folderId: 'root', depth: 'all' }, { log: noopLog })).rejects.toThrow(/rate limit|quota/i);

        // Exactly one attempt at the combined [a, b] chunk â€” no isolation
        // bisection into singleton 'a' / 'b' retries.
        expect(combinedChunkAttempts).toBe(1);
        expect(list).toHaveBeenCalledTimes(2);
    });

    // Review finding 2: a maxItems cap already satisfiable from an earlier
    // page must stop pagination before the next page is requested, instead
    // of buffering every page of the chunk first.
    it('stops paginating once maxItems is satisfied without fetching a needless later page', async () => {
        const list = jest.fn(async ({ q, pageToken }) => {
            if (q.includes("'root-id'") && !pageToken) {
                return { data: { files: [file('first', 'first.txt', ['root-id']), file('second', 'second.txt', ['root-id'])], nextPageToken: 'page-2' } };
            }
            if (pageToken === 'page-2') {
                throw new Error('must not fetch a later page once maxItems is already satisfied');
            }
            return { data: { files: [] } };
        });
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 'all', maxItems: 1 }, { log: noopLog }));

        expect(result).toMatchObject({ count: 1, truncated: true });
        expect(result.entries).toEqual([expect.objectContaining({ id: 'first' })]);
        expect(list).toHaveBeenCalledTimes(1);
    });

    // Review finding 4: a shared-drive root must scope every recursive
    // files.list call to that drive (corpora: 'drive' + driveId), or
    // descendants the caller has access to via the drive but never
    // individually opened are silently dropped from a tree reported as
    // complete (truncated: false).
    it('scopes every recursive files.list call to the shared drive when the root has a driveId', async () => {
        const list = jest.fn(async ({ q }) => q.includes("'root-id'")
            ? ({ data: { files: [folder('a', 'A', ['root-id'])] } })
            : ({ data: { files: [] } }));
        const get = jest.fn(async () => ({ data: { id: 'root-id', name: 'Shared Root', driveId: 'shared-drive-x' } }));
        fakeDrive = { files: { get, list } };

        await getTool().execute({ folderId: 'root', depth: 'all' }, { log: noopLog });

        expect(get).toHaveBeenCalledWith(expect.objectContaining({ fields: expect.stringContaining('driveId') }));
        expect(list).toHaveBeenCalledTimes(2);
        for (const call of list.mock.calls) {
            expect(call[0]).toMatchObject({ corpora: 'drive', driveId: 'shared-drive-x' });
        }
    });

    it('does not set corpora/driveId for a My Drive root without a driveId', async () => {
        const list = jest.fn(async () => ({ data: { files: [] } }));
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'My Drive' } })), list } };

        await getTool().execute({ folderId: 'root', depth: 'all' }, { log: noopLog });

        expect(list.mock.calls[0][0].corpora).toBeUndefined();
        expect(list.mock.calls[0][0].driveId).toBeUndefined();
    });
});


exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' log -n 10 --pretty=fuller" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
 succeeded in 93ms:
commit 4f76e3f58c9738fffc5fa2db2f2356c9efd1ba00
Author:     Elliot Drel <elliotdrel@gmail.com>
AuthorDate: Sat Aug 29 10:07:25 2026 -0400
Commit:     Elliot Drel <elliotdrel@gmail.com>
CommitDate: Sat Aug 29 10:07:25 2026 -0400

    Request re-consent unconditionally and cover the refresh-token contract
    
    The invalid_grant recovery path and `google-tools-mcp auth` asked for
    re-consent, but the plain authorize() path did not. That path is exactly
    where the problem bites: a user who has authorized this app before and
    arrives with no token.json (fresh machine, deleted file) is precisely the
    case where Google can complete the exchange without minting a refresh
    token. They would have hit the new "no refresh token" error and been told
    to run a second command that does the same thing with consent forced.
    
    Google always shows the consent screen on a genuinely first-time
    authorization, so requesting it unconditionally costs first-time users
    nothing and makes every returning case obtain a refresh token. The
    forceConsent parameter is gone along with the branch in its error message.
    
    Adds tests/authConsentFlow.test.js, which #115 shipped without: every
    authenticate() call requests consent, the invalid_grant path requests it
    after deleting the stale token, an exchange with no refresh_token throws
    without calling saveCredentials or logging success, and a normal exchange
    saves and succeeds. Verified the suite fails (2 of 4) when the consent
    request is removed, so it catches the regression rather than passing
    vacuously.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

commit 61512c901f6e7739555bb3cc60f0a3d3b22d749e
Author:     Elliot Drel <elliotdrel@gmail.com>
AuthorDate: Sat Aug 29 09:41:36 2026 -0400
Commit:     Elliot Drel <elliotdrel@gmail.com>
CommitDate: Sat Aug 29 09:41:36 2026 -0400

    Regenerate MCP migration inventory snapshot
    
    Line shifts from the review-finding fixes across dist/ and tests/ moved
    enough source positions to fail tests/mcpMigrationInventory.test.js on
    content alone; no tool count or registration changed.
    
    Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

commit b2a82c9e02cb8e4f70ced234f62e37fe59c20a43
Author:     Elliot Drel <elliotdrel@gmail.com>
AuthorDate: Sat Aug 29 09:40:58 2026 -0400
Commit:     Elliot Drel <elliotdrel@gmail.com>
CommitDate: Sat Aug 29 09:40:58 2026 -0400

    Distinguish partial from total initial-content failure in createDocument (review finding 3)
    
    executeBatchUpdateWithSplitting sends delete/insert/format requests across
    separate, non-atomic documents.batchUpdate calls; once a batch succeeds it
    stays committed even if a later batch in the same call throws. createDocument
    always reported "initial content could not be added" regardless, so a
    caller trusting that message and resending initialContent could duplicate
    content that had already landed.
    
    executeBatchUpdateWithSplitting now tags (via a WeakMap side-channel, not a
    wrapping error type — appendMarkdown/replaceDocumentWithMarkdown rely on
    `instanceof UserError` to decide whether an underlying error's message is
    safe to surface, which a wrapper would have silently broken) each thrown
    error with how many requests already completed and in which phase.
    createDocument uses that to say explicitly when content was partially
    applied and tell the caller to inspect the document before retrying,
    instead of falsely claiming nothing was added.
    
    Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

commit 5e3ee6f7d36bdd385354ae60627f0efb4b639c6d
Author:     Elliot Drel <elliotdrel@gmail.com>
AuthorDate: Sat Aug 29 09:39:14 2026 -0400
Commit:     Elliot Drel <elliotdrel@gmail.com>
CommitDate: Sat Aug 29 09:39:14 2026 -0400

    Add regression tests for review findings 1, 2, and 4
    
    Covers: a rate-limited 403 propagates without fabricating an unreadable
    entry or triggering isolation bisection (finding 1); a maxItems cap already
    satisfied by an earlier page stops pagination before a later page is
    requested (finding 2); and every recursive files.list call is scoped to a
    shared-drive root via corpora/driveId, with no corpora set for a plain My
    Drive root (finding 4).
    
    Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

commit 473b60da4c6332f4c7e6f713a95003244fa119c0
Author:     Elliot Drel <elliotdrel@gmail.com>
AuthorDate: Sat Aug 29 09:38:20 2026 -0400
Commit:     Elliot Drel <elliotdrel@gmail.com>
CommitDate: Sat Aug 29 09:38:20 2026 -0400

    Classify 403 reasons, scope shared-drive corpora, and stop pagination once maxItems is met (review findings 1, 2, 4)
    
    Three fixes to the recursive traversal added in PR #99/#112:
    
    - Finding 1: every 403 was treated as a folder-access failure, so a
      transient userRateLimitExceeded/quotaExceeded response got misreported as
      a fabricated `unreadable` entry (or, worse, triggered isolation bisection
      that burns more calls exactly when Drive is asking the client to back
      off). Rate-limit/quota reasons are now read from the structured Drive
      error and propagated instead of isolated.
    
    - Finding 4: every files.list call left `corpora` at its default 'user'
      scope, so a shared-drive traversal could silently omit descendants the
      caller has access to via the drive but never individually opened, while
      still reporting truncated: false. The start folder's driveId is now
      fetched and threaded through as corpora: 'drive' + driveId on every
      recursive files.list call.
    
    - Finding 2: listParentChunk buffered every page of a chunk before any item
      was checked against maxItems, so a maxItems: 1 request could still spend
      the entire 50-call API budget paginating through thousands of children.
      Pages are now handed to the caller as soon as they arrive, so pagination
      stops as soon as maxItems is satisfied instead of after the whole chunk
      is fetched.
    
    Tests to follow in a subsequent commit.
    
    Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

commit 2e75a2206a2a7cc49eb3fc5ae4cae680ab0ca23f
Author:     Elliot Drel <elliotdrel@gmail.com>
AuthorDate: Sat Aug 29 09:38:10 2026 -0400
Commit:     Elliot Drel <elliotdrel@gmail.com>
CommitDate: Sat Aug 29 09:38:10 2026 -0400

    Accept "name" for copyFile and reject unknown parameters (issue #124)
    
    The schema only accepted "newName", so a caller sending Drive's own field
    name ("name") had it silently stripped by Zod's default unknown-key
    handling — no error, and the copy landed as "Copy of <original>" instead of
    the requested name. Now both "name" (wins on conflict) and "newName"
    (compatibility alias) are accepted, and the schema is .strict() so a future
    unsupported parameter fails validation instead of vanishing.
    
    Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

commit aa8bf49a63a5341df387dc3bd9e4a58b0914f2e8
Author:     Elliot Drel <elliotdrel@gmail.com>
AuthorDate: Sat Aug 29 09:38:05 2026 -0400
Commit:     Elliot Drel <elliotdrel@gmail.com>
CommitDate: Sat Aug 29 09:38:05 2026 -0400

    Fail loudly instead of reporting fake success on a re-auth that got no refresh token (issue #115)
    
    authenticate() logged a warning and skipped saveCredentials() when Google
    returned no refresh_token, then still logged "Authentication successful!"
    and returned the access-token client — the invalid_grant recovery path hits
    this directly, since it deletes the old token.json and immediately retries
    through this same function. Now: recovery paths and the explicit
    `google-tools-mcp auth` CLI command request re-consent (prompt: 'consent')
    so Google is asked to mint a fresh refresh token, and authenticate() throws
    instead of claiming success whenever no refresh token comes back, since
    nothing durable was actually saved.
    
    Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

commit 5e915625093793aaebd9cdaead6c735545e57892
Author:     Elliot Drel <elliotdrel@gmail.com>
AuthorDate: Fri Aug 21 12:32:37 2026 -0400
Commit:     Elliot Drel <elliotdrel@gmail.com>
CommitDate: Fri Aug 21 12:32:37 2026 -0400

    Return pages already fetched when the API budget runs out
    
    Exhausting the call budget mid-chunk discarded every page the
    traversal had already paid for, so the caller got nothing from that
    chunk instead of a partial result. Buffered entries are now returned
    with truncated set and the budget named as the reason, matching how
    the depth and item limits already behave. Tests also pin that the
    other two limits keep their fetched entries.

commit b2e09e46b65997b1fe2d371c9229770b3278c6f4
Author:     Elliot Drel <elliotdrel@gmail.com>
AuthorDate: Fri Aug 21 11:50:57 2026 -0400
Commit:     Elliot Drel <elliotdrel@gmail.com>
CommitDate: Fri Aug 21 11:50:57 2026 -0400

    Close test and package blind spots (#56)
    
    A test file was living inside dist/ and shipping to npm; it is deleted,
    its unique assertions ported to tests/, and package.json now excludes
    dist test files from the tarball, with a packaging test that fails if a
    non-runtime file sneaks back in.
    
    The escape-sequence normalization that turns literal backslash-n and
    backslash-t into real characters is extracted and exported, so its
    regression tests exercise the shipped implementation instead of a
    copied regex. createDocument surfaced markdown fidelity warnings but
    swallowed a total initial-content failure; it now reports the document
    as created with the content failure explicit, without exposing the
    caught API error. Drive permission tools gain execution coverage for
    field and ID handling, role safety, shared drives, API failures, and
    ownership transfer.
    
    The inventory guard now counts intentional new files rather than only
    committed ones, so a snapshot can be regenerated alongside the tests it
    describes.
    
    Closes #56. Closes #100. Closes #101.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

commit cc34e9694755197bcd24c738d97332f4cf518f9e
Author:     Elliot Drel <elliotdrel@gmail.com>
AuthorDate: Fri Aug 21 11:39:55 2026 -0400
Commit:     Elliot Drel <elliotdrel@gmail.com>
CommitDate: Fri Aug 21 11:39:55 2026 -0400

    List folders recursively with explicit bounds (#99)
    
    listFolderContents gains depth (1-10 or all) and maxItems. Depth 1 is
    unchanged, returning the same {folders, files} shape existing callers
    parse; deeper reads return a flat breadth-first tree where each entry
    carries its path and every discovered parent edge.
    
    A folder is expanded once, so cycles and multi-parent diamonds cannot
    loop or duplicate a subtree, and shortcuts are listed with their target
    but never followed. Traversal batches up to 50 parents per Drive query
    and stops at whichever of depth, maxItems, or a 50-call budget is hit
    first, always reporting which one in truncationReason rather than
    truncating silently. A subfolder the caller cannot read is isolated by
    bisecting its batch and reported in unreadable instead of failing the
    whole listing.
    
    Closes #99.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content 'tests/listFolderContents.test.js' | Select-Object -First 115" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
 succeeded in 140ms:
import { describe, expect, it, jest } from '@jest/globals';

let fakeDrive;
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDriveClient: async () => fakeDrive,
}));

const { register } = await import('../dist/tools/drive/listFolderContents.js');

function getTool() {
    let tool;
    register({ addTool(definition) { tool = definition; } });
    return tool;
}

const noopLog = { info() {}, error() {}, warn() {}, debug() {} };
const folder = (id, name, parents) => ({ id, name, mimeType: 'application/vnd.google-apps.folder', parents, modifiedTime: '2026-08-21T00:00:00Z' });
const file = (id, name, parents) => ({ id, name, mimeType: 'text/plain', parents, modifiedTime: '2026-08-21T00:00:00Z', size: '12' });

describe('listFolderContents recursive traversal', () => {
    it('keeps the omitted-depth request and {folders, files} response byte-for-byte compatible', async () => {
        const list = jest.fn(async () => ({ data: { files: [
            { id: 'child', name: 'Child', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01' },
            { id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' },
        ] } }));
        fakeDrive = { files: { list, get: jest.fn() } };

        const result = await getTool().execute({ folderId: "ro'ot", includeSubfolders: true, includeFiles: true, maxResults: 50, depth: 1 }, { log: noopLog });

        expect(result).toBe(JSON.stringify({
            folders: [{ id: 'child', name: 'Child', modifiedTime: '2026-01-01' }],
            files: [{ id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' }],
        }, null, 2));
        expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "'ro\\'ot' in parents and trashed=false", pageSize: 50 }));
    });

    it('validates recursive parameter combinations and boundaries', () => {
        const parameters = getTool().parameters;
        expect(parameters.safeParse({ folderId: 'x', depth: 0 }).success).toBe(false);
        expect(parameters.safeParse({ folderId: 'x', depth: 11 }).success).toBe(false);
        expect(parameters.safeParse({ folderId: 'x', depth: 1.5 }).success).toBe(false);
        expect(parameters.safeParse({ folderId: 'x', depth: 'all' }).success).toBe(true);
        expect(parameters.safeParse({ folderId: 'x', depth: 1, maxItems: 2 }).success).toBe(false);
        expect(parameters.safeParse({ folderId: 'x', depth: 2, includeSubfolders: false }).success).toBe(false);
        expect(parameters.safeParse({ folderId: 'x', depth: 2, maxItems: 5001 }).success).toBe(false);
    });

    it('lists depth two with one batched child query and reconstructable paths', async () => {
        const list = jest.fn(async ({ q }) => {
            if (q.includes("'root-id'")) return { data: { files: [folder('a', 'A', ['root-id']), folder('b', 'B', ['root-id']), folder('c', 'C', ['root-id'])] } };
            return { data: { files: [file('a-file', 'a.txt', ['a']), file('b-file', 'b.txt', ['b']), file('c-file', 'c.txt', ['c'])] } };
        });
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'My Drive' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 2, includeSubfolders: true, includeFiles: true }, { log: noopLog }));

        expect(result.apiCalls).toBe(3);
        expect(list).toHaveBeenCalledTimes(2);
        expect(list.mock.calls[1][0].q).toContain("'a' in parents or 'b' in parents or 'c' in parents");
        expect(result.entries.find((entry) => entry.id === 'b-file')).toMatchObject({ path: 'My Drive/B/b.txt', parentIds: ['b'], size: '12' });
        expect(result.truncated).toBe(false);
    });

    it('terminates depth all for multi-parent folders and upward shortcuts', async () => {
        const list = jest.fn(async ({ q }) => {
            if (q.includes("'root-id'")) return { data: { files: [folder('a', 'A', ['root-id']), folder('b', 'B', ['root-id'])] } };
            if (q.includes("'a' in parents") || q.includes("'b' in parents")) return { data: { files: [
                folder('c', 'C', ['a', 'b']),
                { id: 'up', name: 'Up', mimeType: 'application/vnd.google-apps.shortcut', parents: ['a'], shortcutDetails: { targetId: 'root-id' } },
            ] } };
            return { data: { files: [folder('a', 'A', ['c'])] } };
        });
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 'all' }, { log: noopLog }));

        expect(result.entries.filter((entry) => entry.id === 'a')).toHaveLength(1);
        expect(result.entries.find((entry) => entry.id === 'a').parentIds).toEqual(['root-id', 'c']);
        expect(result.entries.find((entry) => entry.id === 'c').parentIds).toEqual(['a', 'b']);
        expect(result.entries.find((entry) => entry.id === 'up').shortcutDetails).toEqual({ targetId: 'root-id' });
        expect(list).toHaveBeenCalledTimes(3);
    });

    it('reports maxItems truncation instead of silently returning a partial tree', async () => {
        const list = jest.fn(async () => ({ data: { files: [folder('a', 'A', ['root-id']), file('f', 'f.txt', ['root-id'])] } }));
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 'all', maxItems: 1 }, { log: noopLog }));

        expect(result).toMatchObject({ count: 1, truncated: true });
        expect(result.truncationReason).toMatch(/maxItems \(1\).*discovered folders not expanded/);
        expect(result.entries).toEqual([expect.objectContaining({ id: 'a', path: 'Root/A', parentIds: ['root-id'] })]);
    });

    it('returns buffered pages when the API-call budget ends during a parent chunk', async () => {
        let childPageCalls = 0;
        const list = jest.fn(async ({ q, pageToken }) => {
            if (q.includes("'root-id' in parents")) {
                return { data: { files: Array.from({ length: 50 }, (_, index) => folder(`folder-${index}`, `Folder ${index}`, ['root-id'])) } };
            }
            childPageCalls += 1;
            return { data: {
                files: [file(`partial-${childPageCalls}`, `partial-${childPageCalls}.txt`, ['folder-0'])],
                nextPageToken: `page-${childPageCalls + 1}`,
            } };
        });
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 'all' }, { log: noopLog }));

        expect(result).toMatchObject({ truncated: true, truncationReason: 'API call budget (50) exhausted', apiCalls: 50 });
        expect(result.entries).toHaveLength(98);
        expect(result.entries.find((entry) => entry.id === 'partial-48')).toMatchObject({
            path: 'Root/Folder 0/partial-48.txt',
            parentIds: ['folder-0'],

apply patch
patch: completed
C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE\tests\listFolderContents.test.js
diff --git a/tests/listFolderContents.test.js b/tests/listFolderContents.test.js
index 67f633d21ee43ac4bc7bf255d7125ed22030d69a..3a495284ba0546a695c6a9955ceb41c5486bb83a
--- a/tests/listFolderContents.test.js
+++ b/tests/listFolderContents.test.js
@@ -18,7 +18,7 @@
 const file = (id, name, parents) => ({ id, name, mimeType: 'text/plain', parents, modifiedTime: '2026-08-21T00:00:00Z', size: '12' });
 
 describe('listFolderContents recursive traversal', () => {
-    it('keeps the omitted-depth request and {folders, files} response byte-for-byte compatible', async () => {
+    it('keeps depth-1 folders and files while reporting a complete single page', async () => {
         const list = jest.fn(async () => ({ data: { files: [
             { id: 'child', name: 'Child', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01' },
             { id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' },
@@ -30,10 +30,39 @@
         expect(result).toBe(JSON.stringify({
             folders: [{ id: 'child', name: 'Child', modifiedTime: '2026-01-01' }],
             files: [{ id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' }],
+            truncated: false,
         }, null, 2));
         expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "'ro\\'ot' in parents and trashed=false", pageSize: 50 }));
     });
 
+    it('reports depth-1 truncation when Drive returns another page', async () => {
+        const list = jest.fn(async () => ({ data: {
+            files: [file('first', 'first.txt', ['root-id'])],
+            nextPageToken: 'next-page',
+        } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'root-id', maxResults: 5, depth: 1 }, { log: noopLog }));
+
+        expect(result).toMatchObject({
+            folders: [],
+            files: [{ id: 'first', name: 'first.txt', mimeType: 'text/plain', modifiedTime: '2026-08-21T00:00:00Z' }],
+            truncated: true,
+        });
+        expect(result.truncationReason).toMatch(/maxResults \(5\).*maximum of 100.*depth.*maxItems/i);
+        expect(list).toHaveBeenCalledTimes(1);
+    });
+
+    it('distinguishes a genuinely empty depth-1 folder from a truncated listing', async () => {
+        const list = jest.fn(async () => ({ data: { files: [] } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'empty', depth: 1 }, { log: noopLog }));
+
+        expect(result).toEqual({ folders: [], files: [], truncated: false });
+        expect(result.truncationReason).toBeUndefined();
+    });
+
     it('validates recursive parameter combinations and boundaries', () => {
         const parameters = getTool().parameters;
         expect(parameters.safeParse({ folderId: 'x', depth: 0 }).success).toBe(false);

diff --git a/tests/listFolderContents.test.js b/tests/listFolderContents.test.js
index 67f633d21ee43ac4bc7bf255d7125ed22030d69a..3a495284ba0546a695c6a9955ceb41c5486bb83a
--- a/tests/listFolderContents.test.js
+++ b/tests/listFolderContents.test.js
@@ -18,7 +18,7 @@
 const file = (id, name, parents) => ({ id, name, mimeType: 'text/plain', parents, modifiedTime: '2026-08-21T00:00:00Z', size: '12' });
 
 describe('listFolderContents recursive traversal', () => {
-    it('keeps the omitted-depth request and {folders, files} response byte-for-byte compatible', async () => {
+    it('keeps depth-1 folders and files while reporting a complete single page', async () => {
         const list = jest.fn(async () => ({ data: { files: [
             { id: 'child', name: 'Child', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01' },
             { id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' },
@@ -30,10 +30,39 @@
         expect(result).toBe(JSON.stringify({
             folders: [{ id: 'child', name: 'Child', modifiedTime: '2026-01-01' }],
             files: [{ id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' }],
+            truncated: false,
         }, null, 2));
         expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "'ro\\'ot' in parents and trashed=false", pageSize: 50 }));
     });
 
+    it('reports depth-1 truncation when Drive returns another page', async () => {
+        const list = jest.fn(async () => ({ data: {
+            files: [file('first', 'first.txt', ['root-id'])],
+            nextPageToken: 'next-page',
+        } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'root-id', maxResults: 5, depth: 1 }, { log: noopLog }));
+
+        expect(result).toMatchObject({
+            folders: [],
+            files: [{ id: 'first', name: 'first.txt', mimeType: 'text/plain', modifiedTime: '2026-08-21T00:00:00Z' }],
+            truncated: true,
+        });
+        expect(result.truncationReason).toMatch(/maxResults \(5\).*maximum of 100.*depth.*maxItems/i);
+        expect(list).toHaveBeenCalledTimes(1);
+    });
+
+    it('distinguishes a genuinely empty depth-1 folder from a truncated listing', async () => {
+        const list = jest.fn(async () => ({ data: { files: [] } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'empty', depth: 1 }, { log: noopLog }));
+
+        expect(result).toEqual({ folders: [], files: [], truncated: false });
+        expect(result.truncationReason).toBeUndefined();
+    });
+
     it('validates recursive parameter combinations and boundaries', () => {
         const parameters = getTool().parameters;
         expect(parameters.safeParse({ folderId: 'x', depth: 0 }).success).toBe(false);

codex
I’ve added the regression expectations first. I’m running that Drive test before the runtime edit to prove the new assertions fail against the current single-page response, then I’ll implement the smallest additive fix.
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'npm.cmd test -- tests/listFolderContents.test.js' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
 exited 1 in 9062ms:

> google-tools-mcp@2.0.0 test
> node --experimental-vm-modules node_modules/jest/bin/jest.js tests/listFolderContents.test.js

(node:54436) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:54436) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
FAIL tests/listFolderContents.test.js
  ● listFolderContents recursive traversal › keeps depth-1 folders and files while reporting a complete single page

    expect(received).toBe(expected) // Object.is equality

    - Expected  - 2
    + Received  + 1

    @@ -11,8 +11,7 @@
            "id": "note",
            "name": "note.txt",
            "mimeType": "text/plain",
            "modifiedTime": "2026-01-02"
          }
    -   ],
    -   "truncated": false
    +   ]
      }

      28 |         const result = await getTool().execute({ folderId: "ro'ot", includeSubfolders: true, includeFiles: true, maxResults: 50, depth: 1 }, { log: noopLog });
      29 |
    > 30 |         expect(result).toBe(JSON.stringify({
         |                        ^
      31 |             folders: [{ id: 'child', name: 'Child', modifiedTime: '2026-01-01' }],
      32 |             files: [{ id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' }],
      33 |             truncated: false,

      at Object.<anonymous> (tests/listFolderContents.test.js:30:24)

  ● listFolderContents recursive traversal › reports depth-1 truncation when Drive returns another page

    expect(received).toMatchObject(expected)

    - Expected  - 1
    + Received  + 0

    @@ -6,7 +6,6 @@
            "modifiedTime": "2026-08-21T00:00:00Z",
            "name": "first.txt",
          },
        ],
        "folders": Array [],
    -   "truncated": true,
      }

      45 |         const result = JSON.parse(await getTool().execute({ folderId: 'root-id', maxResults: 5, depth: 1 }, { log: noopLog }));
      46 |
    > 47 |         expect(result).toMatchObject({
         |                        ^
      48 |             folders: [],
      49 |             files: [{ id: 'first', name: 'first.txt', mimeType: 'text/plain', modifiedTime: '2026-08-21T00:00:00Z' }],
      50 |             truncated: true,

      at Object.<anonymous> (tests/listFolderContents.test.js:47:24)

  ● listFolderContents recursive traversal › distinguishes a genuinely empty depth-1 folder from a truncated listing

    expect(received).toEqual(expected) // deep equality

    - Expected  - 1
    + Received  + 0

      Object {
        "files": Array [],
        "folders": Array [],
    -   "truncated": false,
      }

      60 |         const result = JSON.parse(await getTool().execute({ folderId: 'empty', depth: 1 }, { log: noopLog }));
      61 |
    > 62 |         expect(result).toEqual({ folders: [], files: [], truncated: false });
         |                        ^
      63 |         expect(result.truncationReason).toBeUndefined();
      64 |     });
      65 |

      at Object.<anonymous> (tests/listFolderContents.test.js:62:24)

Test Suites: 1 failed, 1 total
Tests:       3 failed, 14 passed, 17 total
Snapshots:   0 total
Time:        2.7 s
Ran all test suites matching tests/listFolderContents.test.js.

diff --git a/tests/listFolderContents.test.js b/tests/listFolderContents.test.js
index 67f633d21ee43ac4bc7bf255d7125ed22030d69a..3a495284ba0546a695c6a9955ceb41c5486bb83a
--- a/tests/listFolderContents.test.js
+++ b/tests/listFolderContents.test.js
@@ -18,7 +18,7 @@
 const file = (id, name, parents) => ({ id, name, mimeType: 'text/plain', parents, modifiedTime: '2026-08-21T00:00:00Z', size: '12' });
 
 describe('listFolderContents recursive traversal', () => {
-    it('keeps the omitted-depth request and {folders, files} response byte-for-byte compatible', async () => {
+    it('keeps depth-1 folders and files while reporting a complete single page', async () => {
         const list = jest.fn(async () => ({ data: { files: [
             { id: 'child', name: 'Child', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01' },
             { id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' },
@@ -30,10 +30,39 @@
         expect(result).toBe(JSON.stringify({
             folders: [{ id: 'child', name: 'Child', modifiedTime: '2026-01-01' }],
             files: [{ id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' }],
+            truncated: false,
         }, null, 2));
         expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "'ro\\'ot' in parents and trashed=false", pageSize: 50 }));
     });
 
+    it('reports depth-1 truncation when Drive returns another page', async () => {
+        const list = jest.fn(async () => ({ data: {
+            files: [file('first', 'first.txt', ['root-id'])],
+            nextPageToken: 'next-page',
+        } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'root-id', maxResults: 5, depth: 1 }, { log: noopLog }));
+
+        expect(result).toMatchObject({
+            folders: [],
+            files: [{ id: 'first', name: 'first.txt', mimeType: 'text/plain', modifiedTime: '2026-08-21T00:00:00Z' }],
+            truncated: true,
+        });
+        expect(result.truncationReason).toMatch(/maxResults \(5\).*maximum of 100.*depth.*maxItems/i);
+        expect(list).toHaveBeenCalledTimes(1);
+    });
+
+    it('distinguishes a genuinely empty depth-1 folder from a truncated listing', async () => {
+        const list = jest.fn(async () => ({ data: { files: [] } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'empty', depth: 1 }, { log: noopLog }));
+
+        expect(result).toEqual({ folders: [], files: [], truncated: false });
+        expect(result.truncationReason).toBeUndefined();
+    });
+
     it('validates recursive parameter combinations and boundaries', () => {
         const parameters = getTool().parameters;
         expect(parameters.safeParse({ folderId: 'x', depth: 0 }).success).toBe(false);

apply patch
patch: completed
C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE\dist\tools\drive\listFolderContents.js
diff --git a/dist/tools/drive/listFolderContents.js b/dist/tools/drive/listFolderContents.js
index 23ffaaf5e4ebe94ebf4a32005a910d0ebc838d3c..4ed9d7b5895d66612965adb171d4eb25a07dbbf9
--- a/dist/tools/drive/listFolderContents.js
+++ b/dist/tools/drive/listFolderContents.js
@@ -45,7 +45,7 @@
 export function register(server) {
     server.addTool({
         name: 'listFolderContents',
-        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns the legacy {folders, files} result. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the legacy depth-1 response. Use getFilePath for the inverse, upward path lookup.",
+        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns a single {folders, files, truncated, truncationReason?} page capped by maxResults; truncated reports when Drive has more pages. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the single depth-1 page. Use getFilePath for the inverse, upward path lookup.",
         parameters: z.object({
             folderId: z.string().describe('ID of the folder to list contents of. Use "root" for the root Drive folder.'),
             includeSubfolders: z.boolean().optional().default(true).describe('Whether to include subfolders in results.'),
@@ -66,20 +66,25 @@
                 const includeSubfolders = args.includeSubfolders ?? true;
                 const includeFiles = args.includeFiles ?? true;
                 const maxResults = args.maxResults ?? 50;
-                // Keep the legacy depth-1 request and response shape intact.
+                // Keep depth 1 to its established single Drive page. Its additive
+                // truncation signal lets callers distinguish that page from a full listing.
                 if (depth === 1) {
                     let queryString = `'${escapeDriveQueryValue(args.folderId)}' in parents and trashed=false`;
                     if (!includeSubfolders) queryString += ` and mimeType!='${FOLDER_MIME_TYPE}'`;
                     else if (!includeFiles) queryString += ` and mimeType='${FOLDER_MIME_TYPE}'`;
                     const response = await drive.files.list({
                         q: queryString, pageSize: maxResults, orderBy: 'folder,name',
-                        fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
+                        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
                         supportsAllDrives: true, includeItemsFromAllDrives: true,
                     });
                     const items = response.data.files || [];
                     const folders = items.filter((f) => f.mimeType === FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
                     const files = items.filter((f) => f.mimeType !== FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime }));
-                    return JSON.stringify({ folders, files }, null, 2);
+                    const truncated = Boolean(response.data.nextPageToken);
+                    const truncationReason = truncated
+                        ? `maxResults (${maxResults}) single-page cap reached; raise maxResults (up to the maximum of 100) or use depth with maxItems for a bounded recursive traversal.`
+                        : undefined;
+                    return JSON.stringify({ folders, files, truncated, ...(truncationReason ? { truncationReason } : {}) }, null, 2);
                 }
 
                 const maxItems = args.maxItems ?? 500;
diff --git a/tests/listFolderContents.test.js b/tests/listFolderContents.test.js
index 67f633d21ee43ac4bc7bf255d7125ed22030d69a..3a495284ba0546a695c6a9955ceb41c5486bb83a
--- a/tests/listFolderContents.test.js
+++ b/tests/listFolderContents.test.js
@@ -18,7 +18,7 @@
 const file = (id, name, parents) => ({ id, name, mimeType: 'text/plain', parents, modifiedTime: '2026-08-21T00:00:00Z', size: '12' });
 
 describe('listFolderContents recursive traversal', () => {
-    it('keeps the omitted-depth request and {folders, files} response byte-for-byte compatible', async () => {
+    it('keeps depth-1 folders and files while reporting a complete single page', async () => {
         const list = jest.fn(async () => ({ data: { files: [
             { id: 'child', name: 'Child', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01' },
             { id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' },
@@ -30,10 +30,39 @@
         expect(result).toBe(JSON.stringify({
             folders: [{ id: 'child', name: 'Child', modifiedTime: '2026-01-01' }],
             files: [{ id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' }],
+            truncated: false,
         }, null, 2));
         expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "'ro\\'ot' in parents and trashed=false", pageSize: 50 }));
     });
 
+    it('reports depth-1 truncation when Drive returns another page', async () => {
+        const list = jest.fn(async () => ({ data: {
+            files: [file('first', 'first.txt', ['root-id'])],
+            nextPageToken: 'next-page',
+        } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'root-id', maxResults: 5, depth: 1 }, { log: noopLog }));
+
+        expect(result).toMatchObject({
+            folders: [],
+            files: [{ id: 'first', name: 'first.txt', mimeType: 'text/plain', modifiedTime: '2026-08-21T00:00:00Z' }],
+            truncated: true,
+        });
+        expect(result.truncationReason).toMatch(/maxResults \(5\).*maximum of 100.*depth.*maxItems/i);
+        expect(list).toHaveBeenCalledTimes(1);
+    });
+
+    it('distinguishes a genuinely empty depth-1 folder from a truncated listing', async () => {
+        const list = jest.fn(async () => ({ data: { files: [] } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'empty', depth: 1 }, { log: noopLog }));
+
+        expect(result).toEqual({ folders: [], files: [], truncated: false });
+        expect(result.truncationReason).toBeUndefined();
+    });
+
     it('validates recursive parameter combinations and boundaries', () => {
         const parameters = getTool().parameters;
         expect(parameters.safeParse({ folderId: 'x', depth: 0 }).success).toBe(false);

diff --git a/dist/tools/drive/listFolderContents.js b/dist/tools/drive/listFolderContents.js
index 23ffaaf5e4ebe94ebf4a32005a910d0ebc838d3c..4ed9d7b5895d66612965adb171d4eb25a07dbbf9
--- a/dist/tools/drive/listFolderContents.js
+++ b/dist/tools/drive/listFolderContents.js
@@ -45,7 +45,7 @@
 export function register(server) {
     server.addTool({
         name: 'listFolderContents',
-        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns the legacy {folders, files} result. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the legacy depth-1 response. Use getFilePath for the inverse, upward path lookup.",
+        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns a single {folders, files, truncated, truncationReason?} page capped by maxResults; truncated reports when Drive has more pages. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the single depth-1 page. Use getFilePath for the inverse, upward path lookup.",
         parameters: z.object({
             folderId: z.string().describe('ID of the folder to list contents of. Use "root" for the root Drive folder.'),
             includeSubfolders: z.boolean().optional().default(true).describe('Whether to include subfolders in results.'),
@@ -66,20 +66,25 @@
                 const includeSubfolders = args.includeSubfolders ?? true;
                 const includeFiles = args.includeFiles ?? true;
                 const maxResults = args.maxResults ?? 50;
-                // Keep the legacy depth-1 request and response shape intact.
+                // Keep depth 1 to its established single Drive page. Its additive
+                // truncation signal lets callers distinguish that page from a full listing.
                 if (depth === 1) {
                     let queryString = `'${escapeDriveQueryValue(args.folderId)}' in parents and trashed=false`;
                     if (!includeSubfolders) queryString += ` and mimeType!='${FOLDER_MIME_TYPE}'`;
                     else if (!includeFiles) queryString += ` and mimeType='${FOLDER_MIME_TYPE}'`;
                     const response = await drive.files.list({
                         q: queryString, pageSize: maxResults, orderBy: 'folder,name',
-                        fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
+                        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
                         supportsAllDrives: true, includeItemsFromAllDrives: true,
                     });
                     const items = response.data.files || [];
                     const folders = items.filter((f) => f.mimeType === FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
                     const files = items.filter((f) => f.mimeType !== FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime }));
-                    return JSON.stringify({ folders, files }, null, 2);
+                    const truncated = Boolean(response.data.nextPageToken);
+                    const truncationReason = truncated
+                        ? `maxResults (${maxResults}) single-page cap reached; raise maxResults (up to the maximum of 100) or use depth with maxItems for a bounded recursive traversal.`
+                        : undefined;
+                    return JSON.stringify({ folders, files, truncated, ...(truncationReason ? { truncationReason } : {}) }, null, 2);
                 }
 
                 const maxItems = args.maxItems ?? 500;
diff --git a/tests/listFolderContents.test.js b/tests/listFolderContents.test.js
index 67f633d21ee43ac4bc7bf255d7125ed22030d69a..3a495284ba0546a695c6a9955ceb41c5486bb83a
--- a/tests/listFolderContents.test.js
+++ b/tests/listFolderContents.test.js
@@ -18,7 +18,7 @@
 const file = (id, name, parents) => ({ id, name, mimeType: 'text/plain', parents, modifiedTime: '2026-08-21T00:00:00Z', size: '12' });
 
 describe('listFolderContents recursive traversal', () => {
-    it('keeps the omitted-depth request and {folders, files} response byte-for-byte compatible', async () => {
+    it('keeps depth-1 folders and files while reporting a complete single page', async () => {
         const list = jest.fn(async () => ({ data: { files: [
             { id: 'child', name: 'Child', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01' },
             { id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' },
@@ -30,10 +30,39 @@
         expect(result).toBe(JSON.stringify({
             folders: [{ id: 'child', name: 'Child', modifiedTime: '2026-01-01' }],
             files: [{ id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' }],
+            truncated: false,
         }, null, 2));
         expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "'ro\\'ot' in parents and trashed=false", pageSize: 50 }));
     });
 
+    it('reports depth-1 truncation when Drive returns another page', async () => {
+        const list = jest.fn(async () => ({ data: {
+            files: [file('first', 'first.txt', ['root-id'])],
+            nextPageToken: 'next-page',
+        } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'root-id', maxResults: 5, depth: 1 }, { log: noopLog }));
+
+        expect(result).toMatchObject({
+            folders: [],
+            files: [{ id: 'first', name: 'first.txt', mimeType: 'text/plain', modifiedTime: '2026-08-21T00:00:00Z' }],
+            truncated: true,
+        });
+        expect(result.truncationReason).toMatch(/maxResults \(5\).*maximum of 100.*depth.*maxItems/i);
+        expect(list).toHaveBeenCalledTimes(1);
+    });
+
+    it('distinguishes a genuinely empty depth-1 folder from a truncated listing', async () => {
+        const list = jest.fn(async () => ({ data: { files: [] } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'empty', depth: 1 }, { log: noopLog }));
+
+        expect(result).toEqual({ folders: [], files: [], truncated: false });
+        expect(result.truncationReason).toBeUndefined();
+    });
+
     it('validates recursive parameter combinations and boundaries', () => {
         const parameters = getTool().parameters;
         expect(parameters.safeParse({ folderId: 'x', depth: 0 }).success).toBe(false);

codex
The runtime now requests only `nextPageToken` in addition to the existing first-page fields, preserves the one-call behavior, and adds `truncated` plus a concrete recovery message only when Drive indicates another page. I’m rerunning the focused suite before staging and snapshot regeneration.
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'npm.cmd test -- tests/listFolderContents.test.js' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
 succeeded in 1922ms:

> google-tools-mcp@2.0.0 test
> node --experimental-vm-modules node_modules/jest/bin/jest.js tests/listFolderContents.test.js

(node:42860) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:42860) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
Test Suites: 1 passed, 1 total
Tests:       17 passed, 17 total
Snapshots:   0 total
Time:        0.472 s, estimated 3 s
Ran all test suites matching tests/listFolderContents.test.js.

diff --git a/dist/tools/drive/listFolderContents.js b/dist/tools/drive/listFolderContents.js
index 23ffaaf5e4ebe94ebf4a32005a910d0ebc838d3c..4ed9d7b5895d66612965adb171d4eb25a07dbbf9
--- a/dist/tools/drive/listFolderContents.js
+++ b/dist/tools/drive/listFolderContents.js
@@ -45,7 +45,7 @@
 export function register(server) {
     server.addTool({
         name: 'listFolderContents',
-        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns the legacy {folders, files} result. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the legacy depth-1 response. Use getFilePath for the inverse, upward path lookup.",
+        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns a single {folders, files, truncated, truncationReason?} page capped by maxResults; truncated reports when Drive has more pages. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the single depth-1 page. Use getFilePath for the inverse, upward path lookup.",
         parameters: z.object({
             folderId: z.string().describe('ID of the folder to list contents of. Use "root" for the root Drive folder.'),
             includeSubfolders: z.boolean().optional().default(true).describe('Whether to include subfolders in results.'),
@@ -66,20 +66,25 @@
                 const includeSubfolders = args.includeSubfolders ?? true;
                 const includeFiles = args.includeFiles ?? true;
                 const maxResults = args.maxResults ?? 50;
-                // Keep the legacy depth-1 request and response shape intact.
+                // Keep depth 1 to its established single Drive page. Its additive
+                // truncation signal lets callers distinguish that page from a full listing.
                 if (depth === 1) {
                     let queryString = `'${escapeDriveQueryValue(args.folderId)}' in parents and trashed=false`;
                     if (!includeSubfolders) queryString += ` and mimeType!='${FOLDER_MIME_TYPE}'`;
                     else if (!includeFiles) queryString += ` and mimeType='${FOLDER_MIME_TYPE}'`;
                     const response = await drive.files.list({
                         q: queryString, pageSize: maxResults, orderBy: 'folder,name',
-                        fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
+                        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
                         supportsAllDrives: true, includeItemsFromAllDrives: true,
                     });
                     const items = response.data.files || [];
                     const folders = items.filter((f) => f.mimeType === FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
                     const files = items.filter((f) => f.mimeType !== FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime }));
-                    return JSON.stringify({ folders, files }, null, 2);
+                    const truncated = Boolean(response.data.nextPageToken);
+                    const truncationReason = truncated
+                        ? `maxResults (${maxResults}) single-page cap reached; raise maxResults (up to the maximum of 100) or use depth with maxItems for a bounded recursive traversal.`
+                        : undefined;
+                    return JSON.stringify({ folders, files, truncated, ...(truncationReason ? { truncationReason } : {}) }, null, 2);
                 }
 
                 const maxItems = args.maxItems ?? 500;
diff --git a/tests/listFolderContents.test.js b/tests/listFolderContents.test.js
index 67f633d21ee43ac4bc7bf255d7125ed22030d69a..3a495284ba0546a695c6a9955ceb41c5486bb83a
--- a/tests/listFolderContents.test.js
+++ b/tests/listFolderContents.test.js
@@ -18,7 +18,7 @@
 const file = (id, name, parents) => ({ id, name, mimeType: 'text/plain', parents, modifiedTime: '2026-08-21T00:00:00Z', size: '12' });
 
 describe('listFolderContents recursive traversal', () => {
-    it('keeps the omitted-depth request and {folders, files} response byte-for-byte compatible', async () => {
+    it('keeps depth-1 folders and files while reporting a complete single page', async () => {
         const list = jest.fn(async () => ({ data: { files: [
             { id: 'child', name: 'Child', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01' },
             { id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' },
@@ -30,10 +30,39 @@
         expect(result).toBe(JSON.stringify({
             folders: [{ id: 'child', name: 'Child', modifiedTime: '2026-01-01' }],
             files: [{ id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' }],
+            truncated: false,
         }, null, 2));
         expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "'ro\\'ot' in parents and trashed=false", pageSize: 50 }));
     });
 
+    it('reports depth-1 truncation when Drive returns another page', async () => {
+        const list = jest.fn(async () => ({ data: {
+            files: [file('first', 'first.txt', ['root-id'])],
+            nextPageToken: 'next-page',
+        } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'root-id', maxResults: 5, depth: 1 }, { log: noopLog }));
+
+        expect(result).toMatchObject({
+            folders: [],
+            files: [{ id: 'first', name: 'first.txt', mimeType: 'text/plain', modifiedTime: '2026-08-21T00:00:00Z' }],
+            truncated: true,
+        });
+        expect(result.truncationReason).toMatch(/maxResults \(5\).*maximum of 100.*depth.*maxItems/i);
+        expect(list).toHaveBeenCalledTimes(1);
+    });
+
+    it('distinguishes a genuinely empty depth-1 folder from a truncated listing', async () => {
+        const list = jest.fn(async () => ({ data: { files: [] } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'empty', depth: 1 }, { log: noopLog }));
+
+        expect(result).toEqual({ folders: [], files: [], truncated: false });
+        expect(result.truncationReason).toBeUndefined();
+    });
+
     it('validates recursive parameter combinations and boundaries', () => {
         const parameters = getTool().parameters;
         expect(parameters.safeParse({ folderId: 'x', depth: 0 }).success).toBe(false);

exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' add -- 'dist/tools/drive/listFolderContents.js' 'tests/listFolderContents.test.js'; node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json > "'$null; git -c safe.directory='"'C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' add -- 'tests/fixtures/mcp-migration-inventory.json'; git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' diff --staged --check; git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' status --short" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
 succeeded in 28586ms:
fatal: Unable to create 'C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp/.git/worktrees/google-tools-mcp-prE/index.lock': Permission denied
fatal: Unable to create 'C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp/.git/worktrees/google-tools-mcp-prE/index.lock': Permission denied
warning: unable to access 'C:\Users\2supe/.config/git/ignore': Permission denied
warning: unable to access 'C:\Users\2supe/.config/git/ignore': Permission denied
warning: unable to access 'C:\Users\2supe/.config/git/ignore': Permission denied
 M dist/tools/drive/listFolderContents.js
 M tests/listFolderContents.test.js

diff --git a/dist/tools/drive/listFolderContents.js b/dist/tools/drive/listFolderContents.js
index 23ffaaf5e4ebe94ebf4a32005a910d0ebc838d3c..4ed9d7b5895d66612965adb171d4eb25a07dbbf9
--- a/dist/tools/drive/listFolderContents.js
+++ b/dist/tools/drive/listFolderContents.js
@@ -45,7 +45,7 @@
 export function register(server) {
     server.addTool({
         name: 'listFolderContents',
-        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns the legacy {folders, files} result. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the legacy depth-1 response. Use getFilePath for the inverse, upward path lookup.",
+        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns a single {folders, files, truncated, truncationReason?} page capped by maxResults; truncated reports when Drive has more pages. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the single depth-1 page. Use getFilePath for the inverse, upward path lookup.",
         parameters: z.object({
             folderId: z.string().describe('ID of the folder to list contents of. Use "root" for the root Drive folder.'),
             includeSubfolders: z.boolean().optional().default(true).describe('Whether to include subfolders in results.'),
@@ -66,20 +66,25 @@
                 const includeSubfolders = args.includeSubfolders ?? true;
                 const includeFiles = args.includeFiles ?? true;
                 const maxResults = args.maxResults ?? 50;
-                // Keep the legacy depth-1 request and response shape intact.
+                // Keep depth 1 to its established single Drive page. Its additive
+                // truncation signal lets callers distinguish that page from a full listing.
                 if (depth === 1) {
                     let queryString = `'${escapeDriveQueryValue(args.folderId)}' in parents and trashed=false`;
                     if (!includeSubfolders) queryString += ` and mimeType!='${FOLDER_MIME_TYPE}'`;
                     else if (!includeFiles) queryString += ` and mimeType='${FOLDER_MIME_TYPE}'`;
                     const response = await drive.files.list({
                         q: queryString, pageSize: maxResults, orderBy: 'folder,name',
-                        fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
+                        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
                         supportsAllDrives: true, includeItemsFromAllDrives: true,
                     });
                     const items = response.data.files || [];
                     const folders = items.filter((f) => f.mimeType === FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
                     const files = items.filter((f) => f.mimeType !== FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime }));
-                    return JSON.stringify({ folders, files }, null, 2);
+                    const truncated = Boolean(response.data.nextPageToken);
+                    const truncationReason = truncated
+                        ? `maxResults (${maxResults}) single-page cap reached; raise maxResults (up to the maximum of 100) or use depth with maxItems for a bounded recursive traversal.`
+                        : undefined;
+                    return JSON.stringify({ folders, files, truncated, ...(truncationReason ? { truncationReason } : {}) }, null, 2);
                 }
 
                 const maxItems = args.maxItems ?? 500;
diff --git a/tests/listFolderContents.test.js b/tests/listFolderContents.test.js
index 67f633d21ee43ac4bc7bf255d7125ed22030d69a..3a495284ba0546a695c6a9955ceb41c5486bb83a
--- a/tests/listFolderContents.test.js
+++ b/tests/listFolderContents.test.js
@@ -18,7 +18,7 @@
 const file = (id, name, parents) => ({ id, name, mimeType: 'text/plain', parents, modifiedTime: '2026-08-21T00:00:00Z', size: '12' });
 
 describe('listFolderContents recursive traversal', () => {
-    it('keeps the omitted-depth request and {folders, files} response byte-for-byte compatible', async () => {
+    it('keeps depth-1 folders and files while reporting a complete single page', async () => {
         const list = jest.fn(async () => ({ data: { files: [
             { id: 'child', name: 'Child', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01' },
             { id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' },
@@ -30,10 +30,39 @@
         expect(result).toBe(JSON.stringify({
             folders: [{ id: 'child', name: 'Child', modifiedTime: '2026-01-01' }],
             files: [{ id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' }],
+            truncated: false,
         }, null, 2));
         expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "'ro\\'ot' in parents and trashed=false", pageSize: 50 }));
     });
 
+    it('reports depth-1 truncation when Drive returns another page', async () => {
+        const list = jest.fn(async () => ({ data: {
+            files: [file('first', 'first.txt', ['root-id'])],
+            nextPageToken: 'next-page',
+        } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'root-id', maxResults: 5, depth: 1 }, { log: noopLog }));
+
+        expect(result).toMatchObject({
+            folders: [],
+            files: [{ id: 'first', name: 'first.txt', mimeType: 'text/plain', modifiedTime: '2026-08-21T00:00:00Z' }],
+            truncated: true,
+        });
+        expect(result.truncationReason).toMatch(/maxResults \(5\).*maximum of 100.*depth.*maxItems/i);
+        expect(list).toHaveBeenCalledTimes(1);
+    });
+
+    it('distinguishes a genuinely empty depth-1 folder from a truncated listing', async () => {
+        const list = jest.fn(async () => ({ data: { files: [] } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'empty', depth: 1 }, { log: noopLog }));
+
+        expect(result).toEqual({ folders: [], files: [], truncated: false });
+        expect(result.truncationReason).toBeUndefined();
+    });
+
     it('validates recursive parameter combinations and boundaries', () => {
         const parameters = getTool().parameters;
         expect(parameters.safeParse({ folderId: 'x', depth: 0 }).success).toBe(false);

codex
The code and focused tests pass. Staging is blocked only because this linked worktree’s Git index lives in the parent repository metadata, outside the current write sandbox; I’m requesting access solely to stage these three files and run the mandated snapshot regeneration.
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' add -- 'dist/tools/drive/listFolderContents.js' 'tests/listFolderContents.test.js'; node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json > "'$null; git -c safe.directory='"'C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' add -- 'tests/fixtures/mcp-migration-inventory.json'; git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' diff --staged --check; git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' status --short" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
 succeeded in 1799ms:
M  dist/tools/drive/listFolderContents.js
M  tests/listFolderContents.test.js

diff --git a/dist/tools/drive/listFolderContents.js b/dist/tools/drive/listFolderContents.js
index 23ffaaf5e4ebe94ebf4a32005a910d0ebc838d3c..4ed9d7b5895d66612965adb171d4eb25a07dbbf9
--- a/dist/tools/drive/listFolderContents.js
+++ b/dist/tools/drive/listFolderContents.js
@@ -45,7 +45,7 @@
 export function register(server) {
     server.addTool({
         name: 'listFolderContents',
-        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns the legacy {folders, files} result. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the legacy depth-1 response. Use getFilePath for the inverse, upward path lookup.",
+        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns a single {folders, files, truncated, truncationReason?} page capped by maxResults; truncated reports when Drive has more pages. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the single depth-1 page. Use getFilePath for the inverse, upward path lookup.",
         parameters: z.object({
             folderId: z.string().describe('ID of the folder to list contents of. Use "root" for the root Drive folder.'),
             includeSubfolders: z.boolean().optional().default(true).describe('Whether to include subfolders in results.'),
@@ -66,20 +66,25 @@
                 const includeSubfolders = args.includeSubfolders ?? true;
                 const includeFiles = args.includeFiles ?? true;
                 const maxResults = args.maxResults ?? 50;
-                // Keep the legacy depth-1 request and response shape intact.
+                // Keep depth 1 to its established single Drive page. Its additive
+                // truncation signal lets callers distinguish that page from a full listing.
                 if (depth === 1) {
                     let queryString = `'${escapeDriveQueryValue(args.folderId)}' in parents and trashed=false`;
                     if (!includeSubfolders) queryString += ` and mimeType!='${FOLDER_MIME_TYPE}'`;
                     else if (!includeFiles) queryString += ` and mimeType='${FOLDER_MIME_TYPE}'`;
                     const response = await drive.files.list({
                         q: queryString, pageSize: maxResults, orderBy: 'folder,name',
-                        fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
+                        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
                         supportsAllDrives: true, includeItemsFromAllDrives: true,
                     });
                     const items = response.data.files || [];
                     const folders = items.filter((f) => f.mimeType === FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
                     const files = items.filter((f) => f.mimeType !== FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime }));
-                    return JSON.stringify({ folders, files }, null, 2);
+                    const truncated = Boolean(response.data.nextPageToken);
+                    const truncationReason = truncated
+                        ? `maxResults (${maxResults}) single-page cap reached; raise maxResults (up to the maximum of 100) or use depth with maxItems for a bounded recursive traversal.`
+                        : undefined;
+                    return JSON.stringify({ folders, files, truncated, ...(truncationReason ? { truncationReason } : {}) }, null, 2);
                 }
 
                 const maxItems = args.maxItems ?? 500;
diff --git a/tests/listFolderContents.test.js b/tests/listFolderContents.test.js
index 67f633d21ee43ac4bc7bf255d7125ed22030d69a..3a495284ba0546a695c6a9955ceb41c5486bb83a
--- a/tests/listFolderContents.test.js
+++ b/tests/listFolderContents.test.js
@@ -18,7 +18,7 @@
 const file = (id, name, parents) => ({ id, name, mimeType: 'text/plain', parents, modifiedTime: '2026-08-21T00:00:00Z', size: '12' });
 
 describe('listFolderContents recursive traversal', () => {
-    it('keeps the omitted-depth request and {folders, files} response byte-for-byte compatible', async () => {
+    it('keeps depth-1 folders and files while reporting a complete single page', async () => {
         const list = jest.fn(async () => ({ data: { files: [
             { id: 'child', name: 'Child', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01' },
             { id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' },
@@ -30,10 +30,39 @@
         expect(result).toBe(JSON.stringify({
             folders: [{ id: 'child', name: 'Child', modifiedTime: '2026-01-01' }],
             files: [{ id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' }],
+            truncated: false,
         }, null, 2));
         expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "'ro\\'ot' in parents and trashed=false", pageSize: 50 }));
     });
 
+    it('reports depth-1 truncation when Drive returns another page', async () => {
+        const list = jest.fn(async () => ({ data: {
+            files: [file('first', 'first.txt', ['root-id'])],
+            nextPageToken: 'next-page',
+        } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'root-id', maxResults: 5, depth: 1 }, { log: noopLog }));
+
+        expect(result).toMatchObject({
+            folders: [],
+            files: [{ id: 'first', name: 'first.txt', mimeType: 'text/plain', modifiedTime: '2026-08-21T00:00:00Z' }],
+            truncated: true,
+        });
+        expect(result.truncationReason).toMatch(/maxResults \(5\).*maximum of 100.*depth.*maxItems/i);
+        expect(list).toHaveBeenCalledTimes(1);
+    });
+
+    it('distinguishes a genuinely empty depth-1 folder from a truncated listing', async () => {
+        const list = jest.fn(async () => ({ data: { files: [] } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'empty', depth: 1 }, { log: noopLog }));
+
+        expect(result).toEqual({ folders: [], files: [], truncated: false });
+        expect(result.truncationReason).toBeUndefined();
+    });
+
     it('validates recursive parameter combinations and boundaries', () => {
         const parameters = getTool().parameters;
         expect(parameters.safeParse({ folderId: 'x', depth: 0 }).success).toBe(false);

exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' diff --staged -- 'dist/tools/drive/listFolderContents.js' 'tests/listFolderContents.test.js' 'tests/fixtures/mcp-migration-inventory.json'; git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' diff --staged --stat; git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' status --short" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
 succeeded in 106ms:
warning: unable to access 'C:\Users\2supe/.config/git/ignore': Permission denied
diff --git a/dist/tools/drive/listFolderContents.js b/dist/tools/drive/listFolderContents.js
index 23ffaaf..4ed9d7b 100644
--- a/dist/tools/drive/listFolderContents.js
+++ b/dist/tools/drive/listFolderContents.js
@@ -45,7 +45,7 @@ function isRateLimitStatus(error) {
 export function register(server) {
     server.addTool({
         name: 'listFolderContents',
-        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns the legacy {folders, files} result. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the legacy depth-1 response. Use getFilePath for the inverse, upward path lookup.",
+        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns a single {folders, files, truncated, truncationReason?} page capped by maxResults; truncated reports when Drive has more pages. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the single depth-1 page. Use getFilePath for the inverse, upward path lookup.",
         parameters: z.object({
             folderId: z.string().describe('ID of the folder to list contents of. Use "root" for the root Drive folder.'),
             includeSubfolders: z.boolean().optional().default(true).describe('Whether to include subfolders in results.'),
@@ -66,20 +66,25 @@ export function register(server) {
                 const includeSubfolders = args.includeSubfolders ?? true;
                 const includeFiles = args.includeFiles ?? true;
                 const maxResults = args.maxResults ?? 50;
-                // Keep the legacy depth-1 request and response shape intact.
+                // Keep depth 1 to its established single Drive page. Its additive
+                // truncation signal lets callers distinguish that page from a full listing.
                 if (depth === 1) {
                     let queryString = `'${escapeDriveQueryValue(args.folderId)}' in parents and trashed=false`;
                     if (!includeSubfolders) queryString += ` and mimeType!='${FOLDER_MIME_TYPE}'`;
                     else if (!includeFiles) queryString += ` and mimeType='${FOLDER_MIME_TYPE}'`;
                     const response = await drive.files.list({
                         q: queryString, pageSize: maxResults, orderBy: 'folder,name',
-                        fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
+                        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
                         supportsAllDrives: true, includeItemsFromAllDrives: true,
                     });
                     const items = response.data.files || [];
                     const folders = items.filter((f) => f.mimeType === FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
                     const files = items.filter((f) => f.mimeType !== FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime }));
-                    return JSON.stringify({ folders, files }, null, 2);
+                    const truncated = Boolean(response.data.nextPageToken);
+                    const truncationReason = truncated
+                        ? `maxResults (${maxResults}) single-page cap reached; raise maxResults (up to the maximum of 100) or use depth with maxItems for a bounded recursive traversal.`
+                        : undefined;
+                    return JSON.stringify({ folders, files, truncated, ...(truncationReason ? { truncationReason } : {}) }, null, 2);
                 }
 
                 const maxItems = args.maxItems ?? 500;
diff --git a/tests/listFolderContents.test.js b/tests/listFolderContents.test.js
index 67f633d..3a49528 100644
--- a/tests/listFolderContents.test.js
+++ b/tests/listFolderContents.test.js
@@ -18,7 +18,7 @@ const folder = (id, name, parents) => ({ id, name, mimeType: 'application/vnd.go
 const file = (id, name, parents) => ({ id, name, mimeType: 'text/plain', parents, modifiedTime: '2026-08-21T00:00:00Z', size: '12' });
 
 describe('listFolderContents recursive traversal', () => {
-    it('keeps the omitted-depth request and {folders, files} response byte-for-byte compatible', async () => {
+    it('keeps depth-1 folders and files while reporting a complete single page', async () => {
         const list = jest.fn(async () => ({ data: { files: [
             { id: 'child', name: 'Child', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01' },
             { id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' },
@@ -30,10 +30,39 @@ describe('listFolderContents recursive traversal', () => {
         expect(result).toBe(JSON.stringify({
             folders: [{ id: 'child', name: 'Child', modifiedTime: '2026-01-01' }],
             files: [{ id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' }],
+            truncated: false,
         }, null, 2));
         expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "'ro\\'ot' in parents and trashed=false", pageSize: 50 }));
     });
 
+    it('reports depth-1 truncation when Drive returns another page', async () => {
+        const list = jest.fn(async () => ({ data: {
+            files: [file('first', 'first.txt', ['root-id'])],
+            nextPageToken: 'next-page',
+        } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'root-id', maxResults: 5, depth: 1 }, { log: noopLog }));
+
+        expect(result).toMatchObject({
+            folders: [],
+            files: [{ id: 'first', name: 'first.txt', mimeType: 'text/plain', modifiedTime: '2026-08-21T00:00:00Z' }],
+            truncated: true,
+        });
+        expect(result.truncationReason).toMatch(/maxResults \(5\).*maximum of 100.*depth.*maxItems/i);
+        expect(list).toHaveBeenCalledTimes(1);
+    });
+
+    it('distinguishes a genuinely empty depth-1 folder from a truncated listing', async () => {
+        const list = jest.fn(async () => ({ data: { files: [] } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'empty', depth: 1 }, { log: noopLog }));
+
+        expect(result).toEqual({ folders: [], files: [], truncated: false });
+        expect(result.truncationReason).toBeUndefined();
+    });
+
     it('validates recursive parameter combinations and boundaries', () => {
         const parameters = getTool().parameters;
         expect(parameters.safeParse({ folderId: 'x', depth: 0 }).success).toBe(false);
warning: unable to access 'C:\Users\2supe/.config/git/ignore': Permission denied
 dist/tools/drive/listFolderContents.js | 13 +++++++++----
 tests/listFolderContents.test.js       | 31 ++++++++++++++++++++++++++++++-
 2 files changed, 39 insertions(+), 5 deletions(-)
warning: unable to access 'C:\Users\2supe/.config/git/ignore': Permission denied
warning: unable to access 'C:\Users\2supe/.config/git/ignore': Permission denied
M  dist/tools/drive/listFolderContents.js
M  tests/listFolderContents.test.js

exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'npm.cmd test' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
 succeeded in 11521ms:

> google-tools-mcp@2.0.0 test
> node --experimental-vm-modules node_modules/jest/bin/jest.js

(node:20972) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:20972) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
(node:1176) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:1176) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
(node:25920) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:25920) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
(node:13888) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:13888) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
(node:28300) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:28300) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
(node:25528) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:25528) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
(node:39268) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:39268) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
(node:38852) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:38852) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
(node:51472) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:51472) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
(node:52552) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:52552) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
(node:47224) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:47224) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
(node:16548) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:16548) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
(node:20824) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:20824) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
(node:54296) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:54296) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
(node:11100) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:11100) ExperimentalWarning: VM Modules is an experimental feature and might change at any time

Test Suites: 53 passed, 53 total
Tests:       2 skipped, 747 passed, 749 total
Snapshots:   0 total
Time:        10.55 s, estimated 11 s
Ran all test suites.

diff --git a/dist/tools/drive/listFolderContents.js b/dist/tools/drive/listFolderContents.js
index 23ffaaf5e4ebe94ebf4a32005a910d0ebc838d3c..4ed9d7b5895d66612965adb171d4eb25a07dbbf9
--- a/dist/tools/drive/listFolderContents.js
+++ b/dist/tools/drive/listFolderContents.js
@@ -45,7 +45,7 @@
 export function register(server) {
     server.addTool({
         name: 'listFolderContents',
-        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns the legacy {folders, files} result. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the legacy depth-1 response. Use getFilePath for the inverse, upward path lookup.",
+        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns a single {folders, files, truncated, truncationReason?} page capped by maxResults; truncated reports when Drive has more pages. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the single depth-1 page. Use getFilePath for the inverse, upward path lookup.",
         parameters: z.object({
             folderId: z.string().describe('ID of the folder to list contents of. Use "root" for the root Drive folder.'),
             includeSubfolders: z.boolean().optional().default(true).describe('Whether to include subfolders in results.'),
@@ -66,20 +66,25 @@
                 const includeSubfolders = args.includeSubfolders ?? true;
                 const includeFiles = args.includeFiles ?? true;
                 const maxResults = args.maxResults ?? 50;
-                // Keep the legacy depth-1 request and response shape intact.
+                // Keep depth 1 to its established single Drive page. Its additive
+                // truncation signal lets callers distinguish that page from a full listing.
                 if (depth === 1) {
                     let queryString = `'${escapeDriveQueryValue(args.folderId)}' in parents and trashed=false`;
                     if (!includeSubfolders) queryString += ` and mimeType!='${FOLDER_MIME_TYPE}'`;
                     else if (!includeFiles) queryString += ` and mimeType='${FOLDER_MIME_TYPE}'`;
                     const response = await drive.files.list({
                         q: queryString, pageSize: maxResults, orderBy: 'folder,name',
-                        fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
+                        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
                         supportsAllDrives: true, includeItemsFromAllDrives: true,
                     });
                     const items = response.data.files || [];
                     const folders = items.filter((f) => f.mimeType === FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
                     const files = items.filter((f) => f.mimeType !== FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime }));
-                    return JSON.stringify({ folders, files }, null, 2);
+                    const truncated = Boolean(response.data.nextPageToken);
+                    const truncationReason = truncated
+                        ? `maxResults (${maxResults}) single-page cap reached; raise maxResults (up to the maximum of 100) or use depth with maxItems for a bounded recursive traversal.`
+                        : undefined;
+                    return JSON.stringify({ folders, files, truncated, ...(truncationReason ? { truncationReason } : {}) }, null, 2);
                 }
 
                 const maxItems = args.maxItems ?? 500;
diff --git a/tests/listFolderContents.test.js b/tests/listFolderContents.test.js
index 67f633d21ee43ac4bc7bf255d7125ed22030d69a..3a495284ba0546a695c6a9955ceb41c5486bb83a
--- a/tests/listFolderContents.test.js
+++ b/tests/listFolderContents.test.js
@@ -18,7 +18,7 @@
 const file = (id, name, parents) => ({ id, name, mimeType: 'text/plain', parents, modifiedTime: '2026-08-21T00:00:00Z', size: '12' });
 
 describe('listFolderContents recursive traversal', () => {
-    it('keeps the omitted-depth request and {folders, files} response byte-for-byte compatible', async () => {
+    it('keeps depth-1 folders and files while reporting a complete single page', async () => {
         const list = jest.fn(async () => ({ data: { files: [
             { id: 'child', name: 'Child', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01' },
             { id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' },
@@ -30,10 +30,39 @@
         expect(result).toBe(JSON.stringify({
             folders: [{ id: 'child', name: 'Child', modifiedTime: '2026-01-01' }],
             files: [{ id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' }],
+            truncated: false,
         }, null, 2));
         expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "'ro\\'ot' in parents and trashed=false", pageSize: 50 }));
     });
 
+    it('reports depth-1 truncation when Drive returns another page', async () => {
+        const list = jest.fn(async () => ({ data: {
+            files: [file('first', 'first.txt', ['root-id'])],
+            nextPageToken: 'next-page',
+        } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'root-id', maxResults: 5, depth: 1 }, { log: noopLog }));
+
+        expect(result).toMatchObject({
+            folders: [],
+            files: [{ id: 'first', name: 'first.txt', mimeType: 'text/plain', modifiedTime: '2026-08-21T00:00:00Z' }],
+            truncated: true,
+        });
+        expect(result.truncationReason).toMatch(/maxResults \(5\).*maximum of 100.*depth.*maxItems/i);
+        expect(list).toHaveBeenCalledTimes(1);
+    });
+
+    it('distinguishes a genuinely empty depth-1 folder from a truncated listing', async () => {
+        const list = jest.fn(async () => ({ data: { files: [] } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'empty', depth: 1 }, { log: noopLog }));
+
+        expect(result).toEqual({ folders: [], files: [], truncated: false });
+        expect(result.truncationReason).toBeUndefined();
+    });
+
     it('validates recursive parameter combinations and boundaries', () => {
         const parameters = getTool().parameters;
         expect(parameters.safeParse({ folderId: 'x', depth: 0 }).success).toBe(false);

codex
Validation is clean: the focused regression suite passes, and the full `npm test` run reports `Test Suites: 53 passed, 53 total`. The required inventory regeneration was run after staging; it produced no snapshot diff because the inventory does not encode this description/result-shape change. I’m committing the verified two-file fix locally now, with no push.
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' commit -m \"Report depth-1 Drive listing truncation (#126)\" -m \"Depth-1 listFolderContents intentionally fetches one page for legacy quota pacing, but it previously discarded nextPageToken and returned a partial folders/files response that was indistinguishable from a complete or empty folder. The response now adds truncated on every depth-1 result and a concrete truncationReason when Drive has another page, while preserving the folders and files fields, order, and one-call behavior.\\n\\nThe depth-1 request now asks Drive for nextPageToken. Its description documents the single-page maxResults cap and the truncation signal. Regression coverage proves the prior implementation fails for a next-page response, a complete page, and a genuinely empty folder; the full Jest suite passes after the fix.\"" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
 succeeded in 103ms:
[feat/independents b1b23a2] Report depth-1 Drive listing truncation (#126)
 2 files changed, 39 insertions(+), 5 deletions(-)

diff --git a/dist/tools/drive/listFolderContents.js b/dist/tools/drive/listFolderContents.js
index 23ffaaf5e4ebe94ebf4a32005a910d0ebc838d3c..4ed9d7b5895d66612965adb171d4eb25a07dbbf9
--- a/dist/tools/drive/listFolderContents.js
+++ b/dist/tools/drive/listFolderContents.js
@@ -45,7 +45,7 @@
 export function register(server) {
     server.addTool({
         name: 'listFolderContents',
-        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns the legacy {folders, files} result. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the legacy depth-1 response. Use getFilePath for the inverse, upward path lookup.",
+        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns a single {folders, files, truncated, truncationReason?} page capped by maxResults; truncated reports when Drive has more pages. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the single depth-1 page. Use getFilePath for the inverse, upward path lookup.",
         parameters: z.object({
             folderId: z.string().describe('ID of the folder to list contents of. Use "root" for the root Drive folder.'),
             includeSubfolders: z.boolean().optional().default(true).describe('Whether to include subfolders in results.'),
@@ -66,20 +66,25 @@
                 const includeSubfolders = args.includeSubfolders ?? true;
                 const includeFiles = args.includeFiles ?? true;
                 const maxResults = args.maxResults ?? 50;
-                // Keep the legacy depth-1 request and response shape intact.
+                // Keep depth 1 to its established single Drive page. Its additive
+                // truncation signal lets callers distinguish that page from a full listing.
                 if (depth === 1) {
                     let queryString = `'${escapeDriveQueryValue(args.folderId)}' in parents and trashed=false`;
                     if (!includeSubfolders) queryString += ` and mimeType!='${FOLDER_MIME_TYPE}'`;
                     else if (!includeFiles) queryString += ` and mimeType='${FOLDER_MIME_TYPE}'`;
                     const response = await drive.files.list({
                         q: queryString, pageSize: maxResults, orderBy: 'folder,name',
-                        fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
+                        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
                         supportsAllDrives: true, includeItemsFromAllDrives: true,
                     });
                     const items = response.data.files || [];
                     const folders = items.filter((f) => f.mimeType === FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
                     const files = items.filter((f) => f.mimeType !== FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime }));
-                    return JSON.stringify({ folders, files }, null, 2);
+                    const truncated = Boolean(response.data.nextPageToken);
+                    const truncationReason = truncated
+                        ? `maxResults (${maxResults}) single-page cap reached; raise maxResults (up to the maximum of 100) or use depth with maxItems for a bounded recursive traversal.`
+                        : undefined;
+                    return JSON.stringify({ folders, files, truncated, ...(truncationReason ? { truncationReason } : {}) }, null, 2);
                 }
 
                 const maxItems = args.maxItems ?? 500;
diff --git a/tests/listFolderContents.test.js b/tests/listFolderContents.test.js
index 67f633d21ee43ac4bc7bf255d7125ed22030d69a..3a495284ba0546a695c6a9955ceb41c5486bb83a
--- a/tests/listFolderContents.test.js
+++ b/tests/listFolderContents.test.js
@@ -18,7 +18,7 @@
 const file = (id, name, parents) => ({ id, name, mimeType: 'text/plain', parents, modifiedTime: '2026-08-21T00:00:00Z', size: '12' });
 
 describe('listFolderContents recursive traversal', () => {
-    it('keeps the omitted-depth request and {folders, files} response byte-for-byte compatible', async () => {
+    it('keeps depth-1 folders and files while reporting a complete single page', async () => {
         const list = jest.fn(async () => ({ data: { files: [
             { id: 'child', name: 'Child', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01' },
             { id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' },
@@ -30,10 +30,39 @@
         expect(result).toBe(JSON.stringify({
             folders: [{ id: 'child', name: 'Child', modifiedTime: '2026-01-01' }],
             files: [{ id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' }],
+            truncated: false,
         }, null, 2));
         expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "'ro\\'ot' in parents and trashed=false", pageSize: 50 }));
     });
 
+    it('reports depth-1 truncation when Drive returns another page', async () => {
+        const list = jest.fn(async () => ({ data: {
+            files: [file('first', 'first.txt', ['root-id'])],
+            nextPageToken: 'next-page',
+        } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'root-id', maxResults: 5, depth: 1 }, { log: noopLog }));
+
+        expect(result).toMatchObject({
+            folders: [],
+            files: [{ id: 'first', name: 'first.txt', mimeType: 'text/plain', modifiedTime: '2026-08-21T00:00:00Z' }],
+            truncated: true,
+        });
+        expect(result.truncationReason).toMatch(/maxResults \(5\).*maximum of 100.*depth.*maxItems/i);
+        expect(list).toHaveBeenCalledTimes(1);
+    });
+
+    it('distinguishes a genuinely empty depth-1 folder from a truncated listing', async () => {
+        const list = jest.fn(async () => ({ data: { files: [] } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'empty', depth: 1 }, { log: noopLog }));
+
+        expect(result).toEqual({ folders: [], files: [], truncated: false });
+        expect(result.truncationReason).toBeUndefined();
+    });
+
     it('validates recursive parameter combinations and boundaries', () => {
         const parameters = getTool().parameters;
         expect(parameters.safeParse({ folderId: 'x', depth: 0 }).success).toBe(false);

exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' status --short; git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE' log -1 --format='%H%n%s'" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-prE
 succeeded in 87ms:
warning: unable to access 'C:\Users\2supe/.config/git/ignore': Permission denied
warning: unable to access 'C:\Users\2supe/.config/git/ignore': Permission denied
b1b23a26c0be18e34dee69f99b0fae268c5bc7a7
Report depth-1 Drive listing truncation (#126)

diff --git a/dist/tools/drive/listFolderContents.js b/dist/tools/drive/listFolderContents.js
index 23ffaaf5e4ebe94ebf4a32005a910d0ebc838d3c..4ed9d7b5895d66612965adb171d4eb25a07dbbf9
--- a/dist/tools/drive/listFolderContents.js
+++ b/dist/tools/drive/listFolderContents.js
@@ -45,7 +45,7 @@
 export function register(server) {
     server.addTool({
         name: 'listFolderContents',
-        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns the legacy {folders, files} result. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the legacy depth-1 response. Use getFilePath for the inverse, upward path lookup.",
+        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns a single {folders, files, truncated, truncationReason?} page capped by maxResults; truncated reports when Drive has more pages. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the single depth-1 page. Use getFilePath for the inverse, upward path lookup.",
         parameters: z.object({
             folderId: z.string().describe('ID of the folder to list contents of. Use "root" for the root Drive folder.'),
             includeSubfolders: z.boolean().optional().default(true).describe('Whether to include subfolders in results.'),
@@ -66,20 +66,25 @@
                 const includeSubfolders = args.includeSubfolders ?? true;
                 const includeFiles = args.includeFiles ?? true;
                 const maxResults = args.maxResults ?? 50;
-                // Keep the legacy depth-1 request and response shape intact.
+                // Keep depth 1 to its established single Drive page. Its additive
+                // truncation signal lets callers distinguish that page from a full listing.
                 if (depth === 1) {
                     let queryString = `'${escapeDriveQueryValue(args.folderId)}' in parents and trashed=false`;
                     if (!includeSubfolders) queryString += ` and mimeType!='${FOLDER_MIME_TYPE}'`;
                     else if (!includeFiles) queryString += ` and mimeType='${FOLDER_MIME_TYPE}'`;
                     const response = await drive.files.list({
                         q: queryString, pageSize: maxResults, orderBy: 'folder,name',
-                        fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
+                        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
                         supportsAllDrives: true, includeItemsFromAllDrives: true,
                     });
                     const items = response.data.files || [];
                     const folders = items.filter((f) => f.mimeType === FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
                     const files = items.filter((f) => f.mimeType !== FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime }));
-                    return JSON.stringify({ folders, files }, null, 2);
+                    const truncated = Boolean(response.data.nextPageToken);
+                    const truncationReason = truncated
+                        ? `maxResults (${maxResults}) single-page cap reached; raise maxResults (up to the maximum of 100) or use depth with maxItems for a bounded recursive traversal.`
+                        : undefined;
+                    return JSON.stringify({ folders, files, truncated, ...(truncationReason ? { truncationReason } : {}) }, null, 2);
                 }
 
                 const maxItems = args.maxItems ?? 500;
diff --git a/tests/listFolderContents.test.js b/tests/listFolderContents.test.js
index 67f633d21ee43ac4bc7bf255d7125ed22030d69a..3a495284ba0546a695c6a9955ceb41c5486bb83a
--- a/tests/listFolderContents.test.js
+++ b/tests/listFolderContents.test.js
@@ -18,7 +18,7 @@
 const file = (id, name, parents) => ({ id, name, mimeType: 'text/plain', parents, modifiedTime: '2026-08-21T00:00:00Z', size: '12' });
 
 describe('listFolderContents recursive traversal', () => {
-    it('keeps the omitted-depth request and {folders, files} response byte-for-byte compatible', async () => {
+    it('keeps depth-1 folders and files while reporting a complete single page', async () => {
         const list = jest.fn(async () => ({ data: { files: [
             { id: 'child', name: 'Child', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01' },
             { id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' },
@@ -30,10 +30,39 @@
         expect(result).toBe(JSON.stringify({
             folders: [{ id: 'child', name: 'Child', modifiedTime: '2026-01-01' }],
             files: [{ id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' }],
+            truncated: false,
         }, null, 2));
         expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "'ro\\'ot' in parents and trashed=false", pageSize: 50 }));
     });
 
+    it('reports depth-1 truncation when Drive returns another page', async () => {
+        const list = jest.fn(async () => ({ data: {
+            files: [file('first', 'first.txt', ['root-id'])],
+            nextPageToken: 'next-page',
+        } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'root-id', maxResults: 5, depth: 1 }, { log: noopLog }));
+
+        expect(result).toMatchObject({
+            folders: [],
+            files: [{ id: 'first', name: 'first.txt', mimeType: 'text/plain', modifiedTime: '2026-08-21T00:00:00Z' }],
+            truncated: true,
+        });
+        expect(result.truncationReason).toMatch(/maxResults \(5\).*maximum of 100.*depth.*maxItems/i);
+        expect(list).toHaveBeenCalledTimes(1);
+    });
+
+    it('distinguishes a genuinely empty depth-1 folder from a truncated listing', async () => {
+        const list = jest.fn(async () => ({ data: { files: [] } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'empty', depth: 1 }, { log: noopLog }));
+
+        expect(result).toEqual({ folders: [], files: [], truncated: false });
+        expect(result.truncationReason).toBeUndefined();
+    });
+
     it('validates recursive parameter combinations and boundaries', () => {
         const parameters = getTool().parameters;
         expect(parameters.safeParse({ folderId: 'x', depth: 0 }).success).toBe(false);

codex
## Fixed

FIXED `b1b23a26c0be18e34dee69f99b0fae268c5bc7a7` on `feat/independents`. No push or GitHub action.

Changed [listFolderContents.js](C:/Users/2supe/All%20Coding/Google-Tools-MCP/google-tools-mcp-prE/dist/tools/drive/listFolderContents.js) and its [tests](C:/Users/2supe/All%20Coding/Google-Tools-MCP/google-tools-mcp-prE/tests/listFolderContents.test.js). Depth 1 remains one API page and preserves `folders`/`files` ordering; it now reports truncation additively.

---

## Regression outputs

| Case | Before | After |
|---|---|---|
| Drive returns `nextPageToken` | `{"folders":[],"files":[…]}` | `{"folders":[],"files":[…],"truncated":true,"truncationReason":"maxResults (5) single-page cap reached; raise maxResults (up to the maximum of 100) or use depth with maxItems for a bounded recursive traversal."}` |
| No `nextPageToken` | `{"folders":[…],"files":[…]}` | Same folders/files, plus `"truncated": false`; no `truncationReason` |
| Empty folder | `{"folders":[],"files":[]}` | `{"folders":[],"files":[],"truncated":false}` |

The new tests failed before the runtime change: `Test Suites: 1 failed, 1 total`, with all three new depth-1 assertions failing. They pass after it.

---

## Description and verification

Updated `.describe()` text:

> With depth omitted or 1, returns a single `{folders, files, truncated, truncationReason?}` page capped by maxResults; truncated reports when Drive has more pages.

Ran the required inventory snapshot regeneration after staging; it produced no snapshot diff. Full verification:

`Test Suites: 53 passed, 53 total`  
`Tests: 2 skipped, 747 passed, 749 total`

Working tree is clean.


diff --git a/dist/tools/drive/listFolderContents.js b/dist/tools/drive/listFolderContents.js
index 23ffaaf5e4ebe94ebf4a32005a910d0ebc838d3c..4ed9d7b5895d66612965adb171d4eb25a07dbbf9
--- a/dist/tools/drive/listFolderContents.js
+++ b/dist/tools/drive/listFolderContents.js
@@ -45,7 +45,7 @@
 export function register(server) {
     server.addTool({
         name: 'listFolderContents',
-        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns the legacy {folders, files} result. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the legacy depth-1 response. Use getFilePath for the inverse, upward path lookup.",
+        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns a single {folders, files, truncated, truncationReason?} page capped by maxResults; truncated reports when Drive has more pages. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the single depth-1 page. Use getFilePath for the inverse, upward path lookup.",
         parameters: z.object({
             folderId: z.string().describe('ID of the folder to list contents of. Use "root" for the root Drive folder.'),
             includeSubfolders: z.boolean().optional().default(true).describe('Whether to include subfolders in results.'),
@@ -66,20 +66,25 @@
                 const includeSubfolders = args.includeSubfolders ?? true;
                 const includeFiles = args.includeFiles ?? true;
                 const maxResults = args.maxResults ?? 50;
-                // Keep the legacy depth-1 request and response shape intact.
+                // Keep depth 1 to its established single Drive page. Its additive
+                // truncation signal lets callers distinguish that page from a full listing.
                 if (depth === 1) {
                     let queryString = `'${escapeDriveQueryValue(args.folderId)}' in parents and trashed=false`;
                     if (!includeSubfolders) queryString += ` and mimeType!='${FOLDER_MIME_TYPE}'`;
                     else if (!includeFiles) queryString += ` and mimeType='${FOLDER_MIME_TYPE}'`;
                     const response = await drive.files.list({
                         q: queryString, pageSize: maxResults, orderBy: 'folder,name',
-                        fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
+                        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
                         supportsAllDrives: true, includeItemsFromAllDrives: true,
                     });
                     const items = response.data.files || [];
                     const folders = items.filter((f) => f.mimeType === FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
                     const files = items.filter((f) => f.mimeType !== FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime }));
-                    return JSON.stringify({ folders, files }, null, 2);
+                    const truncated = Boolean(response.data.nextPageToken);
+                    const truncationReason = truncated
+                        ? `maxResults (${maxResults}) single-page cap reached; raise maxResults (up to the maximum of 100) or use depth with maxItems for a bounded recursive traversal.`
+                        : undefined;
+                    return JSON.stringify({ folders, files, truncated, ...(truncationReason ? { truncationReason } : {}) }, null, 2);
                 }
 
                 const maxItems = args.maxItems ?? 500;
diff --git a/tests/listFolderContents.test.js b/tests/listFolderContents.test.js
index 67f633d21ee43ac4bc7bf255d7125ed22030d69a..3a495284ba0546a695c6a9955ceb41c5486bb83a
--- a/tests/listFolderContents.test.js
+++ b/tests/listFolderContents.test.js
@@ -18,7 +18,7 @@
 const file = (id, name, parents) => ({ id, name, mimeType: 'text/plain', parents, modifiedTime: '2026-08-21T00:00:00Z', size: '12' });
 
 describe('listFolderContents recursive traversal', () => {
-    it('keeps the omitted-depth request and {folders, files} response byte-for-byte compatible', async () => {
+    it('keeps depth-1 folders and files while reporting a complete single page', async () => {
         const list = jest.fn(async () => ({ data: { files: [
             { id: 'child', name: 'Child', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01' },
             { id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' },
@@ -30,10 +30,39 @@
         expect(result).toBe(JSON.stringify({
             folders: [{ id: 'child', name: 'Child', modifiedTime: '2026-01-01' }],
             files: [{ id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' }],
+            truncated: false,
         }, null, 2));
         expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "'ro\\'ot' in parents and trashed=false", pageSize: 50 }));
     });
 
+    it('reports depth-1 truncation when Drive returns another page', async () => {
+        const list = jest.fn(async () => ({ data: {
+            files: [file('first', 'first.txt', ['root-id'])],
+            nextPageToken: 'next-page',
+        } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'root-id', maxResults: 5, depth: 1 }, { log: noopLog }));
+
+        expect(result).toMatchObject({
+            folders: [],
+            files: [{ id: 'first', name: 'first.txt', mimeType: 'text/plain', modifiedTime: '2026-08-21T00:00:00Z' }],
+            truncated: true,
+        });
+        expect(result.truncationReason).toMatch(/maxResults \(5\).*maximum of 100.*depth.*maxItems/i);
+        expect(list).toHaveBeenCalledTimes(1);
+    });
+
+    it('distinguishes a genuinely empty depth-1 folder from a truncated listing', async () => {
+        const list = jest.fn(async () => ({ data: { files: [] } }));
+        fakeDrive = { files: { list, get: jest.fn() } };
+
+        const result = JSON.parse(await getTool().execute({ folderId: 'empty', depth: 1 }, { log: noopLog }));
+
+        expect(result).toEqual({ folders: [], files: [], truncated: false });
+        expect(result.truncationReason).toBeUndefined();
+    });
+
     it('validates recursive parameter combinations and boundaries', () => {
         const parameters = getTool().parameters;
         expect(parameters.safeParse({ folderId: 'x', depth: 0 }).success).toBe(false);

2026-08-30T13:12:01.209379Z ERROR rmcp::transport::streamable_http_client: fail to delete session: Auth error: OAuth token refresh failed: Failed to parse server response session_id="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjI3ZDgxZmQxLWVkMzUtNGVjZi1iZjcyLTliOTc4ZTg4ODBlYiIsImNsaWVudEluZm8iOnsibmFtZSI6ImNvZGV4LW1jcC1jbGllbnQiLCJ0aXRsZSI6IkNvZGV4IiwidmVyc2lvbiI6IjAuMTUxLjAifSwiY2xpZW50Q2FwYWJpbGl0aWVzIjp7ImVsaWNpdGF0aW9uIjp7ImZvcm0iOnt9LCJ1cmwiOnt9fX0sImlhdCI6MTc4ODA5NTI5OH0.KGL-_OJ8UPPnBqGw51gTl_ycSfYa0xjOupOCxvpeHvE"
tokens used
64,014
## Fixed

FIXED `b1b23a26c0be18e34dee69f99b0fae268c5bc7a7` on `feat/independents`. No push or GitHub action.

Changed [listFolderContents.js](C:/Users/2supe/All%20Coding/Google-Tools-MCP/google-tools-mcp-prE/dist/tools/drive/listFolderContents.js) and its [tests](C:/Users/2supe/All%20Coding/Google-Tools-MCP/google-tools-mcp-prE/tests/listFolderContents.test.js). Depth 1 remains one API page and preserves `folders`/`files` ordering; it now reports truncation additively.

---

## Regression outputs

| Case | Before | After |
|---|---|---|
| Drive returns `nextPageToken` | `{"folders":[],"files":[…]}` | `{"folders":[],"files":[…],"truncated":true,"truncationReason":"maxResults (5) single-page cap reached; raise maxResults (up to the maximum of 100) or use depth with maxItems for a bounded recursive traversal."}` |
| No `nextPageToken` | `{"folders":[…],"files":[…]}` | Same folders/files, plus `"truncated": false`; no `truncationReason` |
| Empty folder | `{"folders":[],"files":[]}` | `{"folders":[],"files":[],"truncated":false}` |

The new tests failed before the runtime change: `Test Suites: 1 failed, 1 total`, with all three new depth-1 assertions failing. They pass after it.

---

## Description and verification

Updated `.describe()` text:

> With depth omitted or 1, returns a single `{folders, files, truncated, truncationReason?}` page capped by maxResults; truncated reports when Drive has more pages.

Ran the required inventory snapshot regeneration after staging; it produced no snapshot diff. Full verification:

`Test Suites: 53 passed, 53 total`  
`Tests: 2 skipped, 747 passed, 749 total`

Working tree is clean.


