# Plan: make the conflict guard precise and informative (#108)

Issue: [#108](https://github.com/karthikcsq/google-tools-mcp/issues/108). Revised after the MCP 2026-07-28 migration decision. Builds on migrated #87 state, #105 index output, and #88's snapshot resolver.

## Migration boundary

The migration owns revision-first detection, structural-fingerprint equality, opaque read-handle validation, tracker re-arming, and `expectedRevisionId` as a validated handle companion wired through Docs `WriteControl`. A Drive metadata-only change does not advance the Docs revision, so the migration permits it without #108. #108 stays open for the remaining root cause: a document-scoped guard cannot determine whether a real content change conflicts with one pending range, cannot safely remap a shifted target, and does not explain the result well enough to recover.

## Root cause

After migration, a changed revision can be known to differ without telling a caller whether the change touches its requested edit. A permissive overlap check alone is unsafe because an insertion or deletion before the target shifts explicit indices. Markdown projection is also lossy, so any range classification based on it must be conservative.

## Design decisions

- **Permit only re-resolved semantic targets, then advance the guard atomically.** `guardMutation` receives `targetRange` and an optional `reresolve` callback. On a changed document, a permitted operation must resolve its target again against the exact fetched snapshot **and atomically re-arm from that same snapshot before the write**. The re-arm mints/validates a successor handle and makes the snapshot's current stored revision the `WriteControl` value, so the batch never sends the stale handle revision. `textToFind` uses #88's `findTextRangeInDoc`. Explicit-index targets have no semantic anchor, so any change before or overlapping their range blocks; only a confidently mapped change strictly after the end may proceed.
- **Conservative overlap classification.** Derive hunks from the existing markdown patch but block when a hunk cannot be mapped confidently, touches tables/images/structure, or is at/before the target. Precision is limited to clean text changes after an explicit range or a uniquely re-resolved semantic target. `findAndReplace` remains document-scoped because it can affect many ranges.
- **Every rejection explains the actionable state.** Use a unified diff when the prior snapshot exists. Otherwise summarize added/removed/modified paragraphs and proximity to the requested target from the fetched document. Name `format='index'` and `diffFromLastRead` as next steps. Do not guess at metadata labels the migrated revision model cannot prove.
- **Do not add a second revision override.** `expectedRevisionId` is migration-owned only as a compare-and-write assertion paired with a validated opaque handle. This plan consumes that prerequisite rather than adding schema, authorization, guard, or WriteControl work.

## Implementation

1. Extend the migration's document-scoped `guardMutation` with `targetRange`, snapshot return, conservative hunk classification, structured explanations, and `reresolve` support. On its only permissive changed-document path, atomically mint/validate the successor handle from that fetched snapshot and pass its current revision into `WriteControl`.
2. Thread the interface through `modifyText`, `deleteRange`, #88's `batchModifyText`, and #107's `replaceRangeWithMarkdown`. Keep whole-document tools, Sheets, and `findAndReplace` document-scoped.
3. Use #105's public index vocabulary in errors and #88's tab-aware snapshot resolver for semantic re-resolution. Preserve tab boundaries in every comparison.
4. Update tool descriptions and failure strings to state why explicit indices are more conservative and how to refresh an actionable target.

## Tests

- A far-away content edit permits a uniquely re-resolved `textToFind` operation and asserts the emitted request uses the new indices **and the fetched snapshot's current revision, never the stale handle revision**. The test proves the successor handle is minted/validated as part of the same re-arm. The migration suite, not this plan, proves that metadata-only Drive changes do not advance the Docs revision or require range classification.
- An insertion before an explicit index blocks even when target text is unchanged; an after-range clean text edit may proceed. Overlapping edits block with a diff/explanation.
- Unmappable markdown hunks, tables, images, structural changes, non-unique anchors, and cross-tab ambiguity block conservatively.
- JSON/index/text read cases produce the specified diff or change summary and point to the viable next step.
- `findAndReplace`, whole-body callers, and Sheets retain document-scoped behavior. Correct and stale `expectedRevisionId` behavior as a validated-handle companion remains covered by the migration suite rather than duplicated here.

## Acceptance criteria

- A safe unrelated content edit no longer blocks a semantic, freshly re-resolved write.
- A permitted changed-document write always uses indices and `WriteControl` revision resolved from the same current snapshot; it cannot submit the stale handle revision.
- Explicit-index shifts, overlaps, and structure that cannot be mapped safely are rejected.
- Rejections say what changed, where confidence ended, and which read workflow can recover.

## Sequencing

After the migration, #105, and #88. #88 ships against the migrated document-scoped guard; #108 adds range precision and re-resolution afterwards. #107 consumes the same interface once it is available.
