## Issue #117: readDocument: surface mailto/link targets that disagree with their display text

## Description

## The problem

Google Docs silently re-autolinks substrings when a human edits a line containing an email address. The visible text stays correct while the underlying link target becomes wrong. `readDocument`'s markdown output renders these as ordinary links, so an agent reading the doc sees nothing unusual and reports the address as correct.

I have now hit this twice on the same partner-facing document.

**Case 1 — Tyler Mantel.** Display text read `tyler@rolltackventures.com`, correct. The mailto pointed at `rolltrackventures.com` (extra `r`, a domain that does not resolve). The doc had been read and verified several times without anyone catching it, because every readable surface said the right thing.

**Case 2 — Fred Nash.** A teammate edited the line `Fortitude Fund Fred.nash@yahoo.com`. Docs re-linked from after the period, producing:

```
Fortitude Fund Fred [nash@yahoo.com](mailto:nash@yahoo.com)
```

The `Fred.` prefix fell outside the link. Anyone clicking mailed a nonexistent address. In markdown this is technically visible if you look hard, but it reads as a normal link and the eye slides past it — and in `format='text'` it is completely invisible.

Both were caught by accident, not by inspection.

## Why it matters here

This is a document partners rely on as a source of truth, and the failure mode is silent and outbound: the damage is a message that never arrives, discovered weeks later or never. The class of bug is "the doc looks right and is wrong," which is the hardest kind for an agent to self-catch, because every tool it has agrees with the wrong answer.

## Suggested fix

In `readDocument` markdown output, flag links whose target disagrees with their display text. Something in the spirit of the existing FORMATTING LOSS block:

```
⚠️ LINK MISMATCH: 2 link(s) whose target does not match their visible text:
  • "nash@yahoo.com" → mailto:nash@yahoo.com  (line 67, preceded by "Fred." — possible autolink boundary break)
  • "tyler@rolltackventures.com" → mailto:tyler@rolltrackventures.com
```

The narrow, high-value version: for any link whose display text parses as an email address, compare it to the `mailto:` target and warn when they differ. That alone would have caught both cases with essentially no false positives.

A worthwhile secondary heuristic: warn when a linked email is immediately preceded by non-whitespace text, since that is the signature of an autolink boundary break.

## Related friction

`findAndReplace` cannot change a link target, only visible text — so on a doc where the display text is already correct, it silently succeeds and fixes nothing. `modifyText` with `style.linkUrl` is the only repair path. Worth a line in the `findAndReplace` docstring, since the natural first attempt at fixing a bad address is `findAndReplace` and it appears to work.

Not asking for anything on the write side. Detection is the whole ask — once you know, the repair is easy.

<details>
<summary>Diagnostic Info</summary>

- **Server version:** 2.0.0
- **Node version:** v22.22.3
- **OS:** win32 10.0.26200 (x64)
- **Auth status:** valid
- **Scopes:** documents, drive, spreadsheets, script.external_request, gmail.modify, gmail.compose, gmail.send, gmail.settings.basic, gmail.settings.sharing, calendar, forms.body, forms.body.readonly, forms.responses.readonly, presentations, tasks, service.management

</details>


## Issue #118: replaceDocumentWithMarkdown emits literal ** / ~~ into the doc when a delimiter has a trailing space (`**text **`)

## Description

## Summary

`replaceDocumentWithMarkdown` silently writes **literal asterisks and tildes as visible document text** when an emphasis span has whitespace immediately before the closing delimiter — e.g. `**Owner: Andres. **The kickoff...` or `~~some text ~~`. Per CommonMark, a closing `**` cannot be preceded by whitespace, so the span is not emphasis and the delimiters stay as raw characters. The tool applies that literally and the reader sees `**Owner: Andres. **The kickoff...` in their Google Doc.

The nasty part is that this is **self-inflicted by the tool's own round-trip**, and it is invisible to the obvious verification step.

## Reproduction

