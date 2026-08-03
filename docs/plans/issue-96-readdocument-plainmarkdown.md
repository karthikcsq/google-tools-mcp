# Plan: add plainMarkdown to readDocument (#96)

Issue: [#96](https://github.com/karthikcsq/google-tools-mcp/issues/96) · Verified against `main` @ 8640240.

## Root cause

`readDocument` and `readDriveFile` share the same converter, but only `readDriveFile` forwards the flag that suppresses rich HTML extensions:

- Converter already supports it: `dist/markdown-transformer/docsToMarkdown.js:146-154` — `richMarkdown: options.plainMarkdown ? false : options.richMarkdown ?? true`.
- `readDriveFile` forwards it: `dist/tools/extras/readDriveFile.js:126`.
- `readDocument` passes nothing: `dist/tools/docs/readGoogleDoc.js:104` — `const markdownContent = docsJsonToMarkdown(contentSource);` → `richMarkdown` defaults `true` → `<span style="color:…">` wrappers on every explicitly-colored run, with no way to turn them off in the tool that the documented editing workflow tells callers to use.

There is nothing deeper under this: the option exists, one call site doesn't forward it. The *systemic* half of the root cause — two tools doing the same conversion with divergent capabilities and nothing keeping them aligned — is addressed by the parity test below.

## Design decisions

1. **Working copy stays rich.** `readDocument` writes a working-copy file (`dist/workspace.js:61-65`) that `replaceDocumentWithMarkdown` pushes back. If `plainMarkdown: true` also stripped the working copy, a later push would silently discard the document's existing colors. So: the **inline response** honors `plainMarkdown`; the **working-copy file always gets the rich version**. The round trip stays lossless by default, and the flag remains a read/reasoning affordance. State this explicitly in the parameter description, because it is the one surprising part of the behavior.
2. **Default stays `false`.** Flipping the default is a breaking output change; not now. Note it as a candidate for the next major in CHANGELOG.
3. **`diffFromLastRead` interaction.** The diff path (`readGoogleDoc.js:119-147`) compares against the *stored* snapshot from `getLastReadContent`. Snapshots must be internally consistent: keep `trackRead` and the diff comparison on the rich version unconditionally (same reasoning as the working copy — tracker content feeds conflict diffs against rich fetches in `guardMutation`), and apply the plain conversion only to the returned text. That means with `plainMarkdown: true` a second conversion call with `{plainMarkdown: true}` produces the response body while the rich result feeds `trackRead`/workspace. Conversion is cheap relative to the API fetch.

## Implementation

1. `dist/tools/docs/readGoogleDoc.js` schema (~line 32-51): add
   ```js
   plainMarkdown: z.boolean().optional().default(false)
       .describe('For markdown format only. If true, suppresses rich HTML-style formatting extensions (color/background spans) and returns cleaner portable markdown. The local working-copy file and diff tracking always keep the rich version so a later replaceDocumentWithMarkdown push does not silently drop colors.'),
   ```
   Reuse the `readDriveFile.js:57-61` wording for the first sentence so the two tools document it identically.
2. At `readGoogleDoc.js:104`: keep `const markdownContent = docsJsonToMarkdown(contentSource);` as the canonical rich version; add `const responseMarkdown = args.plainMarkdown ? docsJsonToMarkdown(contentSource, { plainMarkdown: true }) : markdownContent;` and return `responseMarkdown` in the response paths (full read ~:149-179 and diff path ~:119-147, where the *patch target* stays rich but the appended current-content fallthrough at :146 uses `responseMarkdown`).
3. `trackRead` calls (:94/:130/:149/:214) and `writeWorkspaceFile` calls (:134/:154) keep receiving the rich `markdownContent` — no change.
4. Mention the flag in the local-file advice string (~:171-179) so callers understand the file on disk may differ from the inline text when the flag is set.

## Tests

- Extend `tests/readGoogleDocWorkspace.test.js` (already mocks `dist/clients.js`): a doc fixture with an explicit `foregroundColor` text run —
  - default read: response contains `<span style=`; working copy content contains `<span style=`.
  - `plainMarkdown: true`: response contains no `<span style=`; working copy **still** contains `<span style=`; `getLastReadContent` returns the rich version.
- Parity test (the drift guard the issue asks for): one shared Docs-JSON fixture converted via the `readDocument` path and the `readDriveFile` path at the same flag value must produce byte-identical markdown. Put it in a new `tests/readToolParity.test.js` so future divergence between the two tools fails CI.

## Acceptance criteria

- `plainMarkdown` absent → byte-identical behavior to today.
- `plainMarkdown: true` on a colored doc → no `<span style=` in output, matching `readDriveFile` byte-for-byte on the same document/format.
- Working copy and diff snapshots remain rich under both flag values; the interaction is stated in the tool description.

## Follow-up (tracked, not in this change)

The issue's "Related" section notes the capability split (`readDriveFile` lacks `diffFromLastRead`/`tabId`/working copy; `readDocument` lacked `plainMarkdown`). After this lands the remaining asymmetry is `readDriveFile`'s — fold that into #88's docs-editing work or a new small issue rather than widening this one.
