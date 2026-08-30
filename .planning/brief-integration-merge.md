# Resolve the feat/independents merge conflicts on the integration branch

Work only in the worktree `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-int`,
branch `feat/v3-integration`. A merge of `origin/feat/independents` is IN PROGRESS with six
conflicted files. Finish that merge. Do not push. Do not touch any other branch or worktree.

This branch is a rehearsal: it proves the five PR branches combine before they are merged
one by one on GitHub. The same conflicts will appear there, so resolve them the way they
should be resolved for real, not with whatever makes the tests pass fastest.

## The governing rule

Every one of these conflicts is two independent, both-wanted changes to the same region.
**Keep BOTH sides.** Taking either side alone silently drops a fix that has already been
reviewed, tested and reported as done on its PR. If you ever find yourself deleting a whole
block from one side, stop and re-read it: you are almost certainly dropping someone's fix.

## The six files, and what each side is

### 1. `dist/tools/docs/modifyText.js` (1 conflict)

- **HEAD (docs cluster)** has the issue #14 default-text-color lookup and the issue #121
  inherited-style probe, and normalizes escapes inline with
  `args.text?.replace(/\\n/g,'\n').replace(/\\t/g,'\t')`.
- **origin/feat/independents** replaced exactly that inline normalization with a call to an
  extracted helper, `normalizeEscapes(args.text)`.

Resolution: use `normalizeEscapes(args.text)` for the assignment, and keep the entire #14
and #121 blocks that follow. Confirm `normalizeEscapes` is actually imported in the merged
file and that the helper exists; if the import line was also part of a conflict elsewhere in
the file, make sure it survived.

### 2. `dist/tools/drive/createDocument.js` (3 conflicts)

This is the important one. Read both sides fully before typing.

- **Conflict A, the imports.** HEAD imports `docsJsonToMarkdown`, `getDefaultTextColor`,
  `buildDefaultColorStyleRequest`, `trackRead` and `mintDocsReadHandle` (the #87 read-seeding
  work). The other side imports `getBatchUpdateProgress` (the PR #113 review finding 3 work).
  Both sets are used. Keep the union of all imports from both sides.
- **Conflict B, the catch block.** HEAD degrades a failed initial-content insert to a named
  warning so the already-created Drive file is never left unreported. The other side adds
  `getBatchUpdateProgress(contentError)` so a partially-applied insert says so instead of
  claiming nothing was added. These are complementary: one is about not losing the document,
  the other is about describing accurately what landed. Merge them into one block that logs
  HEAD's document-id-bearing warning AND branches on `getBatchUpdateProgress` for the
  message. Keep the caught API error server-side only — it must not reach the caller's
  warning text. Preserve both sides' comments; they explain non-obvious reasoning.
- **Conflict C, the result fields.** HEAD emits `readHandleNote` when a read handle was
  minted (#87). The other side replaces the generic `warningNote` with
  `contentWarningNote ?? <the generic text>`. Keep both: the
  `contentWarningNote ?? ...` form for `warningNote`, and the `readHandleNote` block.

### 3. `scripts/inventory-mcp-migration.mjs` (3 conflicts)

Both sides are solving the same problem (a snapshot regenerated before staging must still
see new files) and reached nearly the same place, so this is the one file where you pick a
side rather than combining.

Take **HEAD's** version for all three conflicts: it uses
`git ls-files --cached --others --exclude-standard`, which honours global and repo-local
excludes, where the other side's `--exclude-from=.gitignore` only honours the repo's own
file. HEAD's comment and the two description strings go with it. If the other side's block
contains any logic that HEAD's does not (for example filtering deleted index entries), port
that logic onto HEAD's flag choice rather than losing it.

### 4. `tests/modifyText.test.js` (1 conflict)

Two independently written `describe` blocks. Keep both, one after the other.

### 5. `tests/packageContents.test.js` (1 conflict)

Two independently written package-tarball guards (the issue #74 dead-Gmail-fork guard and
the issue #56 guard). The file's own header comment says future guards belong in this file
rather than a second one. Merge them into a single file with one import block, one
`beforeAll` that runs `npm pack --dry-run --json` once, and both `it(...)` cases.

### 6. `tests/fixtures/mcp-migration-inventory.json`

Never resolve this by hand and never take a side. Once all five files above are resolved and
staged, regenerate it over the merged tree:

```
git checkout --theirs tests/fixtures/mcp-migration-inventory.json
git add tests/fixtures/mcp-migration-inventory.json
node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json > /dev/null
git add tests/fixtures/mcp-migration-inventory.json
```

Redirect that script's stdout; it prints hundreds of lines. Regenerate it **after** staging
the other files, because it only inventories files git knows about.

## Gates

- No conflict markers anywhere: `grep -rn '<<<<<<<\|>>>>>>>\|=======' dist tests scripts`
  should find nothing (allow for legitimate `=======` inside markdown docs if any turn up).
- `npm test` fully green. Read the **`Test Suites:`** line, not just `Tests:`; a suite that
  fails to load reports zero failed tests and looks green.
- The merged tool count is **160**. `tests/toolRegistration.test.js` was already resolved in
  an earlier commit on this branch to assert 160 while keeping the ops branch's startup-timing
  and feedback-default assertions. Do not change it.
- Commit the merge with `git commit --no-edit` once everything is staged and green.

## Report

For each of the six files, one line: what each side contributed and what the merged result
keeps. Then the `Test Suites:` line. Call out anything where you had to make a judgment call
beyond "keep both", and anything you suspect is wrong but left alone.