1. `readDocument(format='markdown')` on a doc containing a bold run whose range includes a trailing space (very common — users bold a label *and* the space after it: `**Owner: Andres. **`). The exporter emits exactly `**Owner: Andres. **The kickoff...`.
2. Edit the working copy elsewhere; leave that span untouched.
3. `replaceDocumentWithMarkdown(filePath=...)`.
4. The doc now shows literal `**` characters around that text, and the bold formatting is gone.

So a pure round-trip — export, unrelated edit, re-import — corrupts the document. No user-authored bad markdown is required.

## Why it is easy to miss

`readDocument(format='markdown')` on the corrupted doc returns `**Owner: Andres. **The kickoff...` — **identical** to what a correctly-bolded run exports as. Markdown export cannot distinguish "bold run including a trailing space" from "four literal asterisks". Verifying a push by re-reading as markdown therefore shows a clean-looking result while the live document is visibly broken.

`format='text'` is what exposes it — literal `**` / `~~` survive into plain text, real formatting does not. That diagnostic is not discoverable from any tool description.

In my case the doc round-tripped five bold spans and one strikethrough into literal markers. I verified the push by re-reading markdown, saw the same string I had written, and concluded it was fine. The document owner found the raw asterisks by eye.

## Requested fix (in preference order)

1. **Normalize on export.** When `readDocument(format='markdown')` serializes a styled run whose range includes leading/trailing whitespace, move the whitespace outside the delimiters: emit `**Owner: Andres.** ` instead of `**Owner: Andres. **`. This kills the round-trip corruption at the source and is a pure improvement — the two render identically.
2. **Normalize on import.** In `replaceDocumentWithMarkdown`, detect `**…␠**` / `~~…␠~~` and either trim inside the delimiters or apply the emphasis anyway, rather than passing the delimiters through as text.
3. **At minimum, warn.** If the markdown being pushed contains an emphasis-like sequence that will not parse, report it in the result the way the existing `FORMATTING LOSS WARNING` reports dropped richLinks. A silent corruption that also survives markdown-level verification is the worst combination.

## Related docs suggestion

Worth calling out in the `replaceDocumentWithMarkdown` description that markdown re-reads cannot verify a push, and that `format='text'` is the way to confirm no literal markup landed.

## Workaround used

Fixed in place with `modifyText`, targeting each literal string and applying the real style in the same call, e.g.:

```
modifyText(target={textToFind: "**Owner: Andres. **"},
           text: "Owner: Andres. ",
           style: {bold: true})
```

This was also the right tool here for a second reason: the document owner had edited the doc live in between, so a full-body `replaceDocumentWithMarkdown` would have reverted their changes. Targeted `modifyText` calls fixed the six corrupted spans without touching anything else.

## Environment note

Encountered on a ~13KB doc pushed via `filePath`. Same doc also carried the existing richLink loss warning, which worked correctly — the richLink was reported up front and I preserved it manually as a normal link. The emphasis corruption had no such warning.

<details>
<summary>Diagnostic Info</summary>

- **Server version:** 2.0.0
- **Node version:** v22.22.3
- **OS:** win32 10.0.26200 (x64)
- **Auth status:** valid
- **Scopes:** documents, drive, spreadsheets, script.external_request, gmail.modify, gmail.compose, gmail.send, gmail.settings.basic, gmail.settings.sharing, calendar, forms.body, forms.body.readonly, forms.responses.readonly, presentations, tasks, service.management

</details>


## Issue #119: modifyText raises a phantom staleness error when the document has not actually changed (empty diff), and an immediate identical retry succeeds

## Description

## What happens

`modifyText` intermittently rejects a call with either of these, on a document already read in the session:

```
This document (<id>) changed since you last read it. Read the document again before editing to ensure you have current content.
```

