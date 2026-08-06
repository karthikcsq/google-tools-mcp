# Plan: safe structured Docs editing without destructive full-body rewrites (#88)

Issue: [#88](https://github.com/karthikcsq/google-tools-mcp/issues/88) (canonical for closed #89, #93, #95, #98) · Verified against `main` @ 8640240. Revised after adversarial review.

## Root cause

For any multi-location edit, callers face a forced choice between two bad tools:

- `modifyText` is **single-operation** (`dist/tools/docs/modifyText.js:21-30`), so ten local changes = ten round trips, each shifting indexes under the next and each a separate conflict window.
- `replaceDocumentWithMarkdown` rebuilds the whole body — delete-everything then re-insert (`dist/tools/utils/replaceDocumentWithMarkdown.js:109-122, 196-203`) — which the Docs API treats as *new content*: every comment anchor orphans and every `headingId` regenerates. Nothing inspects comments or headings before deleting. It is also **not one write**: delete (`:108-121`), best-effort cleanup (`:123-192`), then insert (`:194-210`) — a failed insert leaves a gutted document (behavior pinned by `tests/replaceDocumentWithMarkdown.test.js:115-140`).

The missing capability is a **middle layer**: atomic multi-edit against the existing body, plus preview/warning surfaces that make the destructive path's collateral visible. There is also no cheap structure view — no heading-listing tool; the heading-level helper is private (`docsToMarkdown.js:207-217`).

## Design decisions

- **`batchModifyText` = N validated operations, one `batchUpdate`.** Reuse `buildModifyTextRequests` (`modifyText.js:44-94`, pure and exported) per operation. Index-shift is solved by resolving all targets against one snapshot, then applying in **descending document order**; overlapping ranges are rejected up front naming the two operations. Text-search targets: `findTextRange` currently fetches the document itself on every call (`googleDocsApiHelpers.js:401-408`) — add a snapshot-based variant (`findTextRangeInDoc(docJson, ...)`) preserving the full fallback chain (list-marker stripping, unicode normalization, `:411-485`), with the existing function becoming fetch-then-delegate. One read total.
  - **Cap in API requests, not operations.** One operation emits up to four requests (`modifyText.js:49-91`), and `executeBatchUpdate` only warns above 50 (`googleDocsApiHelpers.js:5-20`) while the splitting helper (`:99-147`) would break atomicity if reused. Rule: build all requests, count them, reject above **400 requests** (safely under the API's per-batch ceiling) with a UserError telling the caller to split — atomicity is the contract, so we never silently split.
  - Whole batch goes through the existing guard + `WriteControl` chain exactly as `modifyText.js:110-119, 180-187` → all-or-nothing.
- **`dryRun` with an honest preview contract.** Both tools gain `dryRun: boolean`. The preview is two parts: (a) a unified **text diff** (`createPatch`, dependency already in use, `readTracker.js:141-171`) covering text changes; (b) a **structured operation summary** — per op: kind (replace/insert/delete/style/paragraphStyle), resolved target range, and the style fields to be set — because formatting-only operations produce no text diff (`modifyText.js:63-91`) and a bare empty diff would misread as "no change". Real writes return the same applied summary + diff. For `replaceDocumentWithMarkdown`, current-body markdown for the diff comes from the guard's existing fetch (`:40-47`).
- **Tab correctness rides along.** The replace tool's guard fetcher converts `current.data` — the *default* body — even when `args.tabId` selects a tab (`:40-47` vs `:82-94`), so tab edits get wrong-snapshot conflicts today; #87's scope-aware tracker fixes the guard side, and this plan's dryRun/collateral/heading extraction must all select the tab body (`findTabById`, as in `readGoogleDoc.js:70-89`) before analyzing. Every new feature here is tab-parameterized from day one.
- **Collateral checks on every replace — warn by default, block on request.** Before deleting: (a) unresolved comments via `drive.comments.list` (fields incl. `quotedFileContent`) — with a full-body replace, all unresolved anchored comments are collateral; list id + first 40 chars of quote. Note the honest limitation: the Drive comment surface exposes quoted text, not live ranges (`listComments.js:20-34`), so "which comments does *this partial* replace orphan" (with `preserveTitle`, or repeated quote text) is approximate — collateral for the preserved region may be over-reported; say so in the response wording. (b) internal links: scan the (tab-scoped) body's textRuns for `link.headingId`, report link text + target. New param `onCollateral: 'warn' | 'block'` (default warn; block throws listing the collateral).
- **Post-write heading map, correctly sourced.** `insertMarkdown` returns request/timing metadata only (`markdown-transformer/index.js:147-155`) — the map requires a **separate narrow `documents.get`** after the write: `fields: 'body.content(startIndex,endIndex,paragraph(paragraphStyle(namedStyleType,headingId),elements(textRun(content))))'` (tab variant via `tabs` + `findTabById`), from which `{ text, headingId, level, startIndex }` per heading is built. Include it in the replace response so callers repair links without a full JSON read.
- **`listHeadings` is superseded by #105's `format: 'index'`** — [#105's plan](issue-105-structural-index-read.md) adds a whole-document structural walker (every element: headings, list items with nesting, tables, rules) built on a narrow field mask, which answers heading questions as a subset. Build the shared walker there; here, either drop `listHeadings` entirely (preferred — one addressing surface, not two) or keep it as a thin filter over that walker if a heading-only convenience proves worthwhile. The heading-extraction helper this plan needs for the post-write map is the same helper — implement once in #105, consume here and in #107.
- **Partial-write exposure on replace: narrowed, not solved.** The delete→cleanup→insert sequence keeps its failure window. In scope here: (a) `dryRun` lets callers see the blast radius first; (b) on insert failure the error message now names the workspace mirror file (written pre-delete from the *incoming* markdown, `:222-229` — for `filePath` calls the caller already holds the source) and states the document is partial. A true transactional replace (single batchUpdate combining delete+insert) is worth investigating — it may actually be possible since both are batchUpdate requests — but changes fidelity-sensitive machinery (`survivor cleanup`, `:129-193`); file it as the follow-up issue alongside three-way merge rather than blocking this plan.
- **Three-way merge: descoped to a follow-up issue** (with #87's revision-first detection + atomic batch, non-overlapping edits compose and conflicts fail loudly with a diff).

## Implementation

1. `dist/tools/docs/batchModifyText.js`: schema `operations` (1–50 ops; request-count cap enforced post-build at 400), shared `tabId`, `dryRun`; snapshot fetch → snapshot-based target resolution → overlap check → descending sort → one guarded `batchUpdate`. Register in `docs/index.js`. **Scope note:** `batchModifyText` is the right tool for many small *text* edits; structured content (lists, headings) into a range belongs to [#107's `replaceRangeWithMarkdown`](issue-107-section-scoped-markdown-replace.md), because per-line list structure cannot be expressed through `buildModifyTextRequests` (that limitation is #104's root cause). Both tools' descriptions must say which is which.
2. `findTextRangeInDoc` refactor in `googleDocsApiHelpers.js`.
3. Consume #105's shared element/heading walker (no separate `listHeadings` tool — see above).
4. `replaceDocumentWithMarkdown.js`: `dryRun`, `onCollateral`, tab-scoped collateral gathering pre-delete, post-write heading map + applied diff, partial-failure message naming the mirror.
5. Count bookkeeping (relative, since #86 also adds a tool and lands first per the README ordering): **+2 tools over whatever the current pinned baseline is** at merge time — update `tests/toolRegistration.test.js` default and alias-enabled totals (alias count unchanged; no aliases for new tools) and the README docs-category list; `documentationConsistency` catches the global count.
6. Cross-references in descriptions: `modifyText` → `batchModifyText` for multi-edit; `replaceDocumentWithMarkdown` warns about comment/heading collateral, names `dryRun`, and recommends `batchModifyText` for local edits.

## Tests

- `batchModifyText`: descending-order preservation (3 ascending-position edits); overlap rejection naming both ops; request-count cap (op set emitting >400 requests → UserError, no API call); single `batchUpdate` in the mock; per-op request shapes ≡ `buildModifyTextRequests`; snapshot resolver parity — `findTextRangeInDoc` returns identical results to `findTextRange` across the fallback fixtures (exact, list-marker, unicode-normalized).
- `dryRun`: no mutating call reaches the mock; text ops → correct patch; **formatting-only op → empty diff but populated structured summary**; real write returns matching applied summary.
- Collateral: fixtures with 2 unresolved + 1 resolved comment + 1 heading link → warn names the 2 + link, resolved excluded; `onCollateral:'block'` throws; repeated-quote and `preserveTitle` fixtures exercise the approximate-reporting wording; tab fixture: collateral drawn from the tab body, not the default body.
- Heading map: post-write map matches the narrow-mask fixture, tab variant included (walker itself is tested in #105).
- One **manual verification** on a real doc (comments + internal links + replace) — the collateral path's ground truth is the Docs UI, which mocks cannot supply.
- Existing suites green (`mutatingDocsToolsWriteControl`, `replaceMarkdownWriteControl`, `writeControlRevisionAdvance`, `replaceDocumentWithMarkdown`).

## Acceptance criteria

- 10 scattered edits = one call, one atomic batchUpdate; untouched text and its comment anchors survive.
- A full replace can no longer *silently* orphan comments or break heading links — collateral is enumerated (or blocks), including for tab-scoped calls, with its approximation stated; the post-write heading map enables link repair without a full read.
- `dryRun` previews text changes as a diff and formatting changes structurally; a real call reports what it did.
- Structure questions cost one narrow-mask call (via #105's index mode).
- Insert-failure after delete names the recovery mirror; the transactional-replace investigation is filed as a follow-up with the three-way-merge issue.

## Sequencing

After #87 (conflict signal, scope-aware tracker, guard coverage). Tool-count updates coordinate with #86 (lands first). Follow-up issues to file at completion: transactional replace, base-revision three-way merge.
