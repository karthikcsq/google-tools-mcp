# Recalibrate two live-smoke scenarios that fail for their own reasons, not the product's

Work only in the worktree `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-smoke`,
branch `feat/live-smoke`. Commit as you go. Do not push. Do not post to GitHub.

## Context

This branch holds a live smoke harness: `scripts/live-smoke.mjs` plus one scenario per filed
GitHub issue under `live/<cluster>/`, each replicating the reporter's literal steps against
real Google APIs. Each scenario declares `expectedOnBase`, meaning what it should do on THIS
branch, which is cut from `docs/mcp-plan-client-evidence` and therefore has none of the
fixes.

The scenarios were validated by running them against a branch that DOES contain every fix.
Ten flipped from fail to pass, which is the intended behaviour. Two failed there for reasons
that have nothing to do with the product. Those two are wrong and need fixing.

You cannot run against the fixed build from here. Reason from the evidence below and from
reading the tool source in this worktree's `dist/`.

## Scenario 1: `live/docs/issue-107-section-scoped-rewrite.mjs` uses the wrong parameter name

It calls `replaceRangeWithMarkdown` like this:

```js
{ documentId, markdown, range: { afterHeading: 'To Do List', untilNextHeadingOfLevel: 2 } }
```

The tool's parameter is **`target`**, not `range`. The call fails zod validation with
`invalid_union` on path `["target"]` before reaching any product code, so the scenario proves
nothing. Confirmed by parsing the schema directly.

Fix the call. While you are there, note in the scenario's file header that the tool's own
`.describe()` text calls it "The range to replace", which is very likely what misled whoever
wrote this, and that the mismatch between the prose name and the parameter name is worth
raising separately. Do not change the tool, which lives on another branch.

Note also that `replaceRangeWithMarkdown` is **not registered on this branch at all**, so on
base this scenario should still fail, with a reason saying the tool is absent. That is what
`live/checklist/checklist-2-replace-range-with-markdown.mjs` already reports, so make sure
the two agree rather than contradicting each other.

## Scenario 2: `live/docs/issue-105-json-format-size.mjs` asserts the old behaviour

Issue #105 said `readDocument(format='json')` returned 1.36M characters for a 9.6K-character
document, making the documented workflow unusable.

On the fixed build, that call now **throws** a `PublicToolError`:

```
The raw JSON for this document is 415671 characters, over the 100000-character limit ...
```

So the fix was to refuse with a bounded, explanatory error rather than to shrink the payload.
The scenario still asserts on a returned payload and therefore reports failure on a build
where the issue is arguably resolved.

Decide what #105 actually requires and make the scenario assert that. Read the issue body
(`gh issue view 105 --json title,body -q '.title,.body'`; you have network) before deciding.
My reading is that refusing with an actionable message satisfies the issue only if the tool
also tells the caller what to do instead, since the reporter's complaint was that the
documented path was unusable, not merely that the number was large. So the scenario should
probably assert: on base, an unbounded payload comes back; on a fixed build, either a bounded
payload OR a refusal that names a usable alternative such as `format='index'`. Check the
actual error text on this branch and write the assertion around what a caller can act on.

If you conclude the refusal does NOT satisfy #105, say so clearly in your report and leave
the scenario asserting the stricter thing, so it keeps failing until the tool does better.
That is a legitimate outcome and more useful than a scenario tuned to pass.

## Standing constraints

- Do not change anything under `dist/`. This branch deliberately touches no runtime source.
- `npm test` must stay green. **Read the `Test Suites:` line**, not just `Tests:`.
- Do not run the live harness. It needs credentials and a Drive folder, and I will run it
  myself afterward.
- Keep each scenario's file header comment accurate; those headers are the documentation of
  why each scenario asserts what it does.

## Report

For each scenario: what was wrong, what it now asserts, and on a fixed build whether you
expect pass or fail and why. Then the `Test Suites:` line.
