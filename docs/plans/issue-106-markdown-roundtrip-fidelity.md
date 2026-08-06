# Plan: markdown round-trip fidelity and working-copy safety (#106)

Issue: [#106](https://github.com/karthikcsq/google-tools-mcp/issues/106) · Verified against `main` @ 7572a8b. **The reported symptoms are real; two of the three diagnoses in the issue are wrong, and the true cause is a different bug in the same file.**

## What verification found

### Confirmed: the working copy is clobbered on every read

`readDocument(format='markdown')` writes the working copy unconditionally at **two** sites — `readGoogleDoc.js:154` (normal read) and `:134` (even on a `diffFromLastRead` read, comment: *"Keep the on-disk working copy in sync even on diff reads"*) — with no existence, mtime, or content check anywhere. `writeWorkspaceFile` opens with `O_TRUNC` (`dist/workspace.js:104-105`), truncating whatever the caller had hand-edited. Since the documented workflow is literally "readDocument → edit that file → push it back", **any read between edit and push silently destroys the caller's work.** This is the mechanism behind "the file changed between calls".

### Not reproducible: "blank lines containing three trailing spaces"

`docsToMarkdown.js` has no code path that can emit a whitespace-only line. List items return `${indent}${marker} ${text.trim()}\n` (`:191`) — a single newline, i.e. a **tight** list; the indent is only ever prefixed to a line that already passed a `text.trim()` truthiness gate (`:188`); empty paragraphs return a bare `'\n'` (`:204`); the whole output is `.trim()`ed (`:170`). Empirically converting a nested list produces `"- A\n  - B\n    - C\n- D"`. The artifact the issue shows cannot come from this serializer — the likeliest explanation is the clobbering above replacing the author's file with a serialization of a document that had *already* been damaged by `modifyText` (#104). Treat as unreproducible pending a fixture; the clobber fix removes the mechanism that made it look like spontaneous mutation.

### Wrong diagnosis, real bug underneath: nesting *is* preserved on export — but ordered lists don't survive a round trip

The exporter reads `bullet.nestingLevel` and indents by it (`docsToMarkdown.js:188-192`, `getListInfo` `:218-237`). So "the exporter flattens nesting" is false. **But the indent width it emits is wrong for ordered lists**, and that breaks re-import:

- It emits **2 spaces per level** for both list kinds (`:189`).
- An ordered marker `1. ` occupies 3 columns, so a nested ordered item needs **3 spaces** to be a continuation of its parent's content block. At 2 spaces the markdown parser sees a sibling, not a child.
- Verified end to end: exporter output `"1. one\n  1. sub\n  1. sub2\n1. two"` re-imported through `convertMarkdownToRequests` yields inserts `["one","\n","sub","\n","sub2","\n","two","\n"]` — **zero tab characters, all four items at level 0**. The same content with 3 spaces yields `["one","\n","\t","sub","\n","two","\n"]` — nesting preserved. Unordered lists (`- ` marker, 2 columns) round-trip correctly at 2 spaces.

So a caller who reads a doc as markdown and pushes it back **loses every level of ordered-list nesting**, with no warning. That is the genuine "round-tripping and verification don't work" defect, and it is invisible from the Docs side because the write path is correct (`markdownToDocs.js:686-697, 1263-1277` build real nesting from tabs).

Two adjacent defects in the same region:

- **List → following paragraph has no blank separator.** `:191` ends a list item with one `\n` and the next paragraph is appended directly (`"- D\nAfter"`); re-imported, that paragraph is swallowed into the bullet as a lazy continuation. This is exactly the user-visible complaint quoted in the issue ("it treats them as extensions of the same line") — and it is a *serializer* bug, not a Docs bug.
- **Ordered-list numbering is always `1.`** (`:190`, hardcoded; `convertParagraph` is stateless per paragraph with no list-position context). Harmless for markdown semantics, but it makes exported documents unreadable as text and defeats human verification.

## Design decisions

- **Never clobber a modified working copy.** On read: if the target file exists and its content differs from what this server last wrote to it (tracked via the read-tracker snapshot, or a stored hash), do **not** overwrite. Instead write the fresh version to a sibling `<docId>.remote.md` and return both paths with a one-line note that local edits were preserved. Rationale: silently discarding user work is the worst available behavior; silently *keeping* a stale file would break the diff workflow; surfacing both is the only honest option. First read of a document (no local file) is unchanged. This supersedes #87's working-copy section, which handled *collisions between sessions* but not *the caller's own edits* — #87 has been updated to reference this rule.
- **Fix the indent width by marker width, not by a constant.** Indent per level = the parent marker's rendered width: 3 for ordered (`1. `), 2 for unordered (`- `). Compute from the ancestor chain rather than assuming a uniform kind, since mixed ordered/unordered nesting is legal. The importer's tab-based level detection then agrees with the exporter's output by construction.
- **Emit real ordered numbering.** Track a per-nesting-level counter in the conversion pass, reset when a level ends or the list id changes. `1.` is legal markdown but useless for verification, and the counter is also what makes indent-width computation correct for `10.`+ items (marker width grows) — one mechanism, two fixes.
- **Blank line after a list block** before a non-list paragraph.
- **Round-trip is the test contract, not an assertion detail.** The reason this shipped is that nothing ever tested markdown → Docs → markdown as a cycle. Add a property-style round-trip suite (below) — that is the durable fix; the three code corrections above are what it will initially catch.

## Implementation

1. `dist/markdown-transformer/docsToMarkdown.js`: marker-width-aware indentation and per-level ordered counters in the list-rendering path (`:176-204`, `getListInfo` `:218-237` gains the list-id/level context needed to reset counters); blank line between a list block and a following non-list paragraph.
2. `dist/workspace.js`: `writeWorkspaceFile` gains a no-clobber mode — compare against the last-written content/hash, divert to `<docId>.remote.md` on divergence, return which path was written.
3. `dist/tools/docs/readGoogleDoc.js:134,154`: use the no-clobber mode; extend the local-file advice string (`:171-179`) to explain the two-path outcome when it occurs.
4. Document the working-copy contract alongside #87's (convenience mirror; your edits are never destroyed; a divergent remote version appears as `.remote.md`).

## Tests

New `tests/markdownRoundTrip.test.js` — the missing contract:

- **Cycle fixtures**: for each of nested unordered, nested ordered, mixed ordered/unordered, deep (3-level), and `10.`+ numbering — Docs JSON → markdown → `convertMarkdownToRequests` → assert the reconstructed nesting levels (tab counts) equal the originals. The ordered cases fail today (verified) and are the regression guard.
- List followed by a paragraph → the paragraph is a separate paragraph, not a bullet continuation.
- Ordered numbering is sequential per level and resets correctly on level exit and list change.
- Exporter never emits a whitespace-only line and never emits trailing whitespace on any line (a direct assertion for #106's reported artifact, so if a path ever produces it the suite says so).
- Existing `tests/markdownTransformer.test.js` expectations updated where indent width changes — review each diff deliberately rather than mass-updating snapshots.
- Working copy: hand-modify the file, read again → original file untouched, `.remote.md` written, response names both; unmodified file → overwritten as before; first read → unchanged behavior; `diffFromLastRead` read → same no-clobber rule (today's `:134` write is the sharpest edge, since a diff read is exactly when a caller is mid-edit).

## Acceptance criteria

- A document read as markdown and pushed back unchanged produces no structural change — specifically, ordered-list nesting survives (the round-trip suite proves it).
- Sub-bullets remain sub-bullets and paragraphs after lists remain paragraphs.
- Exported ordered lists carry correct sequential numbers.
- A caller's hand-edits to the working copy are never destroyed by a subsequent read; when the remote has moved on, both versions are available and the response says so.
- The "blank line with trailing spaces" artifact has an explicit regression assertion, even though the original mechanism was not reproducible.

## Sequencing

Independent of the Gmail/config tracks. Coordinates with #87 (working-copy semantics — this plan owns the no-clobber rule, #87 owns session namespacing) and pairs naturally with #104/#107, since a correct round trip is how anyone verifies a structured edit worked.
