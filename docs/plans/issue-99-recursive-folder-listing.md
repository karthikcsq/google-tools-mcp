# Plan: depth/recursive option for listFolderContents (#99)

Issue: [#99](https://github.com/karthikcsq/google-tools-mcp/issues/99) · Verified against `main` @ 8640240.

## Root cause

`listFolderContents` (`dist/tools/drive/listFolderContents.js`) issues exactly one `files.list` for one parent (`:35-53`) — no depth concept, and no pagination either (`pageSize` = `maxResults` ≤ 100, `nextPageToken` never requested). Folder IDs at depth N are only learnable from results at depth N−1, so mapping a tree is forced into serial round trips: the evidence session took 14 sequential calls for one small subtree. The API supports batching an entire level in one query (`'A' in parents or 'B' in parents or ...`), so this is a missing capability in the tool, not an API limitation.

## Design decisions

- **Server-side BFS with per-level parent disjunction** (issue's strategy 1). Strategy 2 (single query for a whole subtree) only works when something else identifies subtree membership — Drive has no "descendant of X" operator; for a *shared drive* you can `corpora:'drive'` and filter client-side, but that fetches the entire drive for a possibly-small subtree and still needs parent-chain reconstruction. Implement BFS now; note the shared-drive fast path as an optimization comment, not scope.
- **Flat output with `path` and `parentId`** (issue's stated preference): each entry `{ id, name, mimeType, path, parentId, modifiedTime, size? }` where `path` is built from the traversal (`<root-name>/sub/name`), root-relative. Envelope matches the richer Drive list tools (`listSharedWithMe.js:81-87`): `{ entries, totalCount, truncated, truncationReason?, unreadable: [...] }`.
- **`depth: 1` stays the exact default.** Schema: `depth: z.union([z.number().int().min(1).max(10), z.literal('all')]).optional().default(1)`. With `depth: 1` and no new params, emit **today's output shape unchanged** (`{folders, files}`) so existing callers see zero difference; the flat shape applies when `depth > 1` or `'all'`. (Alternative — always-new-shape — breaks the issue's own acceptance criterion "depth 1 returns exactly what it returns today".)
- **Safety rails, loud not silent:**
  - `maxItems` (default 500, max 5000) caps total entries across the traversal; on hit, stop, set `truncated: true`, `truncationReason: 'maxItems reached at depth N; M folders not yet expanded'` — a partial tree must announce itself.
  - **Cycle/duplicate guard:** visited-set of folder IDs; a folder reachable twice (multi-parent, upward shortcut) is listed once and expanded once. Shortcuts (`application/vnd.google-apps.shortcut`) are listed with their `shortcutDetails.targetId` but **never expanded** — the simplest complete cycle-proofing, and honest (their children belong to the target's real location).
  - **Unreadable subfolders:** a level query that 403s for some parent must not abort — but a disjunction query fails/succeeds as a unit, so on a level-query 403, bisect: retry parents individually, mark failing ones in `unreadable: [{id, path, reason}]`, continue with the rest.
  - `trashed=false` at every level (already the single-level behavior, `:36`); `supportsAllDrives`/`includeItemsFromAllDrives` carried on every request (already at `:51-52`).
- **Per-level query mechanics:** chunk each level's folder IDs into disjunctions of ~50 parents per query (URL-length safety), request `fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,shortcutDetails)'` — `parents` is required to attach children to the right path when a level has multiple parents — and **paginate each chunk fully** before descending. Escape folder IDs in the query (`replace(/'/g, "\\'")` per `listSharedWithMe.js:44`; also fix the existing unescaped interpolation at `:36` while here). `includeFolders`/`includeFiles` filter *output*; traversal always fetches folders (needed to descend) — with `includeFolders: false`, folder entries are omitted from `entries` but still expanded.

## Implementation

1. Extend `dist/tools/drive/listFolderContents.js` (single file): new params `depth`, `maxItems`; BFS loop as above; keep the 404/403-on-root error mapping (`:72-79`).
2. Depth-1 path: leave the current code path literally intact behind `if (depth === 1)`.
3. Description update: document the two output shapes, the shortcut/no-expand rule, and the truncation contract; mention `getFilePath` for the inverse operation.
4. No new tool → no tool-count churn.

## Tests

New `tests/listFolderContents.test.js`, mocking `getDriveClient` (precedent: `tests/uploadFile.test.js`):

- `depth` omitted → request/response byte-identical to today (fixture pinned before refactor).
- `depth: 2`, root with 3 subfolders → exactly 2 level queries (1 root + 1 disjunction naming all 3), children carry correct `path`/`parentId`.
- `depth: 'all'` on a fixture where a folder appears under two parents and a shortcut points at an ancestor → terminates; duplicated folder expanded once; shortcut listed, not expanded.
- `maxItems: 5` on a larger fixture → `truncated: true` with reason naming unexpanded folders.
- Level query rejecting with 403 → bisection marks only the offending parent `unreadable`, siblings still listed.
- Pagination: a level chunk returning `nextPageToken` gets a follow-up page before descent.
- Query-escaping: folder ID containing `'` produces an escaped query.

## Acceptance criteria

Directly from the issue: depth-1 unchanged; depth-2 on 3 subfolders = one tool call (and ≤ 2 API queries); `depth: 'all'` terminates on cyclic/multi-parent fixtures; truncation explicitly reported; unreadable subfolder marked without aborting; every entry reconstructs the tree via `path`/`parentId`. Plus: the 14-call evidence scenario collapses to one call with ≤ ~4 API queries.

## Sequencing

Independent. Touches one file — safe to land anytime; coordinate trivially with #71's client-import changes.
