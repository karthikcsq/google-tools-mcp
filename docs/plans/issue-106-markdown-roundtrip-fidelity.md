# Plan: markdown round-trip fidelity and working-copy safety (#106)

Issue: [#106](https://github.com/karthikcsq/google-tools-mcp/issues/106) · Verified against `main` @ 7572a8b. Revised after adversarial review. **The reported symptoms are real; two of the three diagnoses in the issue are wrong, and the true cause is a different bug in the same file.**

## What verification found

### Confirmed: the working copy is clobbered on every read

`readDocument(format='markdown')` writes the working copy unconditionally at **two** sites — `readGoogleDoc.js:154` (normal read) and `:134` (even on a `diffFromLastRead` read, comment: *"Keep the on-disk working copy in sync even on diff reads"*) — with no existence, mtime, or content check. `writeWorkspaceFile` opens with `O_TRUNC` (`dist/workspace.js:104-105`). Since the documented workflow is "readDocument → edit that file → push it back", **any read between edit and push silently destroys the caller's work.**

### Not reproducible: "blank lines containing three trailing spaces"

`docsToMarkdown.js` has no path that can emit a whitespace-only line: list items return `${indent}${marker} ${text.trim()}\n` (`:191`) — a **tight** list; indent is only prefixed to a line that passed `text.trim()` (`:188`); empty paragraphs return bare `'\n'` (`:204`); output is `.trim()`ed (`:170`). Empirically a nested list converts to `"- A\n  - B\n    - C\n- D"`. The likeliest explanation is the clobbering above replacing the author's file with a serialization of a document `modifyText` had already damaged (#104). Treated as unreproducible pending a fixture; a regression assertion is added anyway.

### Wrong diagnosis, real bug underneath: nesting *is* exported — but ordered lists don't survive re-import

The exporter reads `bullet.nestingLevel` and indents by it (`:188-192`, `getListInfo` `:218-237`), so "the exporter flattens nesting" is false. **But the indent width is wrong for ordered lists:**

- It emits **2 spaces per level** for both list kinds (`:189`).
- An ordered marker `1. ` occupies 3 columns, so a nested ordered item needs **3 spaces** to sit in its parent's content block. At 2 spaces the parser sees a sibling.
- Verified end to end: `"1. one\n  1. sub\n  1. sub2\n1. two"` re-imported through `convertMarkdownToRequests` yields `["one","\n","sub","\n","sub2","\n","two","\n"]` — **zero tabs, all items at level 0**. With 3 spaces: `["one","\n","\t","sub","\n","two","\n"]` — nesting preserved. Unordered lists (`- `, 2 columns) round-trip correctly.

So markdown read → push back **loses every level of ordered-list nesting**, silently. Two adjacent defects:

- **List → following paragraph has no blank separator** (`:191` ends with one `\n`), so `"- D\nAfter"` re-imports with the paragraph swallowed into the bullet as a lazy continuation — exactly the "extensions of the same line" complaint in the issue.
- **Ordered numbering is always `1.`** (`:190`, hardcoded; `convertParagraph` is stateless per paragraph).

## Design decisions

- **Never clobber a modified working copy.** On read: if the file exists and its content differs from what this server last wrote, do **not** overwrite; write the fresh version to a sibling remote file and return both paths with a note. First read (no local file) is unchanged.
  - **Baseline tracking must be its own durable record, not the read tracker.** `readGoogleDoc` updates the tracker *before* writing the workspace file (`:119-134`), so the tracker snapshot is not necessarily what is on disk. Store a sidecar `<workspaceFile>.sha256` (or a small JSON manifest in the workspace dir) written atomically **after** each successful workspace write; "modified" = file hash ≠ recorded hash. An existing file with **no recorded baseline** is treated as user-owned (divert, don't overwrite) — the safe default.
  - **Filename composes with #87's session suffix**, resolving the conflict between the two plans: canonical `<docId>[.<tabId>][.<session>].md`, remote `<docId>[.<tabId>][.<session>].remote.md`. #87's disconnect cleanup glob must match both (`*.<session>.md` and `*.<session>.remote.md`) — stated in both plans.
  - **Push closes the loop.** After a successful `replaceDocumentWithMarkdown`, update the baseline for the canonical file to the pushed content — including the `filePath` branch, which today mirrors only when `!args.filePath` (`replaceDocumentWithMarkdown.js:212-225`). Without this, the documented edit-and-push workflow would mark the file divergent forever and spawn a `.remote.md` on every subsequent read.
- **Indent width derived from marker width, not a constant.** Per level, indent by the *parent's* rendered marker width: 3 for `1. `, 2 for `- `, and wider for `10.`+ — which is why numbering and indentation must be computed in the same pass. Mixed ordered/unordered nesting resolves per ancestor.
- **Ordered numbering: normalized decimal, stated as the contract.** Correction from review: the exporter cannot faithfully reproduce Docs numbering — `getListInfo` derives only `ordered` from `glyphType` (`:218-236`) and has no access to restart values or alpha/Roman formats. Markdown cannot express most of them anyway. So the contract is: **ordered lists export as sequential decimal per level, starting at 1**; alpha/Roman/restart information is a known, documented export loss (it is preserved in the *document* and only absent from the markdown projection). Say so in the fidelity notes rather than implying full fidelity.
- **Blank line after a list block** before a non-list paragraph.
- **Round-trip is the test contract.** This shipped because nothing tested markdown → Docs → markdown as a cycle.

## Implementation

1. `dist/markdown-transformer/docsToMarkdown.js`: **the stateful pass lives in the outer loop.** `docsJsonToMarkdown` (`:146-170`) currently calls a stateless `convertParagraph` (`:176-204`); introduce a conversion-state object (per-level counters, ancestor marker widths, current `listId`) threaded from the loop into `convertParagraph`/`getListInfo`, with resets on list-id change, level exit, and list interruption by a non-list element. Marker-width indentation and sequential numbering both read from that state.
2. `dist/workspace.js`: no-clobber write mode + atomic baseline sidecar; `deleteSessionWorkspaceFiles` (from #87) extended to remove baselines and `.remote.md`.
3. `readGoogleDoc.js:134,154`: no-clobber mode; local-file advice string (`:171-179`) explains the two-path outcome.
4. `replaceDocumentWithMarkdown.js:212-225`: baseline update on success for both the inline-markdown and `filePath` branches.
5. Document the working-copy contract (convenience mirror; your edits are never destroyed; divergent remote appears as `.remote.md`) and the ordered-numbering export loss.

## Tests

New `tests/markdownRoundTrip.test.js` — the missing contract. **Full cycle, not half of one:** Docs JSON → markdown → `convertMarkdownToRequests` → **apply the requests to an in-memory Docs model** (or assert against the request stream *and* re-export the resulting structure) → markdown again, comparing structure. Asserting tab counts alone would pass while the real `readDocument → replaceDocumentWithMarkdown` workflow still changes structure, since `insertMarkdown` converts and batch-updates separately (`markdown-transformer/index.js:120-147`).

- Cycle fixtures: nested unordered, nested ordered, mixed ordered/unordered, 3-level deep, `10.`+ numbering (marker-width edge), list interrupted by a paragraph then resumed, headings + inline formatting alongside lists. Ordered cases fail today — the regression guard.
- List followed by a paragraph → separate paragraph, not a bullet continuation.
- Numbering sequential per level, resetting on level exit and list change.
- Exporter never emits a whitespace-only line or trailing whitespace on any line (#106's reported artifact).
- Existing `tests/markdownTransformer.test.js` expectations reviewed diff-by-diff where indent width changes — no blanket snapshot updates.
- Working copy: hand-modified file + read → original untouched, `.remote.md` written, both paths named; unmodified file → overwritten; first read → unchanged; **no recorded baseline → treated as user-owned**; `diffFromLastRead` read → same rule (today's `:134` write is the sharpest edge, since a diff read is exactly when a caller is mid-edit); **successful push via `filePath` → baseline updated, and the next read does not create a `.remote.md`**; session suffix composes with #87's naming and cleanup removes all three file kinds.

## Acceptance criteria

- A document read as markdown and pushed back unchanged produces no structural change — ordered-list nesting survives, proven by a full apply-and-re-export cycle.
- Sub-bullets remain sub-bullets; paragraphs after lists remain paragraphs.
- Exported ordered lists carry sequential numbers; the alpha/Roman/restart export loss is documented, not silent.
- A caller's hand-edits are never destroyed by a read; after a successful push the workflow settles (no perpetual `.remote.md`).
- The trailing-whitespace artifact has a regression assertion despite being unreproducible.

## Sequencing

Independent of the Gmail/config tracks. Owns the no-clobber rule; #87 owns session namespacing and must match the composed filenames and cleanup glob. **#107's read→export→replace test depends on this landing first** — otherwise a section replace fed by exported markdown inherits the ordered-list flattening.