```
This file was modified externally since you last read it (last read: 2026-08-28T02:38:38.713Z, last modified: 2026-08-28T02:38:33.897Z).
Do NOT re-apply your original edit blindly. Build your new edit on top of the current version.
--- DIFF (last read → current) ---
Index: <id>
===================================================================
--- <id>	last read
+++ <id>	current
--- END DIFF ---
```

**The diff is empty.** Nothing changed. And in the second form, the reported `last modified` timestamp (02:38:33) is EARLIER than the reported `last read` (02:38:38), which on its own should not trip a staleness check.

**Immediately re-issuing the byte-identical `modifyText` call succeeds every time.**

## Why it matters

The guard is doing real work here — I am editing docs a human is editing live in another window — so I take it seriously and follow the prescribed recovery: `readDocument` with `diffFromLastRead=true`, inspect, rebase, retry. When the diff comes back empty, that whole round trip was wasted, and on a large doc the re-read is expensive. Worse, it trains toward ignoring the warning, which is exactly the wrong reflex for a guard that is correct most of the time.

## Frequency

4 occurrences in roughly 25 `modifyText` calls in one session, across 3 different documents (a doc I created that session, and two long-lived shared docs). It also fired on a document that no other user had open.

## Reproduction shape

1. `readDocument(documentId, format='text' | 'markdown')`
2. A short series of successful `modifyText` calls against that doc
3. Somewhere in the series, one call is rejected as stale with an empty diff
4. Re-issue the exact same call with no intervening operation → succeeds

I could not make it fire deterministically, which points at a revision-id or mtime race rather than genuine concurrent modification. A plausible cause: the doc's revision id or `modifiedTime` is bumped by the service after a write of my own (or by an autosave tick) and the freshness check compares against a value captured before that bump, so my own preceding edit invalidates my next one.

## Suggested fix

If the computed diff between "last read" and "current" is empty, do not raise. Refresh the stored revision marker and let the edit proceed. Also treat `last modified < last read` as not-stale rather than stale.

## Secondary, same session

`resolveComment` returns "Attempted to resolve comment <id>, but the resolved status may not persist in the Google Docs UI due to API limitations." It reads as a success, but I cannot tell the user whether the thread is actually resolved, so I have to hedge in every report. If the API genuinely cannot resolve, returning a clear failure would be more useful than an ambiguous success.

<details>
<summary>Diagnostic Info</summary>

- **Server version:** 2.0.0
- **Node version:** v22.22.3
- **OS:** win32 10.0.26200 (x64)
- **Auth status:** valid
- **Scopes:** documents, drive, spreadsheets, script.external_request, gmail.modify, gmail.compose, gmail.send, gmail.settings.basic, gmail.settings.sharing, calendar, forms.body, forms.body.readonly, forms.responses.readonly, presentations, tasks, service.management

</details>


## Issue #120: modifyText cannot create bullets or numbered lists, so mid-document inserts can't match the formatting of the rest of the doc

## Description

## The gap

`modifyText` is the only safe way to edit a Google Doc that a human is editing live. `paragraphStyle` on it exposes `alignment`, `indentStart`, `indentEnd`, `namedStyleType`, `spaceAbove`, `spaceBelow`, and `keepWithNext` — but nothing for **bullets or numbered lists**.

`appendMarkdown` can produce lists, but only at the very end of the document. `replaceDocumentWithMarkdown` can produce them anywhere, but it rewrites the entire body, which silently destroys any concurrent edits and any images or horizontal rules the doc contains.

So for an insert into the MIDDLE of a live document, there is no way to produce a list. The result is a section whose content is right but whose formatting visibly does not match the parallel section above it, and the user notices immediately.

## Concrete case from tonight

A doc with two parallel sections, "Version A" and "Version B", meant to look identical. Version A was created through `createDocument(initialContent=<markdown>)`, so it has real bullets and a real numbered list. Version B had to be inserted mid-document via `modifyText`, so its numbered items are literal `1.` / `2.` text and its bullet items are bare paragraphs. Same content, obviously different formatting, and I had to explain to the user why.

