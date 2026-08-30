# Plan: make the Docs comment workflow reliable, incremental, and complete (#86)

Issue: [#86](https://github.com/karthikcsq/google-tools-mcp/issues/86) (canonical for closed #90, #102) · Verified against `main` @ 8640240. Revised after adversarial review.

## Root causes (three independent defects, one shared cause underneath)

1. **`resolveComment` is a no-op by API design.** `dist/tools/docs/comments/resolveComment.js:25-33` sends `resolved: true` through `drive.comments.update`. The Drive v3 `comments.resolved` field is **output-only**; the supported resolution mechanism is creating a reply with `action: 'resolve'` (`drive.replies.create`). The code even ships a verification step (`:35-45`) and an apologetic fallback message — symptoms of building on the wrong primitive rather than switching to the right one.
2. **`listComments` structurally cannot report replies.** Its field mask (`listComments.js:22`) omits `replies`, yet the mapper computes `replyCount: comment.replies?.length || 0` (`:33`) — always 0 — and emits `modifiedTime` (`:32`) which is also never requested — always undefined. Callers see "no replies" on commented threads and cannot poll incrementally (no `startModifiedTime`, no pagination: `pageSize: 100` hardcoded, `nextPageToken` never read).
3. **No `updateComment` tool exists** — the only `comments.update` call in the repo is the broken resolve. Editing a top-level comment means delete + recreate, losing identity and timestamps.

The shared cause: the comment tools were written against a *guessed* API surface rather than the documented Drive comments/replies contract, and nothing tests them (zero comment coverage in `tests/`; the `execute()` paths have never run under test). Fixing the three symptoms without adding contract tests would leave the door open for the same class of bug.

## Implementation

### 1. Rewrite `resolveComment` on the supported path

`resolveComment.js`: replace the get/update/verify sequence with

```js
const res = await drive.replies.create({
    fileId: args.documentId, commentId: args.commentId,
    requestBody: { action: 'resolve', content: args.note ?? '' },
    fields: 'id,action',
});
```

then verify with `comments.get` (`fields: 'resolved'`) and **throw `UserError` on failure** instead of returning the current soft "may not persist" apology (`:45`). Optional new `note` param becomes the resolution reply's text. Remove the "may not persist" caveat from the description (`:9`). Add the symmetric `reopenComment` only if the API's `action: 'reopen'` verifies in a manual test — otherwise leave it out rather than shipping another guess.

### 2. Fix `listComments` for real review loops

- Field mask → `nextPageToken,comments(id,content,quotedFileContent,author(displayName,me),createdTime,modifiedTime,resolved,replies(id,content,action,author(displayName,me),createdTime))`. `author.me` is required for any ownership-based filtering — `displayName` alone cannot identify the authenticated user.
- Params: `pageToken` (string, optional), `maxResults` (1–100, default 50 → maps to `pageSize`; default lowered from the hardcoded 100 to bound response size now that replies are included), `updatedAfter` (ISO datetime, optional → maps to `startModifiedTime`), `includeDeleted` (bool, default false), `includeQuotedText` (bool, default true — when false, drop `quotedText` from output to save tokens), `unansweredOnly` (bool, default false — client-side filter: keep unresolved comments whose latest reply is not by the authenticated user, using `author.me`; state the heuristic verbatim in the description).
- Output: keep the `{ comments }` shape, now with accurate `replyCount`, real `modifiedTime`, plus `nextPageToken` and `count` (comments in *this page* — deliberately not named `totalCount`, which would be misleading under pagination; the `listSharedWithMe.js:81-87` envelope's `totalCount` has exactly that defect). Truncate `content`, reply `content`, and `quotedText` to 2,000 chars each with a `…[truncated]` marker so a comment-heavy doc cannot blow the response size; note the limit in the description.
- Delete the dead work: `docs.documents.get` and the discarded `getDriveClient()` at `listComments.js:12-16` (one wasted Docs round-trip per call today).

### 3. Add `updateComment`

New `dist/tools/docs/comments/updateComment.js`: `updateComment(documentId, commentId, content)` → `drive.comments.update` with `requestBody: { content }`, `fields: 'id,content,modifiedTime'` (content **is** writable; resolved is not). Register in `comments/index.js`. Count bookkeeping, precisely: default registry 156→157 and alias-enabled total 228→229 in `tests/toolRegistration.test.js`; the 72-alias count is untouched (the alias registry is a fixed opt-in set, `legacyAliases.js:29-68` — no alias is added for a new camelCase tool). Also update the README **docs category** section (currently "22 tools" with a name list, `README.md:358-361`) — the `documentationConsistency` test checks only the global count and category headings, not per-category counts or names, so this line must be edited deliberately or it rots silently.

### 4. Shared cleanup while touching every file

- All six comment tools build a private `google.drive(...)` per call and bypass the cached client (`resolveComment.js:16-17` et al.). Switch them to `getDriveClient()` from `dist/clients.js:233-237` like every other Drive tool.
- `addComment.js:31-48` quoted-text extraction misses tables/tabs — out of scope here; leave a code comment pointing at #88's structure work.

## Tests (the missing contract layer)

New `tests/comments.test.js`, mocking `dist/clients.js` (the established pattern, e.g. `tests/gmailThreads.test.js:6`):

- **resolve → verify:** mock `replies.create` + `comments.get({resolved:true})` → success message; mock `comments.get({resolved:false})` → expect `UserError` (hard failure). Assert `comments.update` is **never called** by resolve.
- **reply → list:** mock a comment with two replies; `listComments` returns `replyCount: 2` and reply metadata.
- **incremental & pagination, end to end:** `updatedAfter` forwarded as `startModifiedTime`; `includeDeleted` and `maxResults` visibly alter the request; two-page fixture — first call returns `nextPageToken`, second call with that `pageToken` returns the second page's comments (proving the >100-comment workflow, not just token forwarding).
- **update-in-place:** `updateComment` sends only `{content}` and surfaces `modifiedTime`.
- **filters:** `unansweredOnly` keeps a comment whose last reply has `author.me: false`, drops resolved ones and those last-answered with `author.me: true`; truncation markers applied at the content cap.
- **whole-directory regression:** all seven tools (`addComment`, `getComment`, `listComments`, `replyToComment`, `resolveComment`, `deleteComment`, `updateComment`) registered, and each `execute` observed using the shared `getDriveClient()` mock — i.e., the test's client mock is the *only* Drive surface, so any tool still constructing a private `google.drive` client fails its test by never touching the mock.

## Acceptance criteria

- Resolving a comment flips it to resolved in the Docs UI (manual verification once against a real doc, since the old code's failure was exactly a UI-invisible "success").
- `listComments` on a doc with replies reports accurate counts; polling with `updatedAfter` returns only newer activity; >100 comments are reachable via pagination.
- Top-level comment edits preserve comment ID and creation time.
- All of the above pinned by mocked contract tests; suite green.

## Out of scope

Full-body replace orphaning comment anchors is #88's problem (tracked there, not here).

---

## Implementation status (2026-08-19)

All plan items implemented as specified. Files touched (all under
`dist/tools/docs/comments/**` plus this plan doc, per the worker's file scope):

- `dist/tools/docs/comments/resolveComment.js` — rewritten on the `replies.create({action:'resolve'})`
  path, verified with `comments.get({fields:'resolved'})`, throws `publicError` (hard failure) if
  verification still shows unresolved. Added optional `note` param (becomes the resolve reply's
  content). Removed the "may not persist" caveat from the description. Dropped the dead
  `comments.get({fields:'content'})` pre-read the old `comments.update` path needed. Switched off
  `getAuthClient()` + private `google.drive(...)` onto `getDriveClient()`.
  **Deferred: `reopenComment`.** Plan explicitly gates it on manually verifying `action:'reopen'`
  against a live doc; no live Google account is available to this worker, so it is left out
  rather than shipped as an unverified guess, per the plan's own instruction.
- `dist/tools/docs/comments/listComments.js` — full rewrite. Field mask now includes
  `replies(id,content,action,author(displayName,me),createdTime)`, `modifiedTime`, and
  `author(displayName,me)`. New params: `maxResults` (1-100, default 50, replaces the hardcoded
  `pageSize: 100`), `pageToken`, `updatedAfter` (ISO datetime -> `startModifiedTime`),
  `includeDeleted`, `includeQuotedText`, `unansweredOnly`. Output adds `count` and
  `nextPageToken`; kept the `{ comments }` shape. Content/quotedText/reply-content truncated at
  2,000 chars with a `…[truncated]` marker. Deleted the dead `docs.documents.get()` call and the
  unused `getAuthClient()`/private-client construction — now uses `getDriveClient()` only.
  `unansweredOnly` heuristic implemented exactly as specified: unresolved AND (no replies OR
  last reply's `author.me !== true`); documented in the tool description and as a code comment.
- `dist/tools/docs/comments/updateComment.js` — **new tool**. `updateComment(documentId,
  commentId, content)` -> `drive.comments.update({ requestBody: { content } }, fields:
  'id,content,modifiedTime')`. Registered in `comments/index.js`. Description states `resolved`
  cannot be changed here.
- `dist/tools/docs/comments/index.js` — registers `updateComment`.
- `dist/tools/docs/comments/addComment.js`, `getComment.js`, `replyToComment.js`,
  `deleteComment.js` — switched from private `google.drive({version:'v3', auth: authClient})`
  construction to the shared `getDriveClient()` (plan item 4, shared cleanup). `addComment.js`
  gained a code comment at its quoted-text extraction loop noting it only walks top-level
  paragraph runs (not tables/tabs) and points at #88, per the plan.

New tests: `tests/comments.test.js` (24 tests, all passing), mocking `dist/clients.js`
(`getDriveClient`, `getDocsClient`; `getAuthClient` deliberately mocked to throw, which doubles
as proof no comment tool still constructs a private client). Covers: resolve-then-verify success/
failure (asserts `replies.create` called, `comments.update` never called for resolve), reply
metadata accuracy, field-mask contents, `updatedAfter` -> `startModifiedTime` forwarding,
`includeDeleted`/`maxResults` request shape, real two-page pagination round trip,
`updateComment`'s exact request body and `modifiedTime` surfacing, `unansweredOnly` filter
semantics (all four cases: no-reply / other-last-reply / self-last-reply / resolved),
2,000-char truncation on comment/reply/quoted text, `includeQuotedText:false` omission, the
7-tool whole-directory registration check, and error-tier checks (structured Drive API detail
surfaced, unstructured error message never leaked raw).

**Tool count:** registry grew 156 -> 157 (one new tool, `updateComment`; no alias added — new
camelCase tools are not in the fixed 72-alias set). Per the TOOL-COUNT RULE for this session,
`tests/toolRegistration.test.js`, `tests/documentationConsistency.test.js`, and the README tool
counts were deliberately **not** touched. Full-suite run at completion: 6 suites fail exactly on
this count drift (`toolRegistration.test.js`, `documentationConsistency.test.js`,
`mcpSdkV2Compatibility.test.js`, `mcpMigrationInventory.test.js`, `entrypointSmoke.test.js`,
`mcpServerFacade.test.js` — all asserting 156/228 or an inventory snapshot line-numbered against
the old file lengths), 46 suites pass, 784 tests pass (2 skipped), 10 fail (all count/inventory
assertions inside those 6 suites). No failure outside the tool-count/inventory blast radius.
A later reconciliation wave must: bump 156->157 and 228->229 in `toolRegistration.test.js`,
update `documentationConsistency.test.js`'s expectations and the README docs-category tool
list/count (`README.md` docs section, currently "22 tools"), and regenerate
`tests/fixtures/mcp-migration-inventory.json` via
`node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json`.
