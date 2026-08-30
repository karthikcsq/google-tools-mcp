# Finish the in-progress feat/independents merge on the integration branch

Work only in the worktree `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-int`,
branch `verify/live-smoke-on-fixes`. A merge of `origin/feat/independents` is IN PROGRESS with
seven conflicted files. Finish it, then merge `origin/feat/live-smoke` on top. Do not push.
Do not touch any other worktree. Do not post to GitHub.

This branch is a **rehearsal**. It proves the five PR branches combine before they are merged one
by one on GitHub. The same conflicts will appear there, so resolve them the way they should be
resolved for real, not with whatever makes the tests pass fastest.

## The governing rule

Almost every one of these is two independent, both-wanted changes to the same region.
**Keep BOTH sides.** Taking either side alone silently drops a fix that has already been reviewed,
tested and reported as done on its PR. If you find yourself deleting a whole block from one side,
stop and re-read it: you are almost certainly dropping someone's fix. The two exceptions are called
out below.

## The seven files

### 1. `dist/tools/docs/modifyText.js`

- **HEAD (docs cluster)** has the issue #14 default-text-color lookup and the #121 inherited-style
  probe, and normalizes escapes inline with
  `args.text?.replace(/\\n/g,'\n').replace(/\\t/g,'\t')`.
- **origin/feat/independents** replaced exactly that inline normalization with a call to an
  extracted helper, `normalizeEscapes(args.text)`.

Resolution: use `normalizeEscapes(args.text)` for the assignment, and keep the entire #14 and #121
blocks that follow. Confirm `normalizeEscapes` is actually imported in the merged file and that the
helper exists.

### 2. `dist/tools/drive/createDocument.js`

Read both sides fully before typing.

- **Imports.** HEAD imports `docsJsonToMarkdown`, `getDefaultTextColor`,
  `buildDefaultColorStyleRequest`, `trackRead` and `mintDocsReadHandle` (the #87 read-seeding work).
  The other side imports `getBatchUpdateProgress` (PR #113 review finding 3). Both sets are used.
  **Keep the union of all imports.**
- **The catch block.** HEAD degrades a failed initial-content insert to a named warning so the
  already-created Drive file is never left unreported. The other side adds
  `getBatchUpdateProgress(contentError)` so a partially-applied insert says so instead of claiming
  nothing was added. These are complementary. Merge into one block that logs HEAD's
  document-id-bearing warning AND branches on `getBatchUpdateProgress` for the message. Keep the
  caught API error server-side only; it must not reach the caller's warning text. Preserve both
  sides' comments.
- **The result fields.** HEAD emits `readHandleNote` when a read handle was minted (#87). The other
  side replaces the generic `warningNote` with `contentWarningNote ?? <the generic text>`. Keep
  both: the `contentWarningNote ?? ...` form for `warningNote`, and the `readHandleNote` block.

### 3. `scripts/inventory-mcp-migration.mjs` — **exception, pick a side**

Both sides solve the same problem (a snapshot regenerated before staging must still see new files).
Take **HEAD's** version for every conflict here: it uses
`git ls-files --cached --others --exclude-standard`, which honours global and repo-local excludes,
where the other side's `--exclude-from=.gitignore` only honours the repo's own file. HEAD's comment
and description strings go with it. If the other side's block contains logic HEAD's does not (for
example filtering deleted index entries), port that logic onto HEAD's flag choice rather than
losing it.

### 4. `tests/modifyText.test.js`

Two independently written `describe` blocks. Keep both, one after the other.

### 5. `tests/packageContents.test.js`

Two independently written package-tarball guards (the #74 dead-Gmail-fork guard and the #56 guard).
The file's own header comment says future guards belong in this file rather than a second one.
Merge into a single file with one import block, one `beforeAll` that runs `npm pack --dry-run
--json` **once**, and both `it(...)` cases.

**Critical:** one side carries an explicit `120_000` timeout as the third argument to `it(...)`,
with a comment explaining that `npm pack` uses a fresh cache and exceeds Jest's 5s default under
load. **That timeout must survive on every case in the merged file.** I measured this: without it
the suite fails roughly one run in three. Losing it silently reintroduces a flaky gate.

### 6. `tests/mcpMigrationInventory.test.js`

Same situation, smaller. One side adds a `120_000` timeout and an explanatory comment to the
`it(...)`. Keep the timeout and the comment along with whatever the other side changed.

### 7. `tests/fixtures/mcp-migration-inventory.json` — **exception, never hand-resolve**

Once all six files above are resolved and staged, regenerate it over the merged tree:

```
git checkout --theirs tests/fixtures/mcp-migration-inventory.json
git add tests/fixtures/mcp-migration-inventory.json
node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json > /dev/null
git add tests/fixtures/mcp-migration-inventory.json
```

Redirect that script's stdout; it prints hundreds of lines. Regenerate **after** staging the
others, because it only inventories files git knows about.

## Then

Commit the merge with `git commit --no-edit`, then run `git merge --no-edit
origin/feat/live-smoke`. If that conflicts only on the inventory snapshot, resolve it with the same
regenerate recipe above and commit.

## Gates

- No conflict markers: `grep -rn '<<<<<<<\|>>>>>>>' dist tests scripts live` finds nothing.
- `npm test` fully green. Read the **`Test Suites:`** line, not just `Tests:` — a suite that fails
  to *load* reports zero failed tests and looks green. Expect roughly 93 suites; the exact number
  will differ from any figure you have seen before because branches have moved. **Do not treat any
  test count as a target, and never consolidate or delete tests to reach a number.**
- The merged tool count is **160**, with **232** for the aliases-enabled case.
  `tests/toolRegistration.test.js` was already resolved in an earlier commit on this branch to
  assert those while keeping the ops branch's logger-spy and feedback-default assertions. Do not
  change it.
- Run `npm test` **twice** and report both `Test Suites:` lines, because of the flakiness noted above.

## Report

For each of the seven files, one line: what each side contributed and what the merged result keeps.
Then both `Test Suites:` lines. Call out anything where you made a judgment call beyond "keep both",
and anything you suspect is wrong but left alone.
