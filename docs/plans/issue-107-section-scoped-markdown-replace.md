# Plan: section-scoped markdown replace (#107, canonical for #104)

Issues: [#107](https://github.com/karthikcsq/google-tools-mcp/issues/107) (canonical) and [#104](https://github.com/karthikcsq/google-tools-mcp/issues/104) (list-nesting flattening — same root cause) · Verified against `main` @ 7572a8b. Revised after adversarial review.

## Root cause

There is **no way to write structured content into a sub-range of a document.** Every write path is at one of two extremes:

| path | builds real list/heading structure | scope |
|---|---|---|
| `replaceDocumentWithMarkdown` | yes | whole body (or body-after-title) |
| `appendMarkdownToGoogleDoc` | yes | end of document only |
| `modifyText` | **no** | any range |

`modifyText` flattens structure by construction (`dist/tools/docs/modifyText.js:44-94`): a multi-line replacement emits **one** `insertText` with the whole blob plus **one** `updateParagraphStyle` over the entire inserted range (`:79-92`), so every resulting paragraph inherits the style at the range start. It emits no `createParagraphBullets` — the only Docs-side bullet requests in the tree are `markdownToDocs.js:1272` (markdown pipeline) and `replaceDocumentWithMarkdown.js:152` (a `deleteParagraphBullets` cleanup). No nesting lever is exposed either: `ParagraphStyleParameters` (`dist/types.js:101-132`) accepts exactly `alignment, indentStart, indentEnd, spaceAbove, spaceBelow, namedStyleType, keepWithNext` — `indentStart` moves text in **points**, which is why #104's workaround produced indented text with flat top-level numbering.

The documented advice loops: `replaceDocumentWithMarkdown`'s fidelity warning says "Consider using modifyText or appendMarkdown for targeted edits instead", and `modifyText` says "For multi-line or section-level rewrites, use replaceDocumentWithMarkdown instead."

**The machinery exists and is index-parameterized.** `insertMarkdown` (`markdown-transformer/index.js:91-156`) takes `options.startIndex` (`:93`) and forwards it to `convertMarkdownToRequests` (`:120`); the converter builds true nesting from literal `\t` per level (`markdownToDocs.js:686-697`) and merged `createParagraphBullets` ranges applied bottom-to-top (`:1244-1277`). Existing callers pass `1`, the first paragraph's end under `preserveTitle` (`replaceDocumentWithMarkdown.js:99-106, 196-203`), end-of-document (`appendMarkdownToGoogleDoc.js:113-115`), or `1` on a new doc (`createDocument.js:63-66`) — i.e. **the parameter is already exercised with a non-trivial index; what is missing is a tool that accepts a caller-chosen range.**

## Design decisions

- **One new tool, `replaceRangeWithMarkdown`** — a generalization of `replaceDocumentWithMarkdown`'s flow, not new machinery.
- **The full sequence is delete → survivor cleanup → insert**, not delete → insert. Correction from review: `replaceDocumentWithMarkdown` deliberately strips residual bullets and text styles from the surviving paragraph before inserting (`:123-192`, `deleteParagraphBullets` at `:152` plus an `updateTextStyle` reset) — precisely because a survivor carrying old list membership corrupts the inserted structure. Replacing a list range hits exactly that case, so the cleanup step is mandatory here, scoped to the paragraph(s) touching the range boundaries.
- **Range resolution: three addressing modes.**
  1. `{ startIndex, endIndex }` — explicit (see #105 for affordable discovery).
  2. `{ afterHeading, untilNextHeadingOfLevel }` — **matches on full heading text, not #105's 60-char `preview`**, and normalizes whitespace/case-insensitively; the resolver reads full text from the element walker rather than the preview field (the preview is a display affordance and would silently mis-match long headings). Supports `headingId` as an alternative exact selector. Range starts after the heading paragraph's `endIndex` and runs to the next heading at ≤ the given level, or body end. `preserveHeading: false` moves the start to the heading paragraph's `startIndex` (i.e. the heading is replaced too) — stated explicitly because it changes the boundary, not just a flag.
  3. `{ textToFind, matchInstance? }` — reuse `findTextRange` (`googleDocsApiHelpers.js:401-510`).
  Ambiguous heading text → `UserError` listing candidates with indices, matching `findTextRange`'s existing behavior (`:492-496`).
- **Range validation before anything destructive.** The resolved range must be *structurally valid*: it may not start or end inside a table (partial table/cell ranges are rejected with a message naming the table), may not split a paragraph unless the mode is explicit-index (where a mid-paragraph range is legitimate), and may not extend past the body's final required paragraph. Fidelity scanning reuses `checkMarkdownFidelity`'s recursive walk (`docsToMarkdown.js:92-118`) **restricted to elements fully inside the range**, with partially-covered elements reported as boundary violations rather than silently included.
- **Fidelity loss blocks by default within the range.** `onFidelityLoss: 'block' | 'warn'` (default `block`): a range containing images/rules/unrepresentable content throws, naming what would be lost; ranges without such content — the common "rewrite this list" case — proceed silently. This is the direct fix for the referral loop that sent #107's author to the wrong tool.
- **Partial-write exposure is bounded and reported.** Like the whole-body tool, delete/cleanup/insert are separate guarded calls, so an insert failure after a successful delete leaves the section missing (the whole-body equivalent is pinned by `tests/replaceDocumentWithMarkdown.test.js:115-140`). Mitigations in scope: `dryRun` first; the error on insert-failure states the section was deleted, names the exact range, and **echoes the markdown that failed to insert** so the caller can retry without reconstructing it. A transactional single-batchUpdate replace is filed as the shared follow-up with #88.
- **Reuse the guard/WriteControl chain** exactly as `replaceDocumentWithMarkdown.js:40-49, 65-72, 210-211`, including #87's revision-first signal.
- **Not a `modifyText` mode** — keeps `modifyText`'s cheap text-only contract intact.
- **`nestingLevel` on `paragraphStyle`: deliberately not the fix; ship `bulletNestingLevel` on `applyParagraphStyle` instead, fully specified.** `createParagraphBullets` has no `nestingLevel` field, so honoring it means synthesizing tabs and bullet requests — rebuilding the markdown pipeline badly inside a text tool. Instead, on `applyParagraphStyle` (whose schema is `dist/types.js:145-161` and which today builds exactly one paragraph-style request, `formatting/applyParagraphStyle.js:61-70`), add `bulletNestingLevel: z.number().int().min(0).max(8)` with a defined multi-request implementation: resolve the target to **whole paragraphs** (reject partial-paragraph ranges), `deleteParagraphBullets` over them, adjust leading tab characters to the requested depth (insert/delete text at each paragraph start), then `createParagraphBullets` with the preset inferred from the existing list (or an explicit `bulletPreset` parameter when the paragraphs are not currently list items). All requests go in one `batchUpdate` under the existing guard and WriteControl chain (`applyParagraphStyle.js:68`); mixed-list ranges (paragraphs belonging to different `listId`s) are rejected rather than silently merged.
- **Also covers "insert markdown at an index"** (#107's closing note): `startIndex == endIndex` is an insertion — documented, not a second tool.

## Implementation

1. `dist/tools/docs/replaceRangeWithMarkdown.js`: schema (`documentId`, `markdown` | `filePath`, one range shape, `tabId?`, `preserveHeading`, `onFidelityLoss`, `dryRun` sharing #88's contract); resolve → validate structure → guard → range-scoped fidelity → delete → boundary survivor cleanup → `insertMarkdown({startIndex})` → `trackMutation`. Register in `docs/index.js`.
2. Consume #105's element walker for heading resolution (full text, not preview).
3. `bulletNestingLevel` on `applyParagraphStyle` per the spec above.
4. Description fixes that break the referral loop: `replaceDocumentWithMarkdown`'s warning names `replaceRangeWithMarkdown`; `modifyText` states it is text-only and points here for multi-line/list content.
5. Count bookkeeping: +1 tool in `tests/toolRegistration.test.js` and the README docs-category list.

## Tests

`tests/replaceRangeWithMarkdown.test.js`, mocking `dist/clients.js`:

- **The #104 regression:** nested ordered list range replaced with nested markdown → requests include `createParagraphBullets` and per-level `\t` inserts; nesting levels survive.
- **The real workflow, end to end:** `readDocument(markdown)` output of a nested-list fixture fed straight back into `replaceRangeWithMarkdown` → nesting preserved. This depends on #106's indent-width fix; until that lands the test documents the dependency by failing for the #106 reason, not this tool's.
- Survivor cleanup: replacing a range whose boundary paragraph is a list item → `deleteParagraphBullets` + style reset emitted before insertion; inserted content does not inherit the old list.
- Range modes: explicit indices; `afterHeading` (+ last-section-to-body-end, deeper-following-heading included, ambiguous → UserError with candidates, **heading longer than 60 chars matches correctly**); `headingId`; `textToFind`.
- `preserveHeading` true/false change the start boundary as specified.
- Insertion mode (`start == end`) inserts without deleting.
- Range validation: range starting inside a table cell → rejected naming the table; range past the final paragraph → rejected; mid-paragraph range allowed only in explicit-index mode.
- Fidelity: image inside range → blocks naming it; `warn` proceeds; **range clean while the rest of the document has 4 images and 5 rules → proceeds silently** (the #107 scenario).
- Content outside the range untouched (assert no request targets outside `[start,end)`).
- Insert-failure-after-delete → error names the range and echoes the markdown.
- Guard/WriteControl parity (unread doc rejected; revision chain advanced).
- `bulletNestingLevel`: whole-paragraph resolution; tab adjustment up and down; preset inferred from existing list; explicit preset for non-list paragraphs; partial-paragraph range rejected; mixed-`listId` range rejected; single `batchUpdate` under the guard.

## Acceptance criteria

- Rewriting one section with nested markdown preserves that section's nesting **and** leaves images, rules, and other sections untouched — one call.
- #104's repro produces correct nesting levels.
- Fidelity warnings no longer route callers to a tool that cannot do the job.
- `modifyText` stays text-only and says so; structured edits at any index, including mid-document insertion, have a documented path.
- A failed insert after delete tells the caller exactly what was removed and hands back the content to retry.

## Sequencing

After #87 (guard signal), #105 (element walker), and **#106** (so exported markdown round-trips). Alongside #88 (shared `dryRun`; `batchModifyText` for many small *text* edits, this tool for *structured* content). Shared follow-up with #88: transactional single-batchUpdate replace.
