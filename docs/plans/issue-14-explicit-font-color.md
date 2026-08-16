# Plan: explicit font color on inserted text (#14)

Issue: [#14](https://github.com/karthikcsq/google-tools-mcp/issues/14) · Verified against `main` @ 8640240. Revised after adversarial review.

## Current state — the issue is already partially fixed, conditionally

A fix labeled for this issue exists in the markdown insertion path:

- `dist/markdown-transformer/markdownToDocs.js:1017-1040` (`finalizeFormatting`, comment says "fixes issue #14"): emits one blanket `updateTextStyle` over the whole inserted range setting `foregroundColor`, pushed first so per-range formatting overrides it.
- The color comes from `insertMarkdown` (`dist/markdown-transformer/index.js:99-119`): it fetches the document's named styles and reads `NORMAL_TEXT.textStyle.foregroundColor.color.rgbColor`.

Two conditions make it silently not fire:

1. If `NORMAL_TEXT` has no **rgb** color (including theme-color-based styles, which surface differently than `rgbColor`), or the `documents.get` fails (swallowed at `index.js:112-114`), `defaultForegroundColor` stays null and no color request is emitted (`markdownToDocs.js:1021`).
2. It only covers `insertMarkdown` callers (`replaceDocumentWithMarkdown`, `appendMarkdownToGoogleDoc`, `createDocument` with markdown). Raw insertion paths never set color: `createDocument` `contentFormat:'raw'` (`dist/tools/drive/createDocument.js:47-60`, bare `insertText`), `modifyText` insert/replace, `appendToGoogleDoc`, `findAndReplace`, `createFromTemplate` `replaceAllText`, and `insertTableWithData` cell text (`insertTableWithData.js:41-68`).

## Root cause framing — and why "set black everywhere" is the wrong fix

The Docs API distinguishes "inherits from named style" from "explicitly #000000". The original report's suggested fix (always set explicit black) has a real downside: explicitly-colored text stops following the document theme. The *actual* root cause of the reported symptoms (picker shows nothing selected; `getForegroundColor()` null) is inserted text carrying **no** explicit style while manually-typed text typically carries one — a *consistency* problem within a document. The current fix's design — copy the document's own NORMAL_TEXT color rather than hardcode black — is correct. What's wrong is its silence, incompleteness, and an unresolved round-trip interaction with #96.

**Round-trip policy (resolves the #96 interaction explicitly):** painting inserted text with the document default color means `docsToMarkdown` would emit `<span style="color:…">` for those runs (`docsToMarkdown.js:285-309`) — the exact noise #96 exists to remove. Decision: `docsToMarkdown` in rich mode **suppresses the color span when a run's explicit color equals the document's NORMAL_TEXT default** (it carries no information — it *is* the default, stated explicitly). That keeps reads clean, keeps this fix, and is a small converter change (compare run color against the same `defaultForegroundColor` lookup). `plainMarkdown` mode is unaffected (suppresses all spans anyway).

## Implementation

1. **Contract, written down:** "text inserted by this server carries the document's NORMAL_TEXT foreground color explicitly, when that style defines an RGB color; theme-color or undefined defaults insert inherit-only text." Add to `docs/architecture.md` and (one sentence) to `replaceDocumentWithMarkdown`/`appendMarkdown` descriptions. Theme-color-based NORMAL_TEXT styles are deliberately treated as "no explicit default" — matching a theme slot cannot be done with a fixed rgb paint without freezing it.
2. **Shared helper with an explicit failure contract:** extract the lookup into `getDefaultTextColor(docs, documentId)` returning `{ color: rgb | null, error: Error | null }` — it does **not** log itself. Callers log: fetch *failure* → `logger.warn` (operational problem, currently swallowed at `index.js:112-114`); "style defines no rgb color" → silent legitimate no-op.
3. **Empirical audit before changing inherited-style paths:** execute and mock-inspect `appendToGoogleDoc`, `findAndReplace`, and `createFromTemplate` `replaceAllText` on Docs with known neighboring/default effective colors. If a path already preserves an explicit effective color, record it and add a no-extra-`updateTextStyle` regression test. If it can leave text unset, resolve the exact affected ranges and apply the shared default after the operation without overriding intentional caller or source styling.
4. **Extend to fresh-run raw paths:**
   - `dist/tools/drive/createDocument.js` raw branch (`:47-60`): after `insertText`, if a color resolves, one `updateTextStyle` over the inserted range. A failed color update joins the response `warnings` (do not silently succeed — coordinated with #56's fix of the `:77-79` swallow).
   - `insertTableWithData.js` cell fills: same treatment for populated cells.
   - `modifyText`: **included explicitly.** Its insert and replace branches create a new text range, and the reported path must receive the same document-default `updateTextStyle` treatment as every other fresh-content insertion. Apply it only to the newly inserted range, after text insertion and before any caller-requested formatting so caller intent still wins.
   - `appendToGoogleDoc`, `findAndReplace`, and `createFromTemplate` `replaceAllText`: follow the audit result. Preserve and test the zero-request path where Docs already retains explicit color; otherwise style only the precisely resolved newly-created/replaced ranges with the shared helper.
5. **Converter change** for the round-trip policy above (`docsToMarkdown.js`, rich mode span emission).
6. **Manual verification pass** (the issue predates the partial fix): on a default-template Doc, exercise every Docs path that creates or replaces text, including append, find/replace, and template replacement. Record picker state and Apps Script `getForegroundColor()` results for each path in the issue before closing.

## Tests

- `tests/markdownTransformer.test.js`: with `defaultForegroundColor`, request list starts with the blanket `updateTextStyle` (`fields: 'foregroundColor'`) over `[startIndex, currentIndex)`; without it, absent. Round-trip: a run whose explicit color equals the default emits no span in rich mode; a *different* explicit color still emits its span.
- Tool-execution paths (not just the pure converter): mocked `replaceDocumentWithMarkdown`, `appendMarkdownToGoogleDoc`, and `modifyText` runs assert the named-styles fetch happens and the resolved color reaches the emitted requests. `modifyText` covers both insert and replace, and asserts caller-supplied formatting remains the final override.
- `createDocument` raw path (with #56's new test file): color update present when the mocked doc defines an rgb default, absent otherwise; assert the insert request **semantically** (an `insertText` at index 1 plus optionally a style request — not "exactly one request", which would conflict with this plan); failed color update surfaces in `warnings`.
- `insertTableWithData`: populated cells receive the color request; empty cells and `tabId` variants covered.
- Empirical-audit tests for `appendToGoogleDoc`, `findAndReplace`, and `createFromTemplate` `replaceAllText`: prove the observed effective-color behavior. For a preserving path, assert no extra style request; for an unset-capable path, assert exact affected-range resolution plus shared-default styling, with intentional caller/source styling still winning.
- Helper failure contract: fetch throws → `{color: null, error}` and caller logs warning, insertion proceeds.

## Acceptance criteria

- On documents whose NORMAL_TEXT defines an rgb color (stock template does), text from **every Docs path that creates or replaces text** shows an explicitly-selected color in the picker and non-null `getForegroundColor()`, including `modifyText`, append, find/replace, and template replacement. A path empirically proven to preserve that effective color emits no redundant style request.
- Theme-based or colorless defaults → inherit-only insertion, documented, no error.
- Intentional caller/source formatting is never overridden; a path that preserves its effective color retains it without redundant styling.
- Reading back a document written by this server produces no redundant default-color spans (round-trip clean with #96).
- Named-styles fetch failure is visible in logs; raw-path color-update failure is visible in the tool response.

## Sequencing

Coordinate with #96 (converter span policy) and #56 (`createDocument` tests + warning surfacing). No hard blockers.
