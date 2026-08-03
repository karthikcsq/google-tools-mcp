# Plan: depth/recursive option for listFolderContents (#99)

Issue: [#99](https://github.com/karthikcsq/google-tools-mcp/issues/99) · Verified against `main` @ 8640240. Revised after adversarial review.

## Root cause

`listFolderContents` (`dist/tools/drive/listFolderContents.js`) issues exactly one `files.list` for one parent (`:35-53`) — no depth concept, no pagination (`nextPageToken` never requested). Folder IDs at depth N are only learnable from results at depth N−1, so mapping a tree is forced into serial round trips (14 sequential calls in the evidence session). The API supports batching an entire level in one query (`'A' in parents or 'B' in parents`), so this is a missing tool capability, not an API limitation.

## Design decisions

- **Server-side BFS with per-level parent disjunction.** ("One query for the whole subtree" doesn't exist — Drive has no descendant operator; the shared-drive corpora trick fetches a whole drive to filter client-side. Note as a possible future optimization, not scope.)
- **Existing parameter names are kept**: the live params are `includeSubfolders` / `includeFiles` (`listFolderContents.js:12-21`) — the new behavior extends them, never renames. New params: `depth` (`z.union([z.number().int().min(1).max(10), z.literal('all')])`, default 1) and `maxItems` (int, 1–5000, default 500).
  - **Schema coherence rules** (zod `.refine`, tested): `maxItems` only valid with `depth > 1` (at depth 1 the legacy `maxResults` contract governs and `maxItems` would be dead — reject the combination with a clear message); `includeSubfolders: false` with `depth > 1` is contradictory (you cannot descend into what you excluded) — rejected.
  - **`maxResults` vs `maxItems`:** at depth 1, exactly today's semantics. At depth > 1, `maxResults` is ignored (documented in both descriptions); traversal uses an internal page size of 100 and `maxItems` is the only cap.
- **Flat output with `path` and `parentIds`.** Depth-1 with no new params returns **today's `{folders, files}` shape byte-identically** (the current code path kept literally intact behind `if (depth === 1)`). Depth > 1 returns `{ entries, count, truncated, truncationReason?, unreadable: [...], apiCalls }` where each entry is `{ id, name, mimeType, path, parentIds, modifiedTime, size? }`:
  - `path` = `<startFolderName>/…/name`, rooted at the start folder. The start folder's name is **not** in any child listing — resolve it with one `files.get(folderId, fields:'id,name')` up front (also serving as the existing 404/403 error mapping for the start folder, `:72-79`). `folderId:'root'` resolves to the actual root name ("My Drive").
  - **Multi-parent representation, decided:** entries are *nodes listed once*. `path` is built via the **first-discovered** parent (BFS order, deterministic); `parentIds` carries **every** parent-edge discovered during the traversal, so the alternate edges aren't lost even though only one path string is rendered. Documented in the tool description.
- **Safety rails, loud not silent:**
  - `maxItems` hit → stop expanding, `truncated: true`, `truncationReason: 'maxItems (N) reached at depth D; M discovered folders not expanded'`. Hitting the cap mid-page: emit up to the cap, count the remainder toward the unexpanded note.
  - **Cycle/duplicate guard:** visited-set of folder IDs; a folder reachable twice is expanded once (its second edge goes into `parentIds`). Shortcuts (`application/vnd.google-apps.shortcut`) are listed with `shortcutDetails.targetId` but never expanded.
  - **Per-parent failures don't abort.** Only the *initial* `files.get` on the start folder maps to the tool-level 404/403 errors. During traversal, a failed disjunction chunk is bisected to isolate failing parents into `unreadable: [{id, path, reason}]`; 404s on children (deleted mid-traversal) are treated identically to 403s — recorded, not fatal.
  - **API-call budget** bounds the bisection blow-up: hard cap of 50 Drive calls per invocation; reaching it truncates with `truncationReason: 'API call budget (50) exhausted'` and reports `apiCalls`. (Worst-case bisection of a 50-parent chunk alone could otherwise cost 50+ calls.)
  - `trashed=false` at every level; `supportsAllDrives`/`includeItemsFromAllDrives` on every request (already at `:51-52`).
- **Per-level query mechanics:** chunk each level's folder IDs into disjunctions of ~50 parents; `fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,shortcutDetails)'` (`parents` attaches children to the right node when a level has many parents); **fully paginate every chunk before descending**. Escape IDs in the query (`replace(/'/g, "\\'")` per `listSharedWithMe.js:44`) — and fix the existing unescaped interpolation at `:36` while here. `includeFiles: false` filters files from output; folders always both listed and expanded at depth > 1 (they are the traversal).

## Implementation

1. Extend `dist/tools/drive/listFolderContents.js` only: schema additions + refines; depth-1 legacy path untouched; BFS with the mechanics above.
2. Description: two output shapes, multi-parent/node rule, shortcut rule, truncation contract, `maxResults`-ignored-at-depth note, pointer to `getFilePath` for the inverse.
3. No new tool → no tool-count churn.

## Tests

New `tests/listFolderContents.test.js`. **Mocking pattern:** follow the execution-test precedent of `tests/appendMarkdownRevisionRefresh.test.js` — `jest.unstable_mockModule('../dist/clients.js', ...)` with a scripted `files.get`/`files.list` mock (the earlier idea of following `tests/uploadFile.test.js` was wrong — that file only tests registration/schema, no client mock).

- Depth omitted → request and response byte-identical to a pinned pre-refactor fixture (including field selection and `{folders, files}` shape with their exact per-entry fields).
- Legacy filter contract preserved at depth 1: `includeSubfolders:false`, `includeFiles:false`, both-false → UserError — unchanged.
- Schema boundaries: `depth: 0`, `11`, `1.5`, `'all'` accepted only as literal; `maxItems: 0`, negative, `> 5000`; `maxItems` with depth 1 → rejected; `includeSubfolders:false` + `depth:2` → rejected.
- `depth: 2`, root + 3 subfolders → exactly: 1 `files.get` (start name) + 1 root list + 1 disjunction naming all 3; children carry correct `path`/`parentIds`; folders-first invariants gone in flat mode (order documented as BFS).
- `depth:'all'` termination fixture: folder under two parents (expanded once, both edges in `parentIds`), shortcut pointing at an ancestor (listed, not expanded).
- Root-path behavior: `folderId:'root'` uses the resolved root name; start-folder 404 → "Folder not found" UserError (tool-level, unchanged).
- Truncation: `maxItems: 5` mid-page → 5 entries, `truncated`, reason names unexpanded folders; API-budget exhaustion fixture → budget reason + `apiCalls` reported.
- Unreadable: chunk-level 403 → bisection marks only the offending parent, siblings listed; child 404 mid-traversal → recorded in `unreadable`, traversal continues.
- Pagination: a chunk with `nextPageToken` is fully drained (2 pages) **before** any deeper-level query is issued (assert call order); entries deduplicated across pages.
- Output fields: files vs folders both present with `size` only on files; `includeFiles:false` at depth 2 omits files but still descends; duplicate folder *names* under different parents produce distinct paths.
- Query-escaping: ID containing `'` produces an escaped query (both the depth-1 legacy line and disjunction builder).

## Acceptance criteria

From the issue, sharpened: depth-1 unchanged (pinned); depth-2 on 3 subfolders = one tool call and ≤ 3 API calls; `depth:'all'` terminates on cyclic/multi-parent fixtures; truncation and unreadable folders explicitly reported, never silent; every entry reconstructs the tree via `path` + `parentIds`. The 14-call evidence scenario collapses to one call within the API budget (happy path ≈ 4-6 calls; the budget and `apiCalls` field make the cost observable rather than promised).

## Sequencing

Independent; single file. Coordinate trivially with #71.
