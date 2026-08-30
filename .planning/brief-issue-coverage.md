# Decide, with evidence, which open issues the five PRs actually close

Work from `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp` (branch `main`).
You have network; use `gh`. **Do not modify any file except the single report you are asked to
write. Do not commit. Do not push. Do not comment on GitHub. Do not edit any PR body.**
Your entire output is a report I will act on.

## The problem

The repo has 32 open issues. Five open PRs stack on each other and are about to be merged for a
3.0 release. I extracted every `Closes #N` / `Fixes #N` / `Resolves #N` line from the PR bodies:

- PR #110: 14, 86, 88, 105, 108, 117, 118, 119, 120, 121, 122, 123
- PR #111: 73, 116
- PR #112: 75, 114
- PR #113: 99, 115, 124
- PR #109: none
- PR #127: none

Nine open issues are **mentioned** in a PR body but carry no closing keyword, so merging will
leave them open even though work was done for them:

| Issue | Mentioned in | Title |
|---|---|---|
| #48 | PR #112 | Master: make setup/update idempotent and able to repair existing client configs |
| #56 | PR #113 | Master: close high-risk test and package blind spots |
| #74 | PR #111 | Master: Gmail maintenance cleanup (dead modules, duplicate dispatch, parameter docs) |
| #82 | PR #112 | Master: load shared machine configuration before startup and use it across MCP clients |
| #87 | PR #109, #110 | Master: correct Docs read/write state and isolate working copies |
| #91 | PR #112 | Master: make diagnostics actionable |
| #96 | PR #110 | readDocument has no plainMarkdown option |
| #106 | PR #109, #110 | readDocument's local working-copy file is silently rewritten between calls |
| #107 | PR #110 | No safe way to rewrite one section of a Doc |

Several are "Master:" umbrella issues with multiple sub-requirements. Some may be fully done, some
may be deliberately partial. **I do not want a guess. I want a verdict per issue backed by
evidence.**

## What to do, per issue

1. Read the issue body in full: `gh issue view <n> --json title,body -q '.title,.body'`.
2. Enumerate its concrete, checkable requirements. Umbrella issues usually list several; treat each
   as a separate line item.
3. For each requirement, find the code that satisfies it, or establish that nothing does. The
   branches are checked out as sibling worktrees, all read-only to you:
   - `../google-tools-mcp-pr109` — `docs/mcp-plan-client-evidence` (PR #109)
   - `../google-tools-mcp-prB` — `feat/docs-cluster` (PR #110)
   - `../google-tools-mcp-prC` — `feat/gmail-cluster` (PR #111)
   - `../google-tools-mcp-prD` — `feat/ops-cluster` (PR #112)
   - `../google-tools-mcp-prE` — `feat/independents` (PR #113)
   Cite `file:line`. **Read the code.** Do not conclude from a filename, a commit message, a PR
   body claim, or a test name. A PR body saying it did something is exactly the claim you are
   checking, so it is not evidence.
4. Give the issue one verdict:
   - **CLOSES** — every requirement is met on that branch. Say which branch.
   - **PARTIAL** — some met, some not. List precisely what remains, with the requirement text.
   - **NOT ADDRESSED** — the mention is incidental.

## Two live-verified data points to reconcile against

A live smoke harness runs each issue's literal reproduction against the real Google APIs. As of
the latest run on a build containing every fix:

- **#106** — the live repro now **passes**.
- **#107** — the live repro now **passes**, though note its scenario was corrected during
  calibration: it had been passing `range` where the tool's parameter is `target`, so it was
  failing zod validation before reaching product code.

If your code reading disagrees with either of those, say so loudly and show your reasoning. A
disagreement between the live result and the code is the most valuable thing you could find here,
so do not smooth it over.

## Also check the reverse direction

Of the issues that DO have closing keywords, flag any where you believe the claim is wrong, that
is, the PR says `Closes #N` but the work looks incomplete. Same evidence standard. I would rather
hear about one of these than have GitHub auto-close an issue that is not actually fixed.

## Report

Write to `.planning/issue-coverage-verdicts.md`. That is the only file you may create or modify.

Structure it as one section per issue: the verdict, the requirement-by-requirement table with
`file:line` evidence, and for PARTIAL the exact remaining work. End with two lists:

1. `Closes #N` lines that should be **added** to each PR body, ready for me to paste.
2. Issues that must stay open after 3.0, each with a one-line reason.

Be blunt about uncertainty. "I could not determine X because Y" is a useful answer. A confident
wrong verdict here causes a real issue to be auto-closed and forgotten, which is worse than
saying you do not know.
