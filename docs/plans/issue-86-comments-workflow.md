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
