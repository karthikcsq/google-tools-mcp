# Make depth-1 listFolderContents scope to a shared drive the way the recursive path does

Work only in the worktree `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE`,
branch `feat/independents`, on top of `4e9b3ba`. Commit as you go. Do not push. Do not post to
GitHub. Do not touch any other worktree.

## The inconsistency

`dist/tools/drive/listFolderContents.js` has two paths.

The **recursive** path (depth > 1) does a `files.get` for the start folder, reads its `driveId`,
and scopes every subsequent `files.list` to that drive. It carries this comment, which is the
reasoning you should take seriously:

> For a shared-drive root, scope every recursive files.list call to that drive. Without this,
> files.list defaults to corpora='user' (files the caller has personally accessed) even with
> includeItemsFromAllDrives:true, so descendants the caller has access to via the shared drive but
> never individually opened are silently omitted from a traversal that reports truncated: false.

The **depth-1** path passes `supportsAllDrives: true` and `includeItemsFromAllDrives: true` but
never sets `corpora` or `driveId`. So by the recursive path's own documented reasoning, a depth-1
listing of a folder inside a shared drive can silently omit children.

## What this is and is not

To be clear about scope, because a previous investigation got this wrong in both directions:

- This is **not** the cause of the symptom reported in #126. I verified empirically that depth-1
  already returns content owned by another user and shared with the caller: listing the reporter's
  parent folder returned 59 subfolders and many files owned by a different account. The folders in
  that report are genuinely empty.
- It **is** a real inconsistency for true shared drives (`driveId` set), where the recursive path
  protects itself and the depth-1 path does not.

So this is a robustness fix, not a bug reproduction. Do not try to reproduce a failure first; you
would need a shared drive to do it, and there is not one available here.

## The cost tradeoff, which you must address explicitly

The obvious implementation copies the recursive path: `files.get` the folder to read `driveId`,
then pass `corpora: 'drive'` and `driveId` when it is set. That adds a second API round trip to
**every** depth-1 call, and depth-1 is the common, cheap, high-frequency path. That is a real
regression in cost for the overwhelmingly common My Drive case, which has no `driveId` at all.

Options, and I want your judgment rather than a default:

1. Unconditional extra `files.get`. Correct, simple, costs every caller a round trip.
2. Ask for `driveId` on the listing itself and retry scoped only if the first attempt looks
   shared-drive shaped. Cheap in the common case, more moving parts.
3. `corpora: 'allDrives'` without needing `driveId` at all. One call, but Google documents
   `allDrives` as less efficient and asks callers to prefer a narrower corpora.

Pick one, implement it, and in your report state plainly which you chose, what it costs the common
My Drive case, and why you rejected the other two. If you conclude the extra round trip is not
worth it and the right answer is to leave depth-1 alone and document the limitation instead, that
is an acceptable outcome. Say so and write the documentation. Do not silently pick the easiest one.

Whatever you choose must not regress the existing behaviour I verified: a depth-1 listing of a
**My Drive** folder owned by someone else and shared with the caller must keep returning that
folder's children.

## Tests

Every behavioural change needs a test that fails before it and passes after it. At minimum, with a
mocked Drive client, assert on the exact parameters passed to `files.list`:

- A folder with a `driveId`: the listing is scoped to that drive.
- A folder without a `driveId` (plain My Drive): no `corpora`/`driveId` scoping is added, and the
  call count does not increase beyond what your chosen option requires.
- The existing `truncated` / `truncationReason` behaviour from `b1b23a2` still holds.

## Standing constraints

- `dist/*.js` is hand-written runtime source. No `src/`, no TypeScript, no build step.
- Tests are Jest ESM: `npm test`. Bare `npx jest` FAILS. **Read the `Test Suites:` line**, not just
  `Tests:` — a suite that fails to *load* reports zero failed tests and looks green.
- The registered tool count is **160**. Do not add or remove a tool.
- Do not state a target test count as a goal. Add whatever tests the change needs; never
  consolidate or delete existing tests to hit a number.
- After changing tracked `dist/` or `tests/` files, regenerate the snapshot **after staging**:
  `node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json > /dev/null`
- Never interpolate a caught error's message into `publicError()`.
- Write scratch files inside the worktree and delete them, never to a `/tmp` path.

## Report

FIXED `<sha>` or DOCUMENTED-INSTEAD, which of the three options you chose and why you rejected the
others, the cost to the common My Drive path in extra API calls, the before/after of your tests,
and the `Test Suites:` line.
