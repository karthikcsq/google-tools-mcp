# Plan: make the conflict guard precise, informative, and overridable (#108)

Issue: [#108](https://github.com/karthikcsq/google-tools-mcp/issues/108) · Verified against `main` @ 7572a8b. Builds directly on [#87](issue-87-read-write-state.md).

## Root cause

The guard answers a question nobody asked. It compares the Drive **file-level `modifiedTime`** (`dist/readTracker.js:106-118`) — a string inequality on whole-file metadata — and rejects the write if it moved. It has no notion of *what* changed, *where* it changed, or whether it overlaps the pending edit. The stored `revisionId` (`:60`) is never consulted here; it is only passed downstream as `writeControl.requiredRevisionId`.

Consequences, all verified:

1. **Metadata-only changes block edits.** Nothing distinguishes a content edit from a rename or permission change. The reporter's case — a title edit while the target text was byte-identical — is the canonical instance. Sharpest evidence: **this server's own `renameFile` tool trips its own guard.** `dist/tools/drive/renameFile.js:18-25` calls `drive.files.update({requestBody:{name}})` and never touches the tracker, so renaming a tracked doc through the server guarantees the next `modifyText` fails with an *empty* diff.
2. **The unblock path is a full re-read**, and the read mode six tool descriptions recommend (`format='json'`) is itself unusable at real document sizes (#105).
3. **The error usually carries no information.** The diff branch requires `entry.content && typeof opts.contentFetcher === 'function'` (`:120`), and `trackRead` stores content **only for markdown reads** (`readGoogleDoc.js:130,149` vs `:94` json / `:214` text — `readTracker.js:55-61` stores `null` otherwise). So a caller who followed the documented json workflow always gets the bare two-timestamp message (`:173-177`).
4. **No override exists.** Zero occurrences of `force`/`expectedRevisionId`/`ifMatch` anywhere in `dist/`; the only bypass is the internal `skipExternalCheck` used by `deleteFile.js:20`.

Root cause in one sentence: **the guard's signal is file metadata rather than document content, and its failure mode is a dead end rather than a decision point.**

## Relationship to #87 (read first)

#87 replaces the metadata signal with revision-first detection plus content-equality fallback. That alone resolves symptom 1: a rename does not advance the Docs `revisionId`, and where a revision did advance without a content change, the content comparison lets the write proceed. **#108 is not a duplicate** — it adds the three things #87 does not: *range* precision, *explanatory* failures, and an *escape hatch*. Land #87 first; this plan assumes its `revisionFetcher`/scope-aware `contentFetcher` exist.

## Design decisions

- **Range-scoped conflict evaluation, computed from the diff we already have.** When revision + content comparison says the document genuinely changed, don't stop at "changed" — diff the stored snapshot against current content (the existing `createPatch` machinery, `readTracker.js:141-171`) and map each hunk to a document range. Block only when a hunk **overlaps the pending edit's range**, with a small context margin; otherwise proceed and re-arm the tracker. The pending range is already known at every call site: `modifyText` resolves it before mutating (`modifyText.js:149`), and range-target tools have it directly. `guardMutation` gains an optional `targetRange` — callers that can't supply one (whole-body replace, Sheets) keep today's document-scoped behavior, which is correct for them.
  - Honest bound, stated in the code and the docs: hunk↔index mapping is computed on the **markdown projection**, not on Docs indices, so overlap is approximate. It is therefore used to *permit* narrowly and *block* generously — any hunk that cannot be confidently mapped counts as overlapping. The API-level `WriteControl.requiredRevisionId` remains the backstop for anything this misjudges.
- **Every rejection explains itself**, regardless of read format. Three tiers, best available:
  1. Full unified diff (today's best case) when a content snapshot exists.
  2. When no snapshot exists (json/text reads), fetch current content in the guard and report a **change summary** — "title changed", "N paragraphs inserted near index X", "M paragraphs modified, none overlapping your target range" — rather than two timestamps. The fetcher is already available; the bare message exists only because the *stored* side was null.
  3. Always name the concrete next step, and never recommend a read mode that can't complete: point at `format='index'` (#105) or `diffFromLastRead`, not `format='json'`.
  - Also: make `trackRead` store a content snapshot for **text and index reads**, not only markdown (`readGoogleDoc.js:94,214`) — cheap, and it moves most callers from tier 2 to tier 1.
- **An override that requires stating what you believe.** Add `expectedRevisionId` (proceed if the document's current revision matches what the caller asserts) rather than a bare `force: true`. A caller who has verified safety can express *why* it is safe, and a stale assertion still fails. Bare `force` would let an agent paper over exactly the corruption this subsystem exists to prevent; `expectedRevisionId` costs one field and preserves the invariant. Document `readDocument`'s returned revision as the way to obtain it.
- **Exact-unique-match as evidence (#108's last suggestion): accepted, narrowly.** When the target is `textToFind`, the match is **unique** in the current document, and the pending operation does not span a changed hunk, the guard proceeds — a unique exact match against *current* content is direct proof the anchor survived. Not accepted for index-based targets, where identical text says nothing about position.
- **Fix the tracker-desync source while here:** `renameFile.js` (and any other server tool mutating Drive metadata on a tracked file) must refresh the tracker's stored `modifiedTime` instead of leaving it stale. A tool that guarantees its sibling tools will fail is a defect independent of everything above.

## Implementation

1. `dist/readTracker.js`: `guardMutation` accepts `targetRange`; hunk extraction from the computed patch; overlap decision with the conservative fallback; tiered error construction; `expectedRevisionId` handling.
2. Thread `targetRange` from `modifyText.js:110` (post-resolution), `deleteRange.js:33`, `findAndReplace.js:30`, and #88's `batchModifyText`/#107's `replaceRangeWithMarkdown` (whole-range).
3. `expectedRevisionId` parameter on the mutating Docs tools that take a guard; document it in each description.
4. `trackRead` content snapshots for text/index reads (`readGoogleDoc.js:94,214`).
5. `renameFile.js`: refresh tracker metadata post-rename.
6. Error strings: replace `format='json'` guidance with `format='index'` / `diffFromLastRead`.

## Tests

Extend `tests/readTracker.test.js` and add `tests/guardRangePrecision.test.js`:

- **The #108 repro:** stored snapshot vs current differing only in the title / only in a far-away paragraph, with a `targetRange` elsewhere → write proceeds; the tracker re-arms.
- Overlapping change → still blocked, with the diff.
- Unmappable/ambiguous hunk → blocked (conservative fallback proven, not just claimed).
- Tier 2: json-read-then-conflict produces a change **summary**, not two bare timestamps.
- `expectedRevisionId`: correct value proceeds; stale value fails naming both revisions; absent behaves as today.
- Unique `textToFind` still matching current content + non-overlapping change → proceeds; **non-unique** match → does not get the exemption.
- `renameFile` on a tracked document → subsequent `modifyText` is not blocked (the self-inflicted-failure regression).
- Sheets/whole-body callers with no `targetRange` → unchanged document-scoped behavior.

## Acceptance criteria

- An unrelated edit elsewhere in the document — including a title change or a collaborator's edit in another section — no longer blocks a safe, non-overlapping write.
- Every rejection says what changed and gives a next step that works at real document sizes.
- A caller who has verified safety can proceed via `expectedRevisionId`; a caller who is wrong about the revision still cannot.
- Renaming a document through this server no longer breaks this server's next edit.
- Genuine overlapping conflicts are still rejected with a diff (existing suites green).

## Sequencing

Strictly after #87 (revision-first signal, scope-aware fetchers). Benefits from #105 (`format='index'` as the recommended unblock path) and feeds #88/#107, whose range-scoped tools supply `targetRange` naturally.
