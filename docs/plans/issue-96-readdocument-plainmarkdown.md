# Plan: add plainMarkdown to readDocument (#96)

Issue: [#96](https://github.com/karthikcsq/google-tools-mcp/issues/96) · Verified against `main` @ 8640240. Revised after adversarial review.

## Root cause

`readDocument` and `readDriveFile` share the same converter, but only `readDriveFile` forwards the flag that suppresses rich HTML extensions:

- Converter already supports it: `dist/markdown-transformer/docsToMarkdown.js:146-154` — `richMarkdown: options.plainMarkdown ? false : options.richMarkdown ?? true`.
- `readDriveFile` forwards it: `dist/tools/extras/readDriveFile.js:126`.
- `readDocument` passes nothing: `dist/tools/docs/readGoogleDoc.js:104` — `const markdownContent = docsJsonToMarkdown(contentSource);` → `richMarkdown` defaults `true` → `<span style="color:…">` wrappers on every explicitly-colored run, with no way to turn them off in the tool that the documented editing workflow tells callers to use.

There is nothing deeper under this: the option exists, one call site doesn't forward it. The *systemic* half of the root cause — two tools doing the same conversion with divergent capabilities and nothing keeping them aligned — is addressed by the parity test below.

## Design decisions

1. **Working copy stays rich.** `readDocument` computes a working-copy path (`dist/workspace.js:61-65`) and writes the file (`workspace.js:98-121`) that `replaceDocumentWithMarkdown` pushes back. If `plainMarkdown: true` also stripped the working copy, a later push would silently discard the document's existing colors. So: the **inline response** honors `plainMarkdown`; the **working-copy file always gets the rich version**. State this in the parameter description, and state the corollary bluntly: *the plain inline text is for reading and reasoning; pasting it into `replaceDocumentWithMarkdown(markdown=...)` will drop the document's colors — only the local working-copy file is safe for lossless round-trip editing.*
2. **Default stays `false`.** Flipping the default is a breaking output change; not now. Note it as a candidate for the next major in CHANGELOG.
3. **`diffFromLastRead` ignores `plainMarkdown`, explicitly.** The diff path (`readGoogleDoc.js:119-144`) patches between the *stored rich snapshot* and the current rich conversion; a plain-vs-rich diff would be garbage, and storing plain snapshots would corrupt cross-read diffs when flag usage varies. So the combination behaves like the existing `format: 'json'`/`'text'` interactions (`:91-93`, `:183-185`): the diff is produced from rich markdown, and a note line in the response says `plainMarkdown` was ignored for the diff. Tracker state (`trackRead`) stays rich unconditionally — it feeds conflict diffs in `guardMutation`, which compare against rich fetches.
4. **`maxLength`/`totalLength` operate on what is returned.** Truncation and the reported `totalLength` (`readGoogleDoc.js:104-105`, `:160-166`) must be computed from the response variant (plain when the flag is set), not from the rich string — otherwise plain responses get truncated against the wrong length and report a size the caller never received.

## Implementation

1. `dist/tools/docs/readGoogleDoc.js` schema (~line 32-51): add
   ```js
   plainMarkdown: z.boolean().optional().default(false)
       .describe('For markdown format only. If true, the returned text suppresses rich HTML-style formatting extensions (color/background spans) for cleaner portable markdown. The local working-copy file and diff/conflict tracking always keep the rich version — for lossless editing, edit the working-copy file, not this plain text. Ignored (with a note) when diffFromLastRead is true.'),
   ```
   Reuse the `readDriveFile.js:57-61` wording for the first sentence so the two tools document it identically.
2. At `readGoogleDoc.js:104`: keep `markdownContent` (rich) as canonical; add `const responseMarkdown = args.plainMarkdown ? docsJsonToMarkdown(contentSource, { plainMarkdown: true }) : markdownContent;`. Full-read response path (~:149-179) returns `responseMarkdown`; `totalLength`/`maxLength` truncation computed on `responseMarkdown`.
3. Diff path (~:119-144): unchanged output, plus the "plainMarkdown ignored for diff" note when the flag was set.
4. `trackRead` calls (:94/:130/:149/:214) and `writeWorkspaceFile` calls (:134/:154) keep receiving rich `markdownContent` — no change.
5. Local-file advice string (~:171-179): mention that the file on disk is the rich version when the flag is set.

## Tests

- Extend `tests/readGoogleDocWorkspace.test.js` (already mocks `dist/clients.js`) with a doc fixture containing an explicit `foregroundColor` run:
  - default read: response and working copy both contain `<span style=`.
  - `plainMarkdown: true`: response contains no `<span style=`; working copy **still** contains `<span style=`; `getLastReadContent` returns rich.
  - `plainMarkdown: true` + `maxLength` shorter than rich but longer than plain: response is **not** truncated and `totalLength` equals the plain length.
  - `plainMarkdown: true` + `diffFromLastRead` on a second read: patch content derives from rich snapshots; response contains the ignored-flag note.
- Parity test (`tests/readToolParity.test.js`): one shared Docs-JSON fixture through both tools' conversion paths at the same flag value; **extract the markdown content field from each response** (`readDocument` returns markdown + advice text; `readDriveFile` returns a JSON envelope with `content`, `readDriveFile.js:151-156`) and compare the extracted content byte-for-byte. Comparing raw responses would compare incompatible envelopes.

## Acceptance criteria

- `plainMarkdown` absent → byte-identical behavior to today.
- `plainMarkdown: true` on a colored doc → no `<span style=` in the returned content, matching `readDriveFile`'s content byte-for-byte on the same document/format; length accounting reflects the returned text.
- Working copy and tracker snapshots remain rich under both flag values; the diff-path and round-trip implications are stated in the tool description.

## Follow-up (tracked, not in this change)

The issue's "Related" section notes the capability split (`readDriveFile` lacks `diffFromLastRead`/`tabId`/working copy). After this lands the remaining asymmetry is `readDriveFile`'s — fold that into #88's docs-editing work or a new small issue rather than widening this one.
