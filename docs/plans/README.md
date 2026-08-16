# Execution plans

**2026-08-08 update:** the [MCP 2026-07-28 migration plan](mcp-2026-07-28-migration.md) (fastmcp → official SDK v2, stateless protocol) is the first technical implementation step. It absorbs #87's implementation into opaque, high-entropy `readHandle` state bound to principal, profile, file, tab, revision, and fingerprint; `expectedRevisionId` remains only a validated companion assertion. It absorbs obsolete transport plumbing from #75. It must land **before** #71, which must then re-baseline its import inventory against the final SDK v2 runtime. Read the migration plan before executing #71, #75, #87, #88, #105–#108, or #91.

One plan per open issue, written against the code as of 2026-08-06. Each plan states the verified root cause, the design decisions with rationale, concrete implementation steps anchored to `file:line`, the tests that prove it, and acceptance criteria. Line numbers drift as the tree changes; the anchors were verified on the commit each plan names.

Triage context: of the 17 issues open at the first review (2026-08-03), #72 was closed (resolved by PR #103) and #7 was closed (mitigated by explicit snake_case notes in the calendar tool descriptions). Five further issues (#104–#108) were filed on 2026-08-06; #104 was consolidated into #107 as the same root cause. Every sub-issue referenced by the "Master:" issues was already closed by the earlier consolidation pass.

## Suggested execution order

Ordering is driven by three constraints: the MCP migration lands first because it replaces the runtime and #71 must re-baseline after it; config loading (#82) must precede diagnostics (#91) because the log path/level should honor the config file; and within the Docs cluster, the migration's revision-handle guard plus #105's public addressing surface unblock everything else.

| # | Plan | Issue | Size | Depends on |
|---|------|-------|------|------------|
| 1 | [npm-publish required reviewer](issue-50-npm-publish-required-reviewer.md) | [#50](https://github.com/karthikcsq/google-tools-mcp/issues/50) | admin, minutes | — |
| 2 | [MCP 2026-07-28 migration](mcp-2026-07-28-migration.md) | cross-queue migration, absorbs #87 | L | — |
| 3 | [Swap googleapis for @googleapis/* scoped packages](issue-71-googleapis-scoped-packages.md) | [#71](https://github.com/karthikcsq/google-tools-mcp/issues/71) | M | migration complete; re-baselined inventory |
| 4 | [readDocument plainMarkdown option](issue-96-readdocument-plainmarkdown.md) | [#96](https://github.com/karthikcsq/google-tools-mcp/issues/96) | S | migration complete |
| 5 | [Gmail maintenance cleanup](issue-74-gmail-cleanup.md) | [#74](https://github.com/karthikcsq/google-tools-mcp/issues/74) | S | — |
| 6 | [Recursive folder listing](issue-99-recursive-folder-listing.md) | [#99](https://github.com/karthikcsq/google-tools-mcp/issues/99) | M | — |
| 7 | [Structural index read (`format:'index'`)](issue-105-structural-index-read.md) | [#105](https://github.com/karthikcsq/google-tools-mcp/issues/105) | M | migration structural walker (enables 88, 107, 108) |
| 8 | [Markdown round-trip fidelity + working-copy safety](issue-106-markdown-roundtrip-fidelity.md) | [#106](https://github.com/karthikcsq/google-tools-mcp/issues/106) | M | migration revision-handle workspace model |
| 9 | [Comments workflow](issue-86-comments-workflow.md) | [#86](https://github.com/karthikcsq/google-tools-mcp/issues/86) | M | — |
| 10 | [Docs read/write state](issue-87-read-write-state.md) | [#87](https://github.com/karthikcsq/google-tools-mcp/issues/87) | absorbed, close only after migration handle tests pass | migration PR |
| 11 | [Section-scoped markdown replace](issue-107-section-scoped-markdown-replace.md) | [#107](https://github.com/karthikcsq/google-tools-mcp/issues/107) (canonical for #104) | M | migration, #105, #106 |
| 12 | [Safe structured Docs editing](issue-88-safe-docs-editing.md) | [#88](https://github.com/karthikcsq/google-tools-mcp/issues/88) | L | migration, #105, #86 |
| 13 | [Conflict-guard precision](issue-108-conflict-guard-precision.md) | [#108](https://github.com/karthikcsq/google-tools-mcp/issues/108) | M | migration, #88, #105 |
| 14 | [Gmail MIME compliance](issue-73-gmail-mime.md) | [#73](https://github.com/karthikcsq/google-tools-mcp/issues/73) | M | #74 (hard) |
| 15 | [Explicit font color](issue-14-explicit-font-color.md) | [#14](https://github.com/karthikcsq/google-tools-mcp/issues/14) | S | — |
| 16 | [Config loading order](issue-82-config-loading.md) | [#82](https://github.com/karthikcsq/google-tools-mcp/issues/82) | M | — |
| 17 | [Actionable diagnostics](issue-91-diagnostics.md) | [#91](https://github.com/karthikcsq/google-tools-mcp/issues/91) | M | migration, #82 |
| 18 | [Setup idempotency + doctor](issue-48-setup-idempotency.md) | [#48](https://github.com/karthikcsq/google-tools-mcp/issues/48) | L | #82 |
| 19 | [HTTP transport lifecycle](issue-75-http-transport.md) | [#75](https://github.com/karthikcsq/google-tools-mcp/issues/75) | L | migration, #82, #48 |
| 20 | [Test and package blind spots](issue-56-test-package-blind-spots.md) | [#56](https://github.com/karthikcsq/google-tools-mcp/issues/56) | M | migration create-then-write coverage |

Sizes: S = under a day, M = 1–3 days, L = a week-scale effort that should be split into the PR sequence its plan describes.

## The Docs editing cluster

Issues #87, #88, #104–#108, #96, and #14 are one subsystem with a common shape: **the Docs tools can address text but not structure.** Read the migration first: it supplies #87's principal-bound opaque read-handle guard, create seeding, and structural walker. Then read #105 (public indices) → #106 (round-trip faithfully and preserve editable copies) → #107 (write structure into a range) → #88 (batch and preview it) → #108 (classify overlap, explain, and re-resolve).

Two cross-plan contracts are easy to break and are stated in both places: the **workspace filename composition** (one unique editable workspace per migration `readHandle` × #106's divergence copy; only the immutable content-addressed baseline is shared; TTL preserves dirty files), and the **guard interface** (HTTP requires a validated opaque handle, while stdio implicit state is connection-local; #88 consumes that contract and #108 later adds `targetRange`/`reresolve`).