## Ask

Add list control to `modifyText`'s `paragraphStyle`, e.g.:

```json
"paragraphStyle": { "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE" }
"paragraphStyle": { "bulletPreset": "NUMBERED_DECIMAL_ALPHA_ROMAN" }
"paragraphStyle": { "bulletPreset": null }   // delete bullets from these paragraphs
```

mapping onto the Docs API's existing `createParagraphBullets` / `deleteParagraphBullets` requests, applied over the target range.

## Alternative that would also solve it

A `contentFormat: "markdown"` option on `modifyText`'s replacement `text`, so an inserted block can carry its own list, bold, and link structure the way `appendMarkdown` does — just scoped to a range instead of the document tail. That would arguably be the more useful of the two, since it also removes the need for follow-up styling calls.

<details>
<summary>Diagnostic Info</summary>

- **Server version:** 2.0.0
- **Node version:** v22.22.3
- **OS:** win32 10.0.26200 (x64)
- **Auth status:** valid
- **Scopes:** documents, drive, spreadsheets, script.external_request, gmail.modify, gmail.compose, gmail.send, gmail.settings.basic, gmail.settings.sharing, calendar, forms.body, forms.body.readonly, forms.responses.readonly, presentations, tasks, service.management

</details>


## Issue #121: modifyText replacement text silently inherits the character style of the text it replaced, italicizing whole inserted sections

## Description

## What happens

When `modifyText` replaces a run, the new text inherits that run's character formatting. Replace a one-line *italic* placeholder with a 2,500-character section and **the entire section comes back italic**, with no warning in the tool result.

The result reads as success:

```
Successfully replaced text at range 2934-3110.
```

Nothing indicates that 2,500 characters just landed in italic. I only found out because the user looked at the doc and told me I had messed up the formatting.

## Tonight's sequence

1. Doc had a placeholder paragraph in italic: `*Not drafted yet. Same information, same details...*`
2. `modifyText` replaced it with a full email draft, many paragraphs
3. Every paragraph rendered italic
4. Fixing it took a `readDocument`, an `italic:false` over a computed range, a re-read to find the range had ended mid-word, and a second `italic:false` on the tail

That is four extra calls and a user-visible mistake, from an operation that reported success.

## Ask, in priority order

1. **A `clearStyle: true` (or `inheritStyle: false`) flag on `modifyText`** so replacement text lands as plain body text regardless of what it replaced. This is what I want the large majority of the time when the replacement is longer than the thing it replaced.
2. **Report inherited formatting in the result** when it is non-default, e.g. `Successfully replaced text at range 2934-3110 (inherited style: italic)`. Cheap, and it would have caught this immediately.
3. Consider making non-inheritance the default when the replacement is substantially longer than the replaced run, since that case is nearly always "insert new content here", not "edit this phrase in place".

## Related

Filed alongside #120 (modifyText cannot create lists). Both come from the same underlying constraint: `modifyText` is the only safe editor for a live multi-user doc, but it has no way to express the formatting of the content it inserts.

<details>
<summary>Diagnostic Info</summary>

- **Server version:** 2.0.0
- **Node version:** v22.22.3
- **OS:** win32 10.0.26200 (x64)
- **Auth status:** valid
- **Scopes:** documents, drive, spreadsheets, script.external_request, gmail.modify, gmail.compose, gmail.send, gmail.settings.basic, gmail.settings.sharing, calendar, forms.body, forms.body.readonly, forms.responses.readonly, presentations, tasks, service.management

</details>


## Issue #122: readDocument overwrites the local mirror file, silently destroying pending edits

## Description

**What happened:** `readDocument` writes the document to a local mirror at `%TEMP%\google-tools-mcp-<user>\<docId>.md` and tells you to edit that file and push it back with `replaceDocumentWithMarkdown`. But a later `readDocument` on the same doc overwrites that file with no warning and no backup. I had a fully written new section in the mirror, then called `readDocument(diffFromLastRead=true)` to do the staleness check the workflow requires before pushing, and the read silently wiped my unpushed work. The tool reported nothing.

