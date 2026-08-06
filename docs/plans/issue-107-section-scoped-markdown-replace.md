# Plan: section-scoped markdown replace (#107, canonical for #104)

Issues: [#107](https://github.com/karthikcsq/google-tools-mcp/issues/107) (canonical) and [#104](https://github.com/karthikcsq/google-tools-mcp/issues/104) (list-nesting flattening — same root cause) · Verified against `main` @ 7572a8b.

## Root cause

There is **no way to write structured content into a sub-range of a document.** Every write path is at one of two extremes:

| path | builds real list/heading structure | scope |
|---|---|---|
| `replaceDocumentWithMarkdown` | yes | whole body only |
| `appendMarkdownToGoogleDoc` | yes | end of document only |
| `modifyText` | **no** | any range |

`modifyText` flattens structure because it is text-only by construction (`dist/tools/docs/modifyText.js:44-94`): a multi-line replacement emits **one** `insertText` with the whole blob plus **one** `updateParagraphStyle` over the entire inserted range (`:79-92`), so every resulting paragraph inherits the style at the range start. It emits no `createParagraphBullets` at all — verified: the only Docs-side bullet requests in the entire tree are `markdownToDocs.js:1272` (the markdown pipeline) and `replaceDocumentWithMarkdown.js:152` (a `deleteParagraphBullets` cleanup). And no nesting lever is exposed: `ParagraphStyleParameters` (`dist/types.js:101-132`) accepts exactly `alignment, indentStart, indentEnd, spaceAbove, spaceBelow, namedStyleType, keepWithNext` — `indentStart` moves text in **points**, which is why #104's attempted workaround produced indented text carrying flat top-level numbering.

So the documented advice loops: `replaceDocumentWithMarkdown` warns "⚠️ FORMATTING LOSS … Consider using modifyText or appendMarkdown for targeted edits instead", and `modifyText` says "For multi-line or section-level rewrites, use replaceDocumentWithMarkdown instead." Each tool points at the other; neither can do a structured section rewrite.

**The machinery already exists and is fully index-parameterized.** `insertMarkdown` (`dist/markdown-transformer/index.js:91-156`) takes `options.startIndex` (`:93`) and forwards it verbatim to `convertMarkdownToRequests` (`:120`); the converter builds true nesting by inserting literal `\t` per level (`markdownToDocs.js:686-688`) and emitting merged `createParagraphBullets` ranges bottom-to-top to avoid index shift (`:1244-1277`). All three existing callers pass only `1` or end-of-document (`replaceDocumentWithMarkdown.js:196-198`, `appendMarkdownToGoogleDoc.js:113-115`, `createDocument.js:63-66`). **Nothing is missing but a tool surface that passes an arbitrary range.**

## Design decisions

- **One new tool, `replaceRangeWithMarkdown`** — delete a resolved range, then `insertMarkdown` at its start. That is exactly what `replaceDocumentWithMarkdown` does, minus "the range is the whole body", so the implementation is a generalization of an existing, tested flow rather than new machinery.
- **Range resolution: three addressing modes**, in the order callers will reach for them:
  1. `{ startIndex, endIndex }` — explicit, for callers who have indices (see #105 for how they get them affordably).
  2. `{ afterHeading: "To Do List", untilNextHeadingOfLevel: 1 }` — the shape #107 asks for. Resolve via the heading map (shared with #105's index mode / #88's extraction): find the heading paragraph whose text matches, start **after** its paragraph end, run until the next heading at ≤ that level, or body end.
  3. `{ textToFind, matchInstance? }` — reuse `findTextRange` (`googleDocsApiHelpers.js:401-510`) with its existing fallback chain.
  Ambiguous heading text → `UserError` listing candidates with their indices, matching `findTextRange`'s existing multi-match behavior (`:492-496`).
- **`preserveHeading` (default true)** for the `afterHeading` mode: the heading paragraph itself is never inside the replaced range, so "rewrite this section" cannot accidentally delete the section title.
- **Fidelity warning is scoped to the range, and blocks by default.** `replaceDocumentWithMarkdown`'s whole-document warning is what pushed #107's author toward the wrong tool. Here, run `checkMarkdownFidelity` (`docsToMarkdown.js:65-115`) **only over the target range**: if the range contains images/horizontal rules/other unrepresentable content, that content will be destroyed — so default `onFidelityLoss: 'block'` (throw, naming what would be lost), with `'warn'` to proceed. Ranges that contain no such content — the common "rewrite this list" case — proceed silently, which is precisely the case that has no working tool today.
- **Reuse the existing guard/WriteControl chain** exactly as `replaceDocumentWithMarkdown.js:40-49, 65-72, 210-211` does, including #87's revision-first signal once landed.
- **Not a new `modifyText` mode.** Keeping it separate preserves `modifyText`'s cheap text-only contract and avoids a parameter that silently changes what the tool does to document structure.
- **`nestingLevel` on `paragraphStyle`: deliberately NOT the fix, but shipped as a small escape hatch.** #104 offers it as an alternative; on its own it is a trap — `createParagraphBullets` has no `nestingLevel` field, so honoring it means synthesizing tab characters and bullet requests inside `modifyText`, i.e. rebuilding the markdown pipeline badly. Instead expose **`bulletNestingLevel`** on `applyParagraphStyle` only (the dedicated formatting tool, `formatting/applyParagraphStyle.js`), implemented as `deleteParagraphBullets` + tab adjustment + `createParagraphBullets` over whole paragraphs — an honest structural operation in a structural tool, useful for repairing existing lists. `modifyText`'s `paragraphStyle` stays text-styling only, and its description gains a pointer to `replaceRangeWithMarkdown` for structured multi-line work.
- **Also fixes the "insertMarkdown at an index" gap** #107 mentions: `replaceRangeWithMarkdown` with `startIndex == endIndex` is an insertion. Document that explicitly rather than adding a second tool.

## Implementation

1. `dist/tools/docs/replaceRangeWithMarkdown.js`: schema (`documentId`, `markdown` | `filePath`, one of the three range shapes, `tabId?`, `preserveHeading`, `onFidelityLoss`, `dryRun` — sharing #88's dryRun contract); resolve range → guard → range-scoped fidelity check → `deleteContentRange` → `insertMarkdown({ startIndex })` → `trackMutation`. Register in `dist/tools/docs/index.js`.
2. Shared heading-map helper (same one #105/#88 need) for `afterHeading` resolution — one implementation, three consumers.
3. `bulletNestingLevel` on `applyParagraphStyle`.
4. Description updates that break the referral loop: `replaceDocumentWithMarkdown`'s fidelity warning should name `replaceRangeWithMarkdown` as the targeted-and-structure-preserving option; `modifyText` should say it is text-only and point at the new tool for multi-line/list content.
5. Count bookkeeping: +1 tool (+1 more if counting from a baseline where #86/#88 landed) in `tests/toolRegistration.test.js` and the README docs-category list.

## Tests

`tests/replaceRangeWithMarkdown.test.js`, mocking `dist/clients.js`:

- **The #104 regression, end to end:** a nested ordered list fixture replaced with nested markdown → emitted requests include `createParagraphBullets` and per-level `\t` inserts; assert nesting levels survive (this is the assertion whose absence let #104 ship).
- Range modes: explicit indices; `afterHeading` + `untilNextHeadingOfLevel` (including "last section runs to body end", "next heading is deeper so it is included", "ambiguous heading → UserError listing candidates"); `textToFind`.
- `preserveHeading`: heading paragraph untouched; `false` includes it.
- Insertion mode (`startIndex == endIndex`) inserts without deleting.
- Fidelity: range containing an image → blocks by default naming the image; `onFidelityLoss:'warn'` proceeds; **range containing none while the rest of the document has 4 images and 5 rules → proceeds with no warning** (the exact #107 scenario).
- Content outside the range is byte-identical after the write (fixture assertion on the full request set — nothing targets outside `[start,end)`).
- Guard/WriteControl parity with `replaceDocumentWithMarkdown` (unread doc rejected; revision chain advanced).
- `applyParagraphStyle` `bulletNestingLevel`: emits delete+create bullets with correct tab adjustment; round-trips a flattened list back to nested.

## Acceptance criteria

- Rewriting one section of a document with nested markdown preserves that section's list nesting **and** leaves images, rules, and every other section untouched — the #107 scenario, provable in one call.
- A multi-line list replacement no longer flattens nesting (#104's repro produces correct levels).
- The fidelity warning no longer routes callers to a tool that cannot do the job: whole-document loss warnings name the range-scoped tool.
- `modifyText` remains text-only and says so; callers have a documented path for structured edits at any index, including pure insertion mid-document.

## Sequencing

After #87 (guard signal) and alongside #88 (shares `dryRun` and the heading-map helper; #88's `batchModifyText` remains the right tool for many *small text* edits, this one for *structured* content). #105's index mode makes the explicit-index addressing mode practical.
