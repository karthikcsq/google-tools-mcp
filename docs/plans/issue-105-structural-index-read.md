# Plan: an affordable way to get document indices (#105)

Issue: [#105](https://github.com/karthikcsq/google-tools-mcp/issues/105) · Verified against `main` @ 7572a8b. Revised after adversarial review.

## Migration boundary

The MCP migration owns the first internal structural walker and fingerprint needed for stateless opaque-read-handle guarding. #105 remains the owner of the **public** `readDocument(format:'index')` contract: its narrow field masks, element serialization, budget/pagination, documentation pointers, and index-addressing tests. Reuse or refine the migration walker after its final runtime cutover; do not fork a second traversal.

## Root cause

**Seven places in the tool surface instruct callers to use `readDocument format='json'` to find indices, and that read mode returns the raw Docs API document with no field pruning.** Verified:

- The mask is `'*'` — "Get everything for structure analysis" (`dist/tools/docs/readGoogleDoc.js:58-65`) — and the whole response object is stringified at 2-space indent (`:95`, `contentSource = res.data` at `:88`). Nothing strips inherited `textStyle`/`paragraphStyle`, `suggested*` maps, `namedStyles`, `inlineObjects`, or `positionedObjects`. Hence 1.36 MB for 9.6 KB of text.
- The instruction appears in `modifyText.js:101`, `deleteRange.js:11`, `insertPageBreak.js:16`, `insertImage.js:25`, `insertTable.js:18`, `insertTableWithData.js:88`, and a runtime error string at `googleDocsApiHelpers.js:799`.
- **No lightweight structural view exists.** `getFormatting` requires a target range (`formatting/getFormatting.js:15-23` — no whole-document mode), skips every non-paragraph element (`:34`), and never emits `nestingLevel`.
- Docs tools have **no response budget**: `DEFAULT_MAX_RESPONSE_CHARS` / `capToResponseBudget` (`helpers.js:439-534`) are imported only by `gmail/threads.js:5`.

**One claim in the issue is wrong and the correction matters:** `maxLength` *is* applied to the json path (`readGoogleDoc.js:96-101`). What is broken is that it has **no default** (`:38-41`) and its description says *"Maximum character limit for text output."*, so a caller has no reason to think it applies to json; and the truncation is a blind `substring` producing invalid JSON — useless for index discovery even when it fires.

Root cause: **the index-based tools have no affordable addressing surface, and the documentation points at the most expensive possible one.**

## Design decisions

- **Add `format: 'index'` to `readDocument`** rather than a new tool. Output — one entry per structural element:
  ```json
  {"elements":[{"start":1,"end":42,"type":"heading","level":1,"nesting":null,"preview":"To Do List"},
               {"start":42,"end":97,"type":"listItem","ordered":true,"nesting":1,"preview":"Follow up on the table…"},
               {"start":97,"end":150,"type":"table","rows":3,"columns":2,"cells":[{"start":99,"end":118,"row":0,"col":0,"preview":"Name"}]},
               {"start":150,"end":151,"type":"horizontalRule"}],
   "documentEnd":151,"revisionId":"…","truncated":false}
  ```
- **Element typing is one entry per element, most specific type wins** — a paragraph is exactly one of `heading` | `listItem` | `paragraph`, never two (mirroring `docsToMarkdown.js:176-204`, where heading and list classification are already mutually exclusive). Ranges never overlap **except** table cells, which are nested inside their table entry as a `cells` array with their own indices — because cell content is separately addressable and callers editing table text need those indices. Document the nesting rule explicitly so callers can flatten or ignore.
- **`nesting` is included** — the field that answers #104/#107's structural questions and the one `getFormatting` conspicuously lacks.
- **Field masks, corrected to the real API shape.** Tables are `tableRows`/`tableCells`, not `rows`/`columns` (`googleDocsApiHelpers.js:274-283, 802-811`). Legacy body:
  `revisionId,body.content(startIndex,endIndex,paragraph(paragraphStyle(namedStyleType),bullet(listId,nestingLevel),elements(startIndex,endIndex,textRun(content),inlineObjectElement(inlineObjectId),horizontalRule)),table(rows,columns,tableRows(startIndex,endIndex,tableCells(startIndex,endIndex,content(paragraph(elements(textRun(content))))))),sectionBreak,tableOfContents),lists(listProperties(nestingLevels(glyphType)))`.
  **Tabs use a narrow tab mask, not `'*'`** — today `includeTabsContent` forces `fields:'*'` (`readGoogleDoc.js:56-65`), which would silently defeat the entire affordability claim for tabbed documents; index mode passes `tabs(tabProperties(tabId),documentTab(<the same body/lists subtree>))`. `revisionId` is in both masks so the migration can mint an HTTP opaque handle bound to the exact read, or update only the pinned stdio connection's implicit state; index-then-write therefore follows the same authorization contract as text-then-write.
- **A real response budget.** `maxResponseChars` defaulting to `DEFAULT_MAX_RESPONSE_CHARS` (`helpers.js:439`), truncating at **element boundaries** with `truncated: true`.
  **Pagination is explicit, and honest about its cost:** the Docs API has no start-index cursor, so resumption cannot avoid refetching. Add `fromIndex` (default 0): the fetch is the same narrow-mask call, and elements ending at or before `fromIndex` are dropped locally before serialization; the response returns `nextFromIndex` when truncated. So pagination costs one (cheap, narrow) fetch per page and is gap-free by construction because slicing happens on a single consistent snapshot per call. State the refetch cost in the description rather than implying a free cursor.
- **`format:'json'` stays the raw escape hatch and stays raw.** Pruning would change the meaning of the mode callers use precisely when they need everything (suggestions, style provenance). So: (a) `maxLength`'s description corrected to say it applies to text, markdown, **and json**, with `0`/negative explicitly documented and validated — `.int().positive()` on the schema, rejecting `0`/negatives instead of today's ambiguous falsy-means-unlimited (`:38-41`); (b) when json output would exceed the response budget and no `maxLength` was given, fail with a **directive** error naming `format='index'` and `maxLength`, instead of emitting 1.36 MB; (c) `stripInheritedStyles` is offered as an **opt-in** (default `false`) for callers who want a smaller raw document — not a silent default change to a mode whose contract is fidelity.
- **Retarget the seven pointers** to `format='index'`. This is the actual user-visible fix — the recommended workflow must be one that completes.
- **`textToFind` diagnostics.** Correction from review: the divergence data is *not* currently in hand — `findTextRange` logs a generic failure and returns `null` (`googleDocsApiHelpers.js:486-489`), and callers convert that into their own message (`modifyText.js:149-152`). So this requires a real change: the helper returns a structured failure `{ found: false, bestPrefixLength, divergenceIndex, contextBefore, contextAfter, candidateCount }`, and **each caller is updated** to render it. Threading that through is part of the work, not a logging tweak.

## Implementation

1. `readGoogleDoc.js`: `'index'` format; the two narrow masks above; expose the migration-owned structural walker through a public serializer for paragraphs, lists, tables + cells, section breaks, TOC, inline-object anchors, and horizontal rules; budget-capped serialization with `truncated`/`nextFromIndex`; `fromIndex` slicing; return the migration-minted opaque `readHandle` for HTTP and update only the pinned stdio connection's implicit read state.
2. `maxLength` description + `.positive()` validation; json budget-exceeded directive error; opt-in `stripInheritedStyles`.
3. Retarget six tool descriptions + the `googleDocsApiHelpers.js:799` error string.
4. `findTextRange` structured failure + caller rendering (`modifyText.js:149-152` and any other consumer).
5. Export the public index serializer/walker API — #107's `afterHeading` resolution and #88's post-write heading map both consume it (one implementation, three consumers).

## Tests

- Index mode on a fixture with headings, nested ordered + unordered lists, a table with cell text, an inline image, a section break, and a horizontal rule → every element present with correct `start`/`end`/`type`/`nesting`; **table cells carry their own indices**; output < 5% of the json mode's size for the same fixture.
- **Index semantics parity:** ranges returned by index mode are end-exclusive in the same sense the mutating tools expect — assert an index-mode range fed to `deleteRange`/`modifyText` targets exactly the intended element on the fixture (guards against off-by-one against `googleDocsApiHelpers.js:562-568`).
- Tabs: index mode on a tabbed fixture returns tab-local indices **and** issues the narrow tab mask (assert the request's `fields`, not just the output — the affordability claim is about the fetch).
- `revisionId` present in both masks; an HTTP index read returns an opaque handle accepted only for its bound principal/profile/file/tab/revision/fingerprint, while a pinned stdio index read seeds only that connection's implicit state.
- Budget/pagination: oversized fixture truncates at an element boundary with valid JSON; `fromIndex` resumption returns the remaining elements with no gap or overlap; the response documents the refetch.
- `format:'json'`: `maxLength` honored (pin existing); `0`/negative rejected by schema; oversized without `maxLength` → directive error naming `format='index'`; `stripInheritedStyles` **off** by default (raw fidelity preserved), and when on, preserves every `startIndex`/`endIndex`.
- Description consistency: a grep-style assertion that no tool description or error string recommends `format='json'` for index discovery.
- `findTextRange` failure: near-miss multi-line search returns the structured failure and `modifyText` renders the divergence position; exact match still succeeds through all four fallback strategies.

## Acceptance criteria

- Getting indices for a `modifyText` call on a 10 KB document costs one narrow call and a few KB — including for tabbed documents, where the *fetch* is narrow too.
- The index view reports list nesting and table-cell addresses, so callers can reason about structure before editing.
- No documented workflow points at a read mode that cannot complete.
- Large documents paginate at element boundaries with valid JSON at every step, with the refetch cost stated.
- `format:'json'` still returns a faithful raw document by default.
- A failed `textToFind` tells the caller where matching diverged.

## Sequencing

After migration, and the enabler for #104/#107/#108. The migration supplies the internal walker; this issue makes it a bounded user-facing index response. **Supersedes `listHeadings` from #88** — that plan consumes this public walker.
