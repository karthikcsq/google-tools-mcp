# Plan: an affordable way to get document indices (#105)

Issue: [#105](https://github.com/karthikcsq/google-tools-mcp/issues/105) · Verified against `main` @ 7572a8b.

## Root cause

**Seven places in the tool surface instruct callers to use `readDocument format='json'` to find indices, and that read mode returns the raw Docs API document with no field pruning.** Verified:

- The mask is `'*'` — "Get everything for structure analysis" (`dist/tools/docs/readGoogleDoc.js:58-65`) — and the whole response object is stringified at 2-space indent (`:95`, `contentSource = res.data` at `:88`). Nothing strips inherited `textStyle`/`paragraphStyle` objects, `suggested*` maps, `namedStyles`, `inlineObjects`, or `positionedObjects`. Hence 1.36 MB for 9.6 KB of text.
- The instruction appears in `modifyText.js:101`, `deleteRange.js:11`, `insertPageBreak.js:16`, `insertImage.js:25`, `insertTable.js:18`, `insertTableWithData.js:88`, and a runtime error string at `googleDocsApiHelpers.js:799`.
- **No lightweight structural view exists.** `getFormatting` (`formatting/getFormatting.js`) is the closest, but it *requires* a target range (`:15-23` — no whole-document mode), skips every non-paragraph element (`:34`), and never emits `nestingLevel`. `listDocumentTabs` returns only tab-level metadata.
- Docs tools have **no response budget at all**: `DEFAULT_MAX_RESPONSE_CHARS` / `capToResponseBudget` (`helpers.js:439-534`) are imported only by `gmail/threads.js:5`.

**One claim in the issue is wrong and the correction matters:** `maxLength` *is* applied to the json path (`readGoogleDoc.js:96-101`). What is actually broken is that it has **no default** (`:38-41`) and its description says *"Maximum character limit for text output."* — so a caller has no reason to think it applies to json, and omitting it returns the full payload. The truncation is also a blind `substring`, producing invalid JSON — useless for index discovery even when it does fire.

So the root cause is not "json is big"; it is that **the index-based tools have no affordable addressing surface, and the documentation points at the most expensive possible one.**

## Design decisions

- **Add `format: 'index'` to `readDocument`** rather than a new tool: index discovery is a *read* of the same document, callers already reach for `readDocument`, and it inherits `tabId`/`maxLength` handling. Output — one entry per structural element, as compact JSON:
  ```json
  {"elements":[{"start":1,"end":42,"type":"heading","level":1,"nesting":null,"preview":"To Do List"},
               {"start":42,"end":97,"type":"listItem","ordered":true,"nesting":1,"preview":"Follow up on the table…"},
               {"start":97,"end":150,"type":"table","rows":3,"cols":2,"preview":null},
               {"start":150,"end":151,"type":"horizontalRule","preview":null}],
   "documentEnd":151,"truncated":false}
  ```
  `preview` is the first 60 chars of the element's text, whitespace-collapsed. Types cover paragraph, heading, listItem, table, sectionBreak, horizontalRule, image/inlineObject anchor, tableOfContents — every element kind, so the index view never silently omits document structure the way `getFormatting.js:34` does.
- **`nesting` is included** — this is the field that makes the index view answer #104/#107's questions ("what level is this list item at"), and it is the field `getFormatting` conspicuously lacks.
- **Narrow field mask for this mode.** Not `'*'`: request only `body.content(startIndex,endIndex,paragraph(paragraphStyle(namedStyleType),bullet(listId,nestingLevel),elements(textRun(content))),table(rows,columns),sectionBreak,tableOfContents)` plus `lists(listProperties(nestingLevels(glyphType)))` for ordered/unordered resolution — so the *fetch* is cheap too, not merely the output.
- **A real response budget for Docs reads.** Adopt the Gmail mechanism (`capToResponseBudget`, `helpers.js:534`) for `format:'index'`: a `maxResponseChars` parameter defaulting to `DEFAULT_MAX_RESPONSE_CHARS`, truncating at **element boundaries** with an explicit `truncated: true` + `nextStartIndex` so a large document is paginated rather than corrupted. This is the piece that makes the mode reliable where `format:'json'`'s blind substring is not.
- **Fix `format:'json'` too, without breaking it.** It stays the raw-document escape hatch, but: (a) `maxLength`'s description is corrected to say it applies to text, markdown, and json; (b) when json output exceeds the response budget and no `maxLength` was given, fail with a *directive* error — "N chars; use format='index' for index discovery, or pass maxLength" — instead of dumping 1.36 MB into the transport; (c) add `stripInheritedStyles` (default **true** for json) that prunes `suggested*` keys and style objects that are empty or wholly default, which is where the bulk of the 52K lines live. Default-true is a deliberate output-shape change for a mode that is currently unusable at real document sizes; note it in CHANGELOG.
- **Retarget the seven pointers** to `format='index'`. This is the actual user-visible fix — the workflow the tools recommend must be one that completes.
- **`textToFind` diagnostics** (the issue's closing ask): when `findTextRange` fails, report the longest matching prefix and the first divergent character with a small context window. `findTextRange` already normalizes and retries through four strategies (`googleDocsApiHelpers.js:411-485`); on total failure it should say *where* matching stopped rather than only that it failed. This is what makes long multi-line finds debuggable, and it is cheap — the comparison data is already in hand.

## Implementation

1. `readGoogleDoc.js`: add `'index'` to the format enum; narrow-mask fetch; element walker producing the shape above (shared heading extraction with #107/#88 — one helper, used by the index mode, `afterHeading` resolution, and any heading map); budget-capped serialization with `truncated`/`nextStartIndex`.
2. `maxLength` description fix; json budget-exceeded directive error; `stripInheritedStyles` pruner.
3. Retarget the six tool descriptions + the `googleDocsApiHelpers.js:799` error string.
4. `findTextRange` failure diagnostics (longest common prefix + divergence context).
5. Tabs: index mode honors `tabId` exactly as the other formats do (`readGoogleDoc.js:69-89`).

## Tests

- Index mode on a fixture with headings, nested ordered + unordered lists, a table, an image, and a horizontal rule → every element present with correct `start`/`end`/`type`/`nesting`; output is orders of magnitude smaller than the json mode for the same fixture (assert a ratio, e.g. < 5% — the concrete "1.36 MB → a few KB" claim).
- Round-trip usefulness: indices returned by index mode are accepted by `modifyText`/`deleteRange` against the same fixture (proving the mode actually serves the workflow it is advertised for).
- Budget: oversized fixture truncates at an element boundary, `truncated: true`, `nextStartIndex` resumes without gap or overlap; output is always parseable JSON (contrast with json mode's substring).
- `format:'json'`: `maxLength` honored (pin existing behavior); oversized without `maxLength` → directive error naming `format='index'`; `stripInheritedStyles` removes default style/suggested keys while preserving every `startIndex`/`endIndex` (indices must survive pruning — that is the whole point of the mode).
- Description consistency test: every tool description and error string mentioning index discovery names `format='index'` (a grep-style assertion, so this can't rot back).
- `findTextRange` failure: near-miss multi-line search reports the divergence position; exact match still succeeds through all four fallback strategies.

## Acceptance criteria

- Getting the indices needed for a `modifyText` call on a 10 KB document costs one call and a few KB — not a 1.36 MB failure and a 279-chunk file recovery.
- The index view reports list nesting, so callers can reason about structure before editing (feeding #104/#107).
- No documented workflow points at a read mode that cannot complete.
- Large documents paginate at element boundaries with valid JSON at every step.
- A failed `textToFind` says where matching diverged.

## Sequencing

Independent, but it is the enabler for #104/#107 (structure-aware editing) and it **supersedes `listHeadings` from #88** — that plan's heading tool becomes a thin filter over this walker, or is dropped in favor of `format:'index'`; #88 has been updated to say so. Land the shared element/heading walker here first.
