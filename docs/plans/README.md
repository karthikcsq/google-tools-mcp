# Execution plans

One plan per open issue, written against the code as of 2026-08-06. Each plan states the verified root cause, the design decisions with rationale, concrete implementation steps anchored to `file:line`, the tests that prove it, and acceptance criteria. Line numbers drift as the tree changes; the anchors were verified on the commit each plan names.

Triage context: of the 17 issues open at the first review (2026-08-03), #72 was closed (resolved by PR #103) and #7 was closed (mitigated by explicit snake_case notes in the calendar tool descriptions). Five further issues (#104–#108) were filed on 2026-08-06; #104 was consolidated into #107 as the same root cause. Every sub-issue referenced by the "Master:" issues was already closed by the earlier consolidation pass.

## Suggested execution order

Ordering is driven by three constraints: the dependency swap (#71) touches almost every file, so it lands while the tree is quiet; config loading (#82) must precede diagnostics (#91) because the log path/level should honor the config file; and within the Docs cluster, #87 (conflict signal) and #105 (addressing surface) unblock everything else.

| # | Plan | Issue | Size | Depends on |
|---|------|-------|------|------------|
| 1 | [npm-publish required reviewer](issue-50-npm-publish-required-reviewer.md) | [#50](https://github.com/karthikcsq/google-tools-mcp/issues/50) | admin, minutes | — |
| 2 | [Swap googleapis for @googleapis/* scoped packages](issue-71-googleapis-scoped-packages.md) | [#71](https://github.com/karthikcsq/google-tools-mcp/issues/71) | M | open PRs merged (done) |
| 3 | [readDocument plainMarkdown option](issue-96-readdocument-plainmarkdown.md) | [#96](https://github.com/karthikcsq/google-tools-mcp/issues/96) | S | — |
| 4 | [Gmail maintenance cleanup](issue-74-gmail-cleanup.md) | [#74](https://github.com/karthikcsq/google-tools-mcp/issues/74) | S | — |
| 5 | [Structural index read (`format:'index'`)](issue-105-structural-index-read.md) | [#105](https://github.com/karthikcsq/google-tools-mcp/issues/105) | M | — (enables 88, 107, 108) |
| 6 | [Markdown round-trip fidelity + working-copy safety](issue-106-markdown-roundtrip-fidelity.md) | [#106](https://github.com/karthikcsq/google-tools-mcp/issues/106) | M | — |
| 7 | [Comments workflow](issue-86-comments-workflow.md) | [#86](https://github.com/karthikcsq/google-tools-mcp/issues/86) | M | — |
| 8 | [Docs read/write state](issue-87-read-write-state.md) | [#87](https://github.com/karthikcsq/google-tools-mcp/issues/87) | M | — |
| 9 | [Section-scoped markdown replace](issue-107-section-scoped-markdown-replace.md) | [#107](https://github.com/karthikcsq/google-tools-mcp/issues/107) (canonical for #104) | M | #87, #105, #106 |
| 10 | [Safe structured Docs editing](issue-88-safe-docs-editing.md) | [#88](https://github.com/karthikcsq/google-tools-mcp/issues/88) | L | #87, #105, #86 |
| 11 | [Conflict-guard precision](issue-108-conflict-guard-precision.md) | [#108](https://github.com/karthikcsq/google-tools-mcp/issues/108) | M | #87, #88 (adds targetRange to it) |
| 12 | [Gmail MIME compliance](issue-73-gmail-mime.md) | [#73](https://github.com/karthikcsq/google-tools-mcp/issues/73) | M | #74 (hard) |
| 13 | [Explicit font color](issue-14-explicit-font-color.md) | [#14](https://github.com/karthikcsq/google-tools-mcp/issues/14) | S | — |
| 14 | [Config loading order](issue-82-config-loading.md) | [#82](https://github.com/karthikcsq/google-tools-mcp/issues/82) | M | — |
| 15 | [Actionable diagnostics](issue-91-diagnostics.md) | [#91](https://github.com/karthikcsq/google-tools-mcp/issues/91) | M | #82 |
| 16 | [Setup idempotency + doctor](issue-48-setup-idempotency.md) | [#48](https://github.com/karthikcsq/google-tools-mcp/issues/48) | L | #82 |
| 17 | [HTTP transport lifecycle](issue-75-http-transport.md) | [#75](https://github.com/karthikcsq/google-tools-mcp/issues/75) | L | #82, #48 |
| 18 | [Test and package blind spots](issue-56-test-package-blind-spots.md) | [#56](https://github.com/karthikcsq/google-tools-mcp/issues/56) | M | create-then-write test lands with #87 |

Sizes: S = under a day, M = 1–3 days, L = a week-scale effort that should be split into the PR sequence its plan describes.

## The Docs editing cluster

Issues #87, #88, #104–#108, #96, and #14 are one subsystem with a common shape: **the Docs tools can address text but not structure.** Reading that cluster in dependency order — #105 (get indices affordably) → #106 (round-trip faithfully) → #87 (know when the document really changed) → #107 (write structure into a range) → #88 (batch and preview it) → #108 (know *where* it changed, and re-resolve safely) — is more useful than reading any one plan alone.

Two cross-plan contracts are easy to break and are stated in both places: the **workspace filename composition** (#87's session suffix × #106's `.remote.md` and `.sha256` baseline, including the cleanup glob), and the **guard interface** (#88 ships against the document-scoped guard; #108 then adds `targetRange`/`reresolve`).
