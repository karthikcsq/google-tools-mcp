# listFolderContents silently truncates at depth 1 (issue #126, reframed)

Work only in the worktree `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE`,
branch `feat/independents`. Commit as you go. Do not push. Do not post to GitHub.
Do not touch any other worktree.

## What is actually wrong

Issue #126 was filed as "listFolderContents returns empty for every second-level subfolder".
I investigated against the real Drive API and **that claim is not reproducible**. The folders in
question are genuinely empty. Do not try to fix that. Evidence, for your context:

- Depth-1 listing, the batched depth-2 traversal, and a completely separate third-party Drive
  client all independently report those folders as empty.
- A control run of `listFolderContents(depth: 2)` on a different tree correctly returned
  15 second-level folders with correct paths, so recursion works.
- `dist/tools/drive/listFolderContents.js` already passes `supportsAllDrives: true` and
  `includeItemsFromAllDrives: true` on the depth-1 call, and already scopes recursive calls to
  `driveId` for shared drives. That part is well built. Leave it alone.

The investigation did surface a real defect, which is what you are fixing.

**The depth-1 path silently truncates.** It passes `pageSize: maxResults` (default 50, max 100),
takes one page, never looks at `nextPageToken`, and returns a bare `{folders, files}`. The caller
cannot tell a complete listing from a truncated one.

Proven against real Drive, on a folder containing 59 subfolders and hundreds of files:

```
listFolderContents(folderId, maxResults: 5, includeSubfolders: false)
  -> {"folders": [], "files": [ ...exactly 5 items... ]}
```

Nothing in that response says "there is more". An agent walking a large tree sees a fraction and
believes it saw everything. This is the reporter's actual stated harm: no way to distinguish a
complete answer from an incomplete one.

The depth>1 response already solves this. It returns `truncated`, `truncationReason`, `unreadable`
and `apiCalls`. Depth 1 returns none of it. That inconsistency is the bug.

## What to do

In `dist/tools/drive/listFolderContents.js`, in the `if (depth === 1)` branch:

1. Capture `nextPageToken` from the `files.list` response.
2. Add a `truncated` boolean to the depth-1 result. Set it true when Drive reports more pages.
3. When truncated, add a `truncationReason` string in the same spirit as the depth>1 path, naming
   the cap that was hit and what the caller can do (raise `maxResults`, up to its maximum of 100,
   or use `depth` with `maxItems`). Keep the wording concrete.
4. Do **not** start auto-paginating depth 1. The legacy contract is one page, and quota pacing
   matters. Report the truncation, do not silently fix it by fetching more.
5. Keep `folders` and `files` exactly as they are, same field names, same order. Existing callers
   must not break. `truncated` is additive.
6. Update the tool's `.describe()` text so the depth-1 description states that the result is a
   single page capped by `maxResults` and that `truncated` reports when it was cut off. The current
   description says the depth-1 response is "the legacy `{folders, files}` result", which will be
   wrong once you add the field.

## Tests

In the existing Drive test file for this tool, add cases that fail before your change and pass
after. Say so explicitly in your report, with the before/after output:

- Drive returns a `nextPageToken`: result has `truncated: true` and a non-empty `truncationReason`.
- Drive returns no `nextPageToken`: result has `truncated: false` and no `truncationReason`.
- A genuinely empty folder: `folders: []`, `files: []`, `truncated: false`. This is the case that
  distinguishes "empty" from "cut off", so assert it directly.
- The existing depth-1 shape assertions still pass unchanged apart from the added field.

## Standing constraints

- `dist/*.js` is hand-written runtime source. No `src/`, no TypeScript, no build step.
- Tests are Jest ESM: `npm test`. Bare `npx jest` FAILS. **Read the `Test Suites:` line**, not just
  `Tests:` — a suite that fails to *load* reports zero failed tests and looks green.
- The registered tool count is **160**. Do not add or remove a tool.
- After changing tracked `dist/` or `tests/` files, regenerate the snapshot **after staging**:
  `node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json > /dev/null`
  (redirect stdout, it is extremely verbose).
- Never interpolate a caught error's message into `publicError()`; use `wrapOperationError()` or
  `getApiErrorDetail()` from `dist/errors.js`.
- Stdout purity is absolute on stdio transport.
- Do not run the live smoke harness. It is not on this branch and I will run it myself.

## Report

FIXED `<sha>` with the exact before/after of the three test cases, the changed `.describe()` text,
and the `Test Suites:` line. If you think the truncation signal belongs in a different shape than
what I described, say so with your reasoning rather than silently doing something else.
