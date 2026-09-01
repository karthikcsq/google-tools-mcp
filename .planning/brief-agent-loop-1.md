# Mission brief: be the agent, and tell us where these tools hurt

You are standing in for a future AI agent that has this MCP server connected and
has been asked to get real work done with it. You have never seen this codebase.
Keep it that way, on purpose. See "The one hard rule" below.

Work in `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp` on branch
`main`. Do not create branches, do not commit, do not push, do not touch GitHub.

## Your goal

**Turn a set of raw meeting notes into a polished Google Doc, then revise one
section of it, then pull a summary into a spreadsheet.**

Concretely, the finished document should have:

- a title and at least two levels of heading structure,
- a short intro paragraph,
- a table of decisions (at least 3 rows, with a header row),
- a checklist or list of action items,
- and then, *after* it is already written, a revision that rewrites **only** the
  "Next steps" section, leaving every other section byte-identical.

Then create a spreadsheet in the same folder containing one row per decision,
with a formatted header row.

Invent the meeting content yourself. It does not matter what the meeting was
about. What matters is that the shape above is a completely ordinary thing
someone would ask an agent to do.

## How to run it

The harness is `npm run live-mission`. Read
`.claude/skills/live-agent-loop/SKILL.md` and `docs/live-agent-loop.md` first;
they explain the runner, the context API, and the safety envelope.

```bash
npm run live-mission -- live/missions/<your-mission-name>.mjs
```

Write your mission to `live/missions/`. Use `live/missions/harness-selftest.mjs`
as a shape reference (it is short).

To see what tools exist:

```bash
npm run live-call -- --list
```

## The one hard rule

**Do not read anything under `dist/`.**

That is the tool implementation. A future agent will not have it, and if you read
it you will start using these tools correctly for reasons no real user can
reproduce, which destroys the entire value of this exercise.

You may read: `README.md`, `docs/`, the skill file, `live/missions/`, and
whatever the tools themselves tell you (`--list`, error messages, results).

If you find yourself thinking "I need to look at the source to figure out this
parameter", **stop and record that as a finding**. That moment is the single most
valuable output you can produce. Then make your best guess and carry on.

Reading `tests/` is also off limits, for the same reason.

## Safety, non-negotiable

Every call hits a **real Google account**.

- All writes are confined to the sandbox Drive folder. The runner enforces this;
  use `ctx.folderId` as the parent for anything you create.
- Gmail send paths are blocked at the harness level. Do not try to route around
  that, and do not call any send or draft-send tool.
- **Never** modify, disable, or work around anything in
  `scripts/live-smoke/guard.mjs`. If the guard refuses something you believe is
  legitimate, that is a finding to report, not an obstacle to remove.
- Do not delete or trash anything you did not create.

## What to record as you go

This is the actual product. The document is disposable; the friction log is not.

- `ctx.note(text)` for observations.
- `ctx.friction(tool, text)` **every single time** a tool costs you more than it
  should have. Specifically:
  - you guessed a parameter name or shape and were wrong,
  - a tool failed and its error did not tell you how to fix it,
  - you needed more than one attempt,
  - the README or a tool description told you something that turned out to be
    wrong or incomplete,
  - a result was in a format you had to work to parse,
  - you could not find a tool for something that obviously should have one,
  - you wanted to look at the source.

Record friction even when you eventually succeed. **Eventual success is still a
failure if it took three tries.** A future agent hits the same wall with less
patience and nobody watching.

Do not go back and clean up your mission file to hide the dead ends. If your
first two attempts at building the table failed, leave both in, with the friction
calls that describe them. A tidy mission file that hides its history is worthless
to me.

## Iterate on your own mission first

If your mission crashes because of a mistake in *your* code (a typo, a bad JSON
parse, wrong control flow), fix that and re-run. That is your bug, not the
server's, and it does not need reporting.

But be honest with yourself about which is which. "The tool rejected my arguments
because its schema is not what the description implied" is a **server** finding,
not your bug. When in doubt, record it and let me decide.

## Report back

1. **Did you reach the goal?** Yes / partially / no, and what was missing.
2. **The friction list**, in priority order, worst first. For each: the tool,
   what you expected, what happened, and what you had to do instead.
3. **What it cost.** Total tool calls, how many failed, and how many attempts the
   hardest step took.
4. **Anything you wanted a tool for and could not find.**
5. **Would you, as an agent, use these tools again unassisted?** Answer honestly.
   A "no" or "only for the simple parts" is a far more useful answer than a
   reflexive yes.
6. The path of the report JSON the runner wrote, and the mission file path.

Do not soften the report. I am going to fix whatever you find, and a report that
tells me everything went fine when it did not is worse than no report.
