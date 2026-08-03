# Plan: safe structured Docs editing without destructive full-body rewrites (#88)

Issue: [#88](https://github.com/karthikcsq/google-tools-mcp/issues/88) (canonical for closed #89, #93, #95, #98) · Verified against `main` @ 8640240.

## Root cause

For any multi-location edit, callers face a forced choice between two bad tools:

- `modifyText` is **single-operation** (`dist/tools/docs/modifyText.js:21-30` — one `target` per call), so ten local changes = ten round trips, each shifting indexes under the next and each a separate conflict window.
- `replaceDocumentWithMarkdown` rebuilds the whole body — `deleteContentRange` over everything then re-insert (`dist/tools/utils/replaceDocumentWithMarkdown.js:109-122, 196-203`) — which the Docs API treats as *new content*: every comment anchor orphans (the quoted text range is gone) and every `headingId` regenerates (internal links break). Nothing in the code even inspects comments or headings before deleting (verified: zero references in the file or the transformer).

So the missing capability is a **middle layer**: atomic multi-edit against the *existing* body, plus preview/warning surfaces that make the destructive path's collateral visible instead of silent. There is also no cheap way to see document structure — no heading-listing tool exists; the heading-level helper is private to the markdown converter (`docsToMarkdown.js:207-217`).

## Design decisions

- **`batchModifyText` = N validated operations, one `batchUpdate`.** Reuse `buildModifyTextRequests` (`modifyText.js:44-94` — already a pure exported function) per operation. The hard problem is index shift between operations; solve it by **resolving all targets against the same snapshot, then applying in descending document order** (later indexes first), which keeps earlier targets' indexes valid without tracking deltas. Reject overlapping target ranges up front (clear `UserError` naming the two operations). Text-search targets resolve via the existing `findTextRange` fallback chain (`googleDocsApiHelpers.js:401-510`) against one fetched document JSON — one read, not N. The whole request list goes in **one** `documents.batchUpdate` with the existing `WriteControl` chain → atomic by API semantics (all or nothing), which is the merge-safety property the issue wants. 10–30 ops is well inside API request-count limits; document the practical cap (~50 ops) and reject beyond it.
- **`dryRun` on the two rewrite tools, unified diff output.** `replaceDocumentWithMarkdown` and `batchModifyText` gain `dryRun: boolean`. Implementation for replace: current body → markdown (converter already invoked for the guard's contentFetcher at `replaceDocumentWithMarkdown.js:47`), proposed markdown → `createPatch` (the `diff` dependency is already used by the tracker, `readTracker.js:141-171`); response = patch + deletion summary (counts of lines added/removed) + the collateral warnings below + "no changes applied". For batchModifyText: simulate against the fetched text (the builder's requests are deterministic on the snapshot) and diff. Real writes return the same applied-diff shape (issue: "return the applied diff on real writes").
- **Collateral checks run on every replace — warn by default, block on request.** Before deleting, gather in one pass: (a) unresolved comments via `drive.comments.list` (fields: `id,resolved,quotedFileContent`) whose quoted text will be removed — with a full-body replace that is *all* unresolved anchored comments, listed by id + first 40 chars of quote; (b) internal links: scan the fetched body's textRuns for `link.headingId` targets, report link text + target id, since every headingId regenerates. New param `onCollateral: 'warn' | 'block'` (default `'warn'`; `'block'` throws a UserError listing the collateral so agents can surface it to a human). Response always names affected comment ids/anchors — the issue's requirement.
- **Post-write heading map for free.** After a real replace, extract the new heading map (from the insert result's fetched state — one narrow `documents.get` with `fields: 'body.content(paragraph(paragraphStyle(namedStyleType,headingId)),startIndex,endIndex)'`) and include `headings: [{ text, headingId, level, startIndex }]` in the response, so callers can repair links without a full JSON read.
- **`listHeadings` as a standalone tool** — same extraction, exposed directly: `listHeadings(documentId, tabId?)` → the array above. Promote `getHeadingLevel` out of the converter (export from `docsToMarkdown.js` or move to `googleDocsApiHelpers.js`) to handle TITLE/SUBTITLE/HEADING_N; walk `tabs` when `tabId` given (reuse `findTabById` as in `readGoogleDoc.js:70-89`); handle empty bodies (empty array), nullable `headingId` (headings never linked-to may lack one — return `null`, don't fabricate). Payload is proportional to heading count via the narrow field mask above.
- **Base-revision three-way merge: descope to a follow-up.** With #87's revision-first conflict detection + `batchModifyText` resolving text-search targets against the current snapshot at call time, the practical merge-safety need is covered (non-overlapping edits compose; conflicting ones fail loudly with a diff). A true three-way text merge engine is large, separate machinery — record it as a follow-up issue rather than padding this one.

## Implementation

1. `dist/tools/docs/batchModifyText.js`: schema = `operations: z.array(<modifyText's op shape minus tabId>).min(1).max(50)`, shared `tabId`, `dryRun`; snapshot fetch → resolve all targets → overlap check → descending sort → concatenated requests → one guarded `batchUpdate` (guard + WriteControl exactly as `modifyText.js:110-119, 180-187`). Register in `docs/index.js`.
2. `dist/tools/docs/listHeadings.js` + heading-extraction helper (shared with step 3's post-write map).
3. `replaceDocumentWithMarkdown.js`: `dryRun`, `onCollateral`, collateral gathering before the delete (`:109`), post-write heading map + applied diff in the success response.
4. Tool-count pins update (156 → 158 with two new tools): `tests/toolRegistration.test.js`, README/package description via `documentationConsistency` failure.
5. Tool descriptions cross-reference: `modifyText` points to `batchModifyText` for multi-edit; `replaceDocumentWithMarkdown` warns about comment/heading collateral and names `dryRun`.

## Tests

- `batchModifyText` (pure layer): descending-order application preserves all target indexes (fixture with 3 edits at ascending positions); overlap rejection; atomicity = single `batchUpdate` call in the mock; per-op request shapes equal `buildModifyTextRequests` output.
- `dryRun`: no mutating API call reaches the mock; diff matches expected patch; applied-diff on real write matches the same patch.
- Collateral: fixture with 2 unresolved comments + 1 heading link → warn response names both comment ids and the link; `onCollateral:'block'` throws listing them; resolved comments not flagged.
- `listHeadings`: fixture with TITLE, H1–H3, a headingId-less heading, tabs variant, empty doc.
- Existing write-control/guard suites stay green (`mutatingDocsToolsWriteControl`, `replaceMarkdownWriteControl`, `writeControlRevisionAdvance`).

## Acceptance criteria

- 10 scattered edits = one call, one atomic batchUpdate; untouched text and its comment anchors survive byte-for-byte.
- A full replace can no longer *silently* orphan comments or break heading links — collateral is enumerated in the response (or blocks, on request), and the new heading map enables link repair without a full read.
- `dryRun` previews exactly what a real call would change; the real call reports what it did change.
- Structure questions ("what headings exist, where") cost one narrow-mask call.

## Sequencing

After #87 (conflict signal + guard coverage — batchModifyText must sit on the corrected guard). Follow-up issue to file at completion: base-revision three-way merge.
