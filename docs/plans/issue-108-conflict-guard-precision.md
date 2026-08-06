# Plan: make the conflict guard precise, informative, and overridable (#108)

Issue: [#108](https://github.com/karthikcsq/google-tools-mcp/issues/108) · Verified against `main` @ 7572a8b. Revised after adversarial review. Builds directly on [#87](issue-87-read-write-state.md).

## Root cause

The guard answers a question nobody asked. It compares the Drive **file-level `modifiedTime`** (`dist/readTracker.js:106-118`) — a string inequality on whole-file metadata — and rejects the write if it moved. It has no notion of *what* changed, *where*, or whether it overlaps the pending edit. The stored `revisionId` (`:60`) is never consulted here.

Verified consequences:

1. **Metadata-only changes block edits.** The reporter's case (a title edit while the target text was byte-identical) is canonical. Sharpest evidence: **this server's own `renameFile` trips its own guard** — `dist/tools/drive/renameFile.js:18-25` calls `drive.files.update({requestBody:{name}})` and never touches the tracker, so renaming a tracked doc guarantees the next `modifyText` fails with an *empty* diff.
2. **The unblock path is a full re-read**, and the mode six tool descriptions recommend (`format='json'`) is itself unusable at real sizes (#105).
3. **The error usually carries no information.** The diff branch needs `entry.content && typeof opts.contentFetcher === 'function'` (`:120`), and `trackRead` stores content **only for markdown reads** (`readGoogleDoc.js:130,149` vs `:94` json / `:214` text; `readTracker.js:55-61`). Callers following the documented json workflow always get the bare two-timestamp message (`:173-177`).
4. **No override exists** — zero occurrences of `force`/`expectedRevisionId`/`ifMatch` in `dist/`; the only bypass is the internal `skipExternalCheck` (`deleteFile.js:20`).

Root cause: **the guard's signal is file metadata rather than document content, and its failure mode is a dead end rather than a decision point.**

## Relationship to #87

#87 replaces the metadata signal with revision-first detection plus content-equality fallback, resolving symptom 1. **#108 adds what #87 does not:** range precision, explanatory failures, and an escape hatch. Land #87 first.

## Design decisions

- **Range precision requires re-resolution, not just an overlap test.** The review caught a real hole in the naive design: permitting a write because a change was "non-overlapping" is unsafe if that change was an *insertion or deletion before the target*, which shifts the target's indices — `modifyText` resolves indices once (`modifyText.js:141-160`) and writes those same indices later (`:169-187`). So the rule is:
  - The guard evaluates against the **current** document, and when it permits a write over a changed document, the caller **must re-resolve its target against that same fetched snapshot** before writing. `guardMutation` returns the snapshot it fetched (rather than discarding it), and the permitting path is only available to callers that pass a re-resolution callback. A caller that cannot re-resolve gets today's conservative rejection.
  - For `textToFind` targets, re-resolution is exactly `findTextRangeInDoc` against the returned snapshot (#88's refactor) — cheap and already needed.
  - For explicit-index targets, the caller cannot re-resolve (an index is not a semantic anchor), so **any** content change before or overlapping the range blocks. Index targets get precision only for changes strictly *after* the range end.
- **Overlap classification is conservative and explicitly bounded.** Hunks come from the existing `createPatch` machinery (`readTracker.js:141-171`), computed on the **markdown projection**, which trims text, adds markers, and omits non-text structure (`docsToMarkdown.js:176-204`). Mapping markdown hunks to Docs indices is therefore approximate, so: any hunk that cannot be confidently mapped, any change touching tables/images/structure, and any change at or before the target counts as **overlapping** (block). Precision is claimed only for the clean case — text changes wholly after the target, or a re-resolvable `textToFind` anchor that still matches uniquely. This is deliberately narrow: it fixes the reported scenario without inventing a mapping the data cannot support.
- **`findAndReplace` stays document-scoped.** Correction from review: it replaces every occurrence across the document/tab (`findAndReplace.js:44-52`), so there is no single pending range; passing one would permit a conflict at another occurrence. It keeps today's behavior.
- **Every rejection explains itself**, three tiers:
  1. Full unified diff when a content snapshot exists.
  2. No snapshot (json/text reads) → fetch current content in the guard and report a **change summary**: paragraphs added/removed/modified with approximate locations, and whether any of them are near the target. **Metadata changes need a Drive fetch to name** — a title rename is `files.update` (`renameFile.js:18-25`) and is invisible to `documents.get`/`docsToMarkdown`, so "title changed" is reported only when the guard compares the Drive `name` field it fetches alongside `modifiedTime` (one extra field on a call already being made). Anything not so identified is reported generically, not guessed.
  3. Always name a next step that works — `format='index'` (#105) or `diffFromLastRead`, never `format='json'`.
  Also: `trackRead` stores content snapshots for **text and index reads**, not only markdown, moving most callers from tier 2 to tier 1.
- **`expectedRevisionId`, wired end to end.** Correction from review: an override that only bypasses the external check would still fail against the stale `getLastReadRevisionId` fed to WriteControl (`modifyText.js:180-185`). So when supplied and matching the document's current revision, it **both** satisfies the guard **and** becomes the `requiredRevisionId` for the mutation — the caller's assertion is what the API enforces. A stale assertion fails at the guard, naming expected vs actual. Chosen over bare `force: true` because it still requires the caller to be right.
- **Exact-unique-match as evidence: accepted, narrowly, and only with re-resolution.** A `textToFind` target that still matches uniquely in the *current* snapshot, where the re-resolved range does not intersect a changed hunk, proceeds using the **re-resolved** indices. Not available for index targets.
- **Fix the tracker-desync source:** `renameFile` must refresh the tracker's stored `modifiedTime`/name. A tool that guarantees its siblings will fail is a defect on its own.

## Implementation

1. `dist/readTracker.js`: `guardMutation` accepts `targetRange` + `reresolve` callback, returns the fetched snapshot; hunk extraction and conservative overlap classification; Drive `name` compared alongside `modifiedTime`; tiered error construction; `expectedRevisionId` handling that also supplies `requiredRevisionId`.
2. Thread `targetRange` + `reresolve` from `modifyText.js:110` (post-resolution), `deleteRange.js:33`, and #88's `batchModifyText` / #107's `replaceRangeWithMarkdown`. `findAndReplace` and Sheets callers stay document-scoped.
3. `expectedRevisionId` parameter on the guarded mutating Docs tools; documented per tool.
4. `trackRead` content snapshots for text/index reads (`readGoogleDoc.js:94,214`).
5. `renameFile.js`: refresh tracker metadata post-rename.
6. Replace `format='json'` guidance in guard error strings with `format='index'`.

## Tests

Extend `tests/readTracker.test.js`; add `tests/guardRangePrecision.test.js`:

- **The #108 repro:** change confined to the title / to a far-away paragraph, target elsewhere → proceeds; tracker re-armed.
- **The stale-index case (the hole this revision closes):** a paragraph *inserted before* the target with the target text unchanged → an explicit-index target is **blocked**; a `textToFind` target is permitted **and the write uses re-resolved indices** (assert the emitted request's range equals the new position, not the old one).
- Overlapping change → blocked with diff. Unmappable hunk, table/image change, structural change → blocked (conservative fallback proven).
- Tab-scoped ranges: change in tab A with target in tab B → correct classification (no cross-tab false permit).
- Tier 2: json-read-then-conflict yields a change summary, not two timestamps; a rename yields "title changed" (Drive `name` comparison), while an unidentified metadata change is reported generically.
- `expectedRevisionId`: correct value proceeds **and appears as `requiredRevisionId` in the batchUpdate**; stale value fails naming both; absent behaves as today.
- Unique `textToFind` + non-overlapping change → proceeds; non-unique → no exemption; unique but shifted by an earlier edit → proceeds only with re-resolved indices.
- `findAndReplace` remains document-scoped (no `targetRange` accepted).
- `renameFile` on a tracked doc → next `modifyText` not blocked.
- Sheets/whole-body callers unchanged.

## Acceptance criteria

- An unrelated edit elsewhere — a title change, or a collaborator's edit in another section — no longer blocks a safe write, and a permitted write over a changed document always uses freshly resolved indices.
- Every rejection says what changed and gives a next step that works at real document sizes.
- `expectedRevisionId` lets a verified caller proceed and is enforced by the API; a wrong assertion cannot.
- Renaming a document through this server no longer breaks this server's next edit.
- Genuine overlapping conflicts, structural changes, and index-target ambiguity are still rejected (existing suites green).

## Sequencing

Strictly after #87. Benefits from #105 (`format='index'` as the unblock path) and #88 (`findTextRangeInDoc` is the re-resolution primitive). **#88 ships first with document-scoped guarding; this plan then adds `targetRange`/`reresolve` to it** — resolving the ordering ambiguity flagged between the two plans.
