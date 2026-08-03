# Plan: explicit font color on inserted text (#14)

Issue: [#14](https://github.com/karthikcsq/google-tools-mcp/issues/14) · Verified against `main` @ 8640240.

## Current state — the issue is already partially fixed, conditionally

A fix labeled for this issue exists in the markdown insertion path:

- `dist/markdown-transformer/markdownToDocs.js:1017-1040` (`finalizeFormatting`, comment says "fixes issue #14"): emits one blanket `updateTextStyle` over the whole inserted range setting `foregroundColor`, pushed first so per-range formatting overrides it.
- The color comes from `insertMarkdown` (`dist/markdown-transformer/index.js:99-119`): it fetches the document's named styles and reads `NORMAL_TEXT.textStyle.foregroundColor.color.rgbColor`.

Two conditions make it silently not fire:

1. If `NORMAL_TEXT` has no explicit `foregroundColor`, or the `documents.get` fails (swallowed at `index.js:112-114`), `defaultForegroundColor` stays null and **no color request is emitted** (`markdownToDocs.js:1021`).
2. It only covers `insertMarkdown` callers (`replaceDocumentWithMarkdown`, `appendMarkdownToGoogleDoc`, `createDocument` with markdown). Plain-text insertion paths never set color: `createDocument` `contentFormat:'raw'` (`createDocument.js:47-61`, bare `insertText`), `modifyText` insert/replace (`modifyText.js:57-62` — `buildModifyTextRequests` adds `updateTextStyle` only for caller-specified styles), `appendToGoogleDoc`, `findAndReplace`, `insertTableWithData` cell text.

## Root cause framing — and why "set black everywhere" is the wrong fix

The Docs API distinguishes "inherits from named style" from "explicitly #000000". The original report's suggested fix (always set explicit black) has a real downside the issue doesn't weigh: explicitly-colored text **stops following the document theme** — change NORMAL_TEXT's color later and blanket-painted text keeps its frozen color. It also collides with #96, whose complaint is precisely that explicit color spans pollute markdown reads (`docsToMarkdown` emits a `<span>` for any explicit color that differs from default).

The *actual* root cause of the reported symptoms (color picker shows nothing selected; `getForegroundColor()` returns null in Apps Script) is inserted text carrying **no** explicit style while manually-typed text in the same doc typically carries one — a *consistency* problem within a document, not an absolute "must be black" problem. The current fix's design — copy the document's own NORMAL_TEXT color rather than hardcode #000000 — is correct. What's wrong is its silence and incompleteness.

## Implementation

1. **Decide the contract and write it down**: "text inserted by this server carries the document's NORMAL_TEXT foreground color explicitly, when the document defines one." Add this to `docs/architecture.md`'s Docs section and to the descriptions of `replaceDocumentWithMarkdown`/`appendMarkdown` (one sentence).
2. **Un-swallow the failure**: `dist/markdown-transformer/index.js:112-114` currently hides both fetch failure and missing-color as the same silent null. Log at `warn` when the fetch *fails* (that's an operational problem), and treat "NORMAL_TEXT defines no color" as the legitimate no-op it is (documents where inheritance is the norm should stay inherit-only — matching, not painting, is the goal).
3. **Extend to the raw-insert paths** — same mechanism, shared helper: extract the fetch-NORMAL_TEXT-color logic from `insertMarkdown` into an exported helper (`getDefaultTextColor(docs, documentId)`), then:
   - `createDocument.js` raw branch (`:47-61`): after `insertText`, if a color resolves, one `updateTextStyle` over the inserted range.
   - `modifyText.js` / `appendToGoogleDoc.js` / `findAndReplace.js`: **do not** auto-paint — these edit inside existing runs, where the neighboring text's style (picked up automatically by the API for insertions within a run) is more correct than NORMAL_TEXT. Painting here would *create* inconsistency. Document this boundary in the plan-of-record comment on the helper.
   - `insertTableWithData.js` cell fills: include (fresh runs in fresh cells, same situation as createDocument raw).
4. **Verification pass** (the issue predates the partial fix): one manual check on a default-template Google Doc — insert via `replaceDocumentWithMarkdown` and via `createDocument` raw, select text, confirm the picker shows black selected, and `getForegroundColor()` returns `#000000` in Apps Script. Record the result in the issue before closing.

## Tests

- `tests/markdownTransformer.test.js`: with `defaultForegroundColor` provided, request list starts with the blanket `updateTextStyle` (`fields: 'foregroundColor'`) covering `[startIndex, currentIndex)`; without it, no such request. (Pin both sides of the conditional.)
- New: `createDocument` raw-content path emits the follow-up `updateTextStyle` when the mocked doc's NORMAL_TEXT defines a color, and doesn't when absent — lands naturally with #56's createDocument coverage.
- Fetch-failure path logs a warning and still inserts (no throw).

## Acceptance criteria

- On a stock Google Doc, text from every *fresh-content* insertion path shows an explicitly-selected color in the UI picker and a non-null `getForegroundColor()`.
- In-run edits (modifyText et al.) still inherit neighboring style — no blanket painting.
- Failure to read named styles is visible in logs, not silent.
- Behavior contract documented; issue closed with the manual verification evidence.

## Sequencing

Independent; pairs naturally with #56 (createDocument tests) and should merge before/with #96 only to keep `readGoogleDoc.js`-adjacent conflicts small (no logical dependency).
