# Plan: correct Docs read/write state and isolate working copies (#87)

Issue: [#87](https://github.com/karthikcsq/google-tools-mcp/issues/87) (canonical for closed #94, #97) · Verified against `main` @ 8640240.

## Root causes

The read-before-write layer has one conceptual defect with three visible symptoms, plus two adjacent gaps found during verification:

1. **Wrong conflict signal.** `guardMutation` (`dist/readTracker.js:106-118`) compares Drive `modifiedTime`, which changes on comment activity, permission changes, and other metadata events that leave document *content* identical. The Docs API's own `revisionId` — which the tracker already stores (`readTracker.js:60`) and already uses for `WriteControl` — is the content-change signal. Result: adding a comment between read and write produces a rejected write whose "diff" is empty.
2. **Creates don't seed the tracker.** Every `trackRead` call site is a *read* tool (`readGoogleDoc.js:94,130,149,214`, `readDriveFile.js:86,151`, `readFile.js:62`, `readSpreadsheet.js:26`, `getSpreadsheetInfo.js:20`). No creation tool seeds it — `createDocument.js` has no readTracker import at all — so create-then-write, where the caller *is* the sole author of the content, is rejected (7 occurrences across 6 of 13 reviewed sessions per the issue).
3. **Working copies collide across sessions.** `dist/workspace.js:61-65` keys the file by `documentId[.tabId]` only, in a shared per-user temp dir. Read-tracker state is per-session (`readTracker.js:23-37`), but two HTTP sessions reading the same doc overwrite one file.
4. **(Found in verification, not in the issue) Seven mutating Docs tools skip `guardMutation` entirely:** `insertTable.js`, `insertTableWithData.js`, `insertPageBreak.js`, `insertImage.js`, `addTab.js`, `renameTab.js`, `formatting/applyParagraphStyle.js` use only `getLastReadRevisionId` + `trackMutation`. On a never-read document, `getLastReadRevisionId` returns undefined, so they write with **no protection at all** — the guard the whole subsystem exists to provide.
5. Freshness/cleanup/canonical-status semantics of the working copy are undocumented.

## Design decisions

- **Revision-first conflict detection, content-equality fallback.** Primary signal: fetch the Docs `revisionId` (narrow field mask) and compare to the stored one. Equal → proceed (regardless of `modifiedTime`). Different → revisions are opaque and can advance without visible content change (Apps Script, autosave quirks — see the existing workaround note at `insertImage.js:89`), so before rejecting, fetch content via the existing `contentFetcher` hook and compare against the stored snapshot; identical content → proceed and re-arm the tracker with the new revisionId. Only genuinely different content rejects, with the existing unified-diff message (`readTracker.js:141-171`). Drive `modifiedTime` drops out of the decision entirely; keep storing it for diagnostics only. Non-Docs files (Sheets, Drive files) have no revisionId in the tracker — they keep the current modifiedTime path (documented as such).
- **Seed on create, because the caller's knowledge is the point.** The guard exists to guarantee the writer knows current content. The creator of a document knows its content by construction. `createDocument` (and `copyFile`, `createFromTemplate`, sheets creators) should call `trackRead(id, { modifiedTime, content, revisionId })` with what they just wrote. For `createDocument` with markdown content, fetch `revisionId` after the insert (one narrow `documents.get`) so the seed is trustworthy rather than a blind pass.
- **Namespace working copies per session.** `getWorkspacePath` gains the session component: `<docId>[.<tabId>][.<sessionSuffix>].md` where `sessionSuffix` = sanitized `currentSessionKey()` (from `dist/sessionContext.js`), empty for stdio (preserving today's paths for the single-session case that all existing docs/tests reference). Wire `clearSession` (`readTracker.js:44-46`, called on HTTP disconnect at `index.js:154-161`) to also delete that session's workspace files — bounded cleanup for free.
- **Close the guard bypass (item 4) as part of this issue**, not a new one: it is the same subsystem and the fix is mechanical — add `guardMutation` calls mirroring `modifyText.js:110-119` to the seven tools. `tests/extraDocsToolsWriteControl.test.js` already exercises exactly these tools and will need its fixtures to perform a read first.

## Implementation

1. `dist/readTracker.js`: restructure `guardMutation`'s external-change block (`:106-177`) per the decision above — `revisionFetcher` option (narrow `documents.get`, `fields: 'revisionId'`) for Docs callers; content-equality fallback via existing `contentFetcher`; keep `skipExternalCheck` escape hatch. Callers that pass `contentFetcher` today (`replaceDocumentWithMarkdown.js:40-49`) need no signature change.
2. Seed sites: `dist/tools/drive/createDocument.js` (after `:63-66` insert), `copyFile.js`, `createFromTemplate.js`, `dist/tools/sheets/createSpreadsheet.js` (+ any other creators found by grepping `files.create|spreadsheets.create`) → `trackRead` with known content + fetched revision.
3. `dist/workspace.js:61-65`: session-suffix path; `dist/index.js` disconnect handler: workspace cleanup alongside `clearSession`.
4. The seven unguarded tools: add `guardMutation` (with `contentFetcher` where a docs client is already in scope).
5. Docs: extend the tool descriptions of `readDocument`/`replaceDocumentWithMarkdown` and `docs/architecture.md` with the working-copy contract: convenience mirror, not canonical; freshness = last read; cleaned up on session end; path may include a session suffix.

## Tests

- `tests/readTracker.test.js` additions: comment-activity simulation (modifiedTime changes, revisionId same → write proceeds); revision changed + content identical → proceeds and re-arms; revision changed + content different → rejects with diff.
- New create-then-write regression (shared with #56's plan): `createDocument` → `modifyText` on the returned id succeeds without an intervening read; same for Sheets. Mock at `dist/clients.js` per the established pattern.
- Consecutive writes advance tracker revision (extend `tests/writeControlRevisionAdvance.test.js`).
- `tests/sessionIsolation.test.js`: two sessions reading the same doc produce distinct workspace paths; disconnect removes only that session's files.
- Guard-bypass closure: extend `tests/extraDocsToolsWriteControl.test.js` — each of the seven tools now rejects on a never-read document.

## Acceptance criteria

- Comment activity between read and write no longer rejects a content-identical write.
- Create-then-immediately-write succeeds for Docs and Sheets creators.
- All mutating Docs tools reject never-read documents; none bypass the guard.
- Two concurrent HTTP sessions cannot overwrite each other's working copies; session teardown cleans them.
- Working-copy semantics are documented where callers will see them.
- The guard still rejects truly external edits with a useful diff (existing tests keep passing).

## Sequencing

Before #88 (its dryRun/diff features build on the corrected conflict signal). The create-then-write test satisfies part of #56. #96's plainMarkdown work touches `readGoogleDoc.js` — coordinate merges, no logical dependency.