This is a trap built into the recommended workflow: the tool tells you to edit the mirror, and the safe pre-push check destroys what you edited.

**Repro:**
1. `readDocument(docId, format='markdown')` — mirror file is written.
2. Edit the mirror file locally, do not push.
3. `readDocument(docId, format='markdown', diffFromLastRead=true)`.
4. The mirror file is back to the live content. The local edits are gone.

**Suggested fixes (any one):**
- Refuse to overwrite a mirror whose mtime is newer than the last read, and return an error naming the conflict.
- Back the existing file up to `<docId>.md.bak` before overwriting and say so in the result.
- Add a `writeLocalFile` boolean (default true) so a staleness check can be run without touching the file.
- Return the diff without rewriting the mirror when `diffFromLastRead=true`.

**Evidence:** doc `1lgUTj4ETTeuYFNB4u5WqifDXxvneVRCtDab_gTpruN0`, 2026-08-28. Mirror path `C:\Users\2supe\AppData\Local\Temp\google-tools-mcp-2supe\1lgUTj4ETTeuYFNB4u5WqifDXxvneVRCtDab_gTpruN0.md`. Diff before the read showed my section present; `grep` after the read returned 0 matches.

<details>
<summary>Diagnostic Info</summary>

- **Server version:** 2.0.0
- **Node version:** v22.22.3
- **OS:** win32 10.0.26200 (x64)
- **Auth status:** valid
- **Scopes:** documents, drive, spreadsheets, script.external_request, gmail.modify, gmail.compose, gmail.send, gmail.settings.basic, gmail.settings.sharing, calendar, forms.body, forms.body.readonly, forms.responses.readonly, presentations, tasks, service.management

</details>


## Issue #123: Markdown export is not round-trip safe: a header after a list loses its blank line and gets merged into the last list item on push

## Description

**What happened:** `readDocument(format='markdown')` emits a bold-header paragraph that directly follows a bulleted or numbered list with **no blank line** between them:

```
- We hand you your sticker sheet at setup. ...
**Free Social Media Content**
```

Pushing that exact text back with `replaceDocumentWithMarkdown` merges the header into the last list item, so the doc ends up with one paragraph reading `...nobody misses you. Free Social Media Content` and the header is gone. A plain read-then-write round trip with zero edits corrupts the document.

Confirmed by pushing to a throwaway copy and reading it back as `format='text'`: 4 paragraph merges in a doc with 5 lists. Inserting a blank line before each such header fixes it, so the parser is behaving correctly — the **exporter** is what emits non-round-trippable markdown.

**Repro:**
1. Make a doc with a bulleted list followed by a bold-text paragraph acting as a header.
2. `readDocument(format='markdown')`.
3. `replaceDocumentWithMarkdown` with the unmodified mirror file.
4. `readDocument(format='text')` — the header is now glued onto the last list item.

**Fix:** emit a blank line after the final item of any list in the markdown export. Same class of problem as the trailing-space-before-`**` bug (issue #118): the export is not a valid input to the import.

**Evidence:** doc `1lgUTj4ETTeuYFNB4u5WqifDXxvneVRCtDab_gTpruN0` and its copy `10ku-j3CKRT3ByuOGT6bqwxMTvKGFh-ADDbVyVGctM0Q`, 2026-08-28.

<details>
<summary>Diagnostic Info</summary>

- **Server version:** 2.0.0
- **Node version:** v22.22.3
- **OS:** win32 10.0.26200 (x64)
- **Auth status:** valid
- **Scopes:** documents, drive, spreadsheets, script.external_request, gmail.modify, gmail.compose, gmail.send, gmail.settings.basic, gmail.settings.sharing, calendar, forms.body, forms.body.readonly, forms.responses.readonly, presentations, tasks, service.management

</details>

