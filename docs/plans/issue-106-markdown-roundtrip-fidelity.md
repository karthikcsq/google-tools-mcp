# Plan: markdown round-trip fidelity and working-copy safety (#106)

Issue: [#106](https://github.com/karthikcsq/google-tools-mcp/issues/106). Revised for the MCP 2026-07-28 stateless migration.

## What verification found

`readDocument(format='markdown')` truncates and rewrites the working copy on normal and `diffFromLastRead` reads, so a documented edit-and-push workflow can silently destroy a local edit. The reported whitespace-only lines were not reproducible. The claimed list-export flattening was also wrong, but it hid a real round-trip loss: the exporter uses two spaces for every list nesting level, while an ordered parent marker `1. ` occupies three columns. Re-importing an ordered nested list therefore emits no tabs and flattens it. A following non-list paragraph is also swallowed as a lazy list continuation, and ordered numbering is always `1.`.

## Migration boundary

The migration owns and implements opaque, principal-bound read handles plus the core per-handle workspace, shared immutable baseline, TTL, and dirty-retention primitives. #106 consumes and extends those primitives for markdown no-clobber behavior, `.remote.md` divergence copies, and push reconciliation. There is no session suffix or disconnect cleanup in the new protocol.

## Design decisions

- **Read-handle-scoped editable paths.** The migration returns a high-entropy opaque read handle, never a revision identity. The managed editable path is `<docId>[.<tabId>].<readHandle>.md`; the exact encoding is sanitized and collision-safe. Every read handle has its own editable copy, including two reads of identical content by the same or different clients.
- **Immutable baseline is shared, editable files are not.** The migration initializes each handle workspace from one content-addressed immutable baseline keyed by profile/file/tab/revision/fingerprint. #106 compares each editable file hash with that baseline and never mutates it in place to make a later conflict disappear. An unmanaged existing file with no baseline is treated as user-owned.
- **Never clobber a dirty file.** If editable content differs from its baseline, keep it untouched and write fresh remote content to that handle's `<editable>.remote.md`, returning both paths and a clear note. This rule applies to ordinary and `diffFromLastRead` reads.
- **TTL is dirty-file-safe.** The migration's sweep may delete expired clean handle workspaces only. A dirty editable file and its recovery material are retained and reported for manual recovery; they are never deleted merely because the handle expired. #106 relies on that primitive; the shared immutable baseline is retained or collected only when no retained handle workspace needs it.
- **Push reconciliation trusts canonical Docs state, never submitted markdown.** After any successful push, refetch canonical Docs content, revision, and structural fingerprint. Mint the successor handle and baseline from that actual state, then reconcile only the successor editable workspace. Do not baseline the submitted inline markdown or `filePath` bytes, because conversion, fidelity handling, and concurrent canonicalization can differ from the request payload.
- **Round-trip formatting is stateful.** Compute list counters and ancestor marker widths in the outer conversion loop. Indent each level by its parent's rendered marker width, preserve mixed ordered/unordered nesting, normalize ordered lists to sequential decimal numbers per level, and add a blank line between a list block and the following non-list paragraph. Alpha/Roman/restart values remain documented projection loss.

## Implementation

1. **DONE** (2026-08-19). `dist/markdown-transformer/docsToMarkdown.js`: `docsJsonToMarkdown` now threads one `listState` object (`{ listStack: [], lastWasListItem: false }`) through the whole body-content loop. `renderListItem()` keeps a stack indexed by nesting level, each entry `{ listId, count, markerWidth }`. On each list item: the entry at the *deeper* levels is discarded (`stack.length = nestingLevel + 1`, after reading the current level's existing entry first) since returning to a shallower/equal level means any nested sub-list state below it no longer applies; the ordinal continues (`existing.count + 1`) only if the *same* `listId` reappears at that exact level (so a paragraph interrupting a list resumes its count rather than resetting it), otherwise it restarts at 1 (a different list, or the first item a new parent introduces at that level). Indentation for a level is the cumulative rendered width (`marker.length + 1`, i.e. `"1. "` = 3, `"12. "` = 4) of every ancestor level's marker — not a flat 2-space multiplier — so CommonMark's "child indent must reach past the parent's content column" rule holds regardless of how wide the parent's ordinal got. Unordered markers are always `"- "` (width 2), so this is behavior-preserving for unordered lists. A `lastWasListItem` flag plus a `separatorIfAfterListItem()` helper inserts a blank line before the next non-list block (heading, paragraph, table, section break) whenever it immediately follows a list item, fixing the lazy-continuation swallow. Verified end-to-end: `docsJsonToMarkdown` output round-tripped through `convertMarkdownToRequests` reproduces the original per-level tab-nesting Docs expects (test: `'produces markdown whose indentation the re-importer actually nests (apply-and-re-export round trip)'` in `tests/markdownTransformer.test.js`).
2. **Superseded.** Steps 2/3/5 below described a session-suffix/disconnect-cleanup working-copy model that the 2026-07-28 migration replaced with the per-handle read-handle workspace primitives (`dist/handleRuntime.js`, `dist/docsHandles.js`) documented in `docs/plans/SESSION-STATE.md`'s "PR3 design decisions" section — read-handle-scoped editable paths, shared immutable baselines, dirty-file-safe TTL, and push reconciliation are already implemented there as generic Docs-handle primitives, not as #106-specific work. This plan's step-1 converter fix is the only piece #106 still owns; the no-clobber/remote-divergence/reconciliation contracts (steps 2-5) are the migration's responsibility, already live.
3. `workspace.js`: consume migration-owned unique handle workspace, shared-baseline, dirty-detection, and TTL primitives; add markdown-specific no-clobber, remote-divergence, and reconciliation helpers. Do not reuse session-name or disconnect-cleanup APIs.
4. `readGoogleDoc.js`: use no-clobber managed writes for normal and diff reads, return the editable/remote/baseline state in its advice, and use the migration's read handle.
5. `replaceDocumentWithMarkdown.js`: after any successful inline or `filePath` push, refetch canonical Docs content/revision/fingerprint, mint the successor handle/baseline from it, and reconcile only that successor editable workspace. Never baseline submitted markdown or mark a dirty source clean merely because a push request was attempted.
6. Document the convenience-copy, divergence, expiry, recovery, and ordered-numbering contracts.

## Tests

- Full Docs JSON → markdown → request conversion → in-memory application/re-export cycles for nested unordered, ordered, mixed, three-level, `10.`-width, interrupted/resumed lists, and headings/inline formatting. Ordered cases fail before this work.
- List-followed-by-paragraph remains two structures; sequential numbering resets at the correct list and level boundaries; output never contains whitespace-only or trailing-whitespace lines.
- Dirty editable copy plus normal or diff read remains unchanged, writes `.remote.md`, and returns both paths; clean copy overwrites; first managed read creates baseline; unmanaged file with no baseline is never overwritten.
- Successful inline and `filePath` pushes refetch canonical Docs content/revision/fingerprint, then mint and reconcile a successor handle/baseline from that state; the next read does not produce a perpetual remote copy. Submitted markdown alone is never accepted as the baseline.
- TTL removes a clean expired handle workspace, but retains an expired dirty editable copy and its baseline/remote recovery material. Two handles for the same revision use distinct editable paths and may reference one shared immutable baseline.

## Acceptance criteria

- Reading and pushing unchanged markdown causes no ordered-list nesting loss, proven by an apply-and-re-export cycle.
- Sub-bullets remain nested and paragraphs after lists remain paragraphs; documented numbering loss is the only deliberate list projection loss.
- A caller's hand edits are never overwritten or TTL-deleted. A divergent remote response is preserved and named.
- The handle, baseline, editable, remote, and TTL rules agree with the migration and do not rely on HTTP sessions.

## Sequencing

After migration establishes opaque read handles and before #107's exported-markdown workflow. Coordinate with #96's markdown output behavior and #88/#108 only through the shared handle contract.
