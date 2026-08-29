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

## As built

Landed on `feat/docs-cluster`. Where the plan and the branch disagreed, the branch won and the reason is recorded here.

**Name mapping.** The plan's `guardMutation` is the migration's `beginDocsMutation` (`dist/docsHandles.js`). The `targetRange` / `reresolve` interface is `lease.guardTargets({targets, snapshot|fetchSnapshot|fetchRevisionId, reresolve})`, plus a `targetRange`/`reresolve`/`fetchSnapshot`/`fetchRevisionId` convenience on `beginDocsMutation` itself for a tool whose target is known before it fetches anything. Classification lives in a new pure module, `dist/docsChangePrecision.js`.

**A lease method, not begin-time arguments only.** Three of the four consumers cannot know their target before they fetch (`modifyText` and `replaceRangeWithMarkdown` resolve anchors; `batchModifyText` resolves N targets against its own snapshot). A begin-time-only interface would have forced a second, different fetch and broken the plan's own "same snapshot" requirement. `deleteRange`, whose target is pure input, uses the begin-time form.

**Hunks come from the text projection, not the markdown patch.** §Design decisions says "derive hunks from the existing markdown patch". Markdown carries no document indices, so a markdown hunk cannot be compared to a caller's range without re-deriving positions from a lossy rendering. Instead each read stores the projection it actually saw — every `textRun`'s text with the document index of every character, plus a structural census — and hunks are diffed between two such projections and mapped straight back to index ranges. The unified diff shown to the caller is rendered from the same projections.

**Per-tool threading.**

| Tool | Target kind | Snapshot the guard classifies | Re-resolution |
|---|---|---|---|
| `modifyText` | `textToFind` semantic; `startIndex/endIndex` and `insertionIndex` explicit | `revisionId` probe, then `textSearchFields` fetch only if it moved | `findTextRangeInDoc` against the guard's snapshot |
| `batchModifyText` | per operation, same rule | its own existing single snapshot, passed straight in | already resolved against that snapshot; `reresolve` returns the same ranges |
| `deleteRange` | always explicit | probe, then `textSearchFields` fetch only if it moved | none possible; a change before the range blocks |
| `replaceRangeWithMarkdown` | `afterHeading`/`headingId`/`textToFind` semantic; explicit range explicit | the `revisionId,body,lists` body it already fetches | `resolveTargetRange` / `findTextRangeInDoc` re-run against that body |

The guard runs before `validateRange`, the fidelity scan and the covered-element list in `replaceRangeWithMarkdown`, so everything derived from the range is derived from the re-resolved one. A `dryRun` is guarded too: a preview of a range that a real write would refuse is worse than the refusal.

**Two additions to the plan's conservatism.** A revision that moved with no visible text or structural difference classifies as `unknown` and rejects (a formatting-only edit is real and cannot be located). A handle minted by a read whose field mask carried no indices — `format='text'` — has no comparable projection and also rejects, naming `format='index'` as the read that works.

**Not done here.** `computeStructuralFingerprint` walks a tab read's `{body, lists}` fragment with the tab id still applied, which `walkDocument` filters to nothing, so tab reads carry a degenerate fingerprint. `#108`'s projections avoid it via `walkTabFilter`, but the migration-owned fingerprint itself is untouched; it needs its own fix.

## Sequencing

After the migration, #105, and #88. #88 ships against the migrated document-scoped guard; #108 adds range precision and re-resolution afterwards. #107 consumes the same interface once it is available.
