# Execution plans

One plan per open issue, written against the code as of 2026-08-03 (post PR #103/#77 merge). Each plan states the verified root cause, the design decisions with rationale, concrete implementation steps anchored to `file:line`, the tests that prove it, and acceptance criteria. Line numbers drift as the tree changes; the anchors were verified on the commit each plan names.

Triage context: of the 17 issues open at review time, #72 was closed (resolved by PR #103) and #7 was closed (mitigated by explicit snake_case notes in the calendar tool descriptions). Every sub-issue referenced by the "Master:" issues below was already closed by the earlier consolidation pass. The 15 remaining issues each get a plan; none overlap enough to merge further.

## Suggested execution order

Ordering is driven by two constraints: the dependency swap (#71) touches almost every file, so it lands while the tree is quiet; and config loading (#82) must precede diagnostics (#91) because the log file path and level should honor the config file.

| # | Plan | Issue | Size | Depends on |
|---|------|-------|------|------------|
| 1 | [npm-publish required reviewer](issue-50-npm-publish-required-reviewer.md) | [#50](https://github.com/karthikcsq/google-tools-mcp/issues/50) | admin, minutes | — |
| 2 | [Swap googleapis for @googleapis/* scoped packages](issue-71-googleapis-scoped-packages.md) | [#71](https://github.com/karthikcsq/google-tools-mcp/issues/71) | M | open PRs merged (done) |
| 3 | [readDocument plainMarkdown option](issue-96-readdocument-plainmarkdown.md) | [#96](https://github.com/karthikcsq/google-tools-mcp/issues/96) | S | — |
| 4 | [Gmail maintenance cleanup](issue-74-gmail-cleanup.md) | [#74](https://github.com/karthikcsq/google-tools-mcp/issues/74) | S | — |
| 5 | [Comments workflow](issue-86-comments-workflow.md) | [#86](https://github.com/karthikcsq/google-tools-mcp/issues/86) | M | — |
| 6 | [Docs read/write state](issue-87-read-write-state.md) | [#87](https://github.com/karthikcsq/google-tools-mcp/issues/87) | M | — |
| 7 | [Gmail MIME compliance](issue-73-gmail-mime.md) | [#73](https://github.com/karthikcsq/google-tools-mcp/issues/73) | M | #74 (deletes dead copies first) |
| 8 | [Explicit font color](issue-14-explicit-font-color.md) | [#14](https://github.com/karthikcsq/google-tools-mcp/issues/14) | S | — |
| 9 | [Config loading order](issue-82-config-loading.md) | [#82](https://github.com/karthikcsq/google-tools-mcp/issues/82) | M | — |
| 10 | [Actionable diagnostics](issue-91-diagnostics.md) | [#91](https://github.com/karthikcsq/google-tools-mcp/issues/91) | M | #82 |
| 11 | [Setup idempotency + doctor](issue-48-setup-idempotency.md) | [#48](https://github.com/karthikcsq/google-tools-mcp/issues/48) | L | #82 helps |
| 12 | [HTTP transport lifecycle](issue-75-http-transport.md) | [#75](https://github.com/karthikcsq/google-tools-mcp/issues/75) | L | #82, #48 adapters |
| 13 | [Safe structured Docs editing](issue-88-safe-docs-editing.md) | [#88](https://github.com/karthikcsq/google-tools-mcp/issues/88) | L | #87 |
| 14 | [Recursive folder listing](issue-99-recursive-folder-listing.md) | [#99](https://github.com/karthikcsq/google-tools-mcp/issues/99) | M | — |
| 15 | [Test and package blind spots](issue-56-test-package-blind-spots.md) | [#56](https://github.com/karthikcsq/google-tools-mcp/issues/56) | M | create-then-write test lands with #87 |

Sizes: S = under a day, M = 1–3 days, L = a week-scale effort that should be split into the PR sequence its plan describes.
