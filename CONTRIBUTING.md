# Contributing

The rules on this page are the ones a new contributor cannot infer from reading one file. How the repo is laid out (why `dist/` is the source, the entry point, transports, tool registration, how to add a tool) is in [docs/architecture.md](docs/architecture.md), and this page links there instead of repeating it. If a fact already lives in the README or under `docs/`, link it; the repo keeps one canonical copy of each fact ([docs/README.md](docs/README.md)).

## Start here

- `dist/*.js` is hand-edited plain JavaScript and is what ships. There is no build, no TypeScript, no lint or typecheck script. See [docs/architecture.md](docs/architecture.md#the-thing-that-surprises-everyone-dist-is-the-source).
- Adding a tool: follow [docs/architecture.md, "Adding a tool"](docs/architecture.md#adding-a-tool). Register through the normal path so the tool gets auth retry and error hints for free, add a test under `tests/`, and update the README tool counts.
- Anything that touches startup imports: read [docs/startup-performance.md](docs/startup-performance.md) first.

```bash
npm install
npm test
```

## Read before write

### What the guard is

`dist/readTracker.js` keeps a map of `fileId -> { readAt, modifiedTime, content, revisionId }`. Every read tool calls `trackRead`; every mutating tool calls `guardMutation` before its first side effect. `guardMutation` throws a caller-visible error when the file was never read in this scope, when a previous write marked it `requiresReread`, or when Drive's `modifiedTime` moved since the read (with a unified diff and rebase instructions when the entry holds a content snapshot and the tool passed a `contentFetcher`). The tracked `revisionId` becomes `WriteControl.requiredRevisionId` on the Docs batchUpdate, so Google itself refuses a write against a revision that moved.

After the write, settle the tracker:

- `trackMutation(fileId, newRevisionId)` after a body write, with the revision the API echoed back, so the next write in the same scope is re-armed rather than unguarded.
- `refreshRevision(fileId, revisionId)` after an operation that advances the Docs revision without touching the body. The Drive comment tools are the known case (`dist/tools/docs/comments/trackedRevision.js`); their `modifiedTime` does not move, so the external-change check passes and the next write would go out pinned to the pre-comment revision.
- `requireRereadBeforeMutation(fileId, reason)` after a write whose resulting revision cannot be learned (the Apps Script path in `dist/tools/docs/insertImage.js`). Clearing the revision would send the next write out unguarded; this blocks it until a fresh read.

### Which surfaces are guarded

- **Google Docs mutations** open a lease with `beginDocsMutation` in `dist/docsHandles.js` and pass their `guardMutation` call as `legacyGuard`. This is every body-writing Docs tool: `modifyText`, `batchModifyText`, `deleteRange`, `findAndReplace`, `appendText`, `appendMarkdown`, `replaceDocumentWithMarkdown`, `replaceRangeWithMarkdown`, `insertTable`, `insertTableWithData`, `insertPageBreak`, `insertImage`, `addTab`, `renameTab`, and `applyParagraphStyle`. `insertImage` takes its lease before the Drive upload, so a rejected call uploads nothing (`tests/insertImageGuardBeforeUpload.test.js`).
- **Sheets**: `writeSpreadsheet`, `batchWrite`, and `clearSpreadsheetRange` call `guardMutation` directly.
- **Drive**: `deleteFile` calls `guardMutation` with `skipExternalCheck`.

Sheets and Drive have no handle wiring, so over HTTP they fail closed with the message in `guardMutation`. A new mutating tool on any of these surfaces is guarded before its first side effect, and the guard is not optional for "small" writes.

### How read handles differ from the tracker

The tracker is in-process state with no owner. On the SDK v2 runtime it is scoped to the request context (a `WeakMap` in `dist/readTracker.js`), so an HTTP request's read dies with the request and can never authorize another request's write. The one exception is the no-context namespace, reached only by callers outside any transport: direct unit tests and startup code. That is why a unit test can call a tool's `execute()` directly, `trackRead` first, and see the legacy path.

A read handle is an explicit capability. A successful `readDocument` calls `mintDocsReadHandle`, which issues a record in the store from `dist/readHandles.js` bound to the principal fingerprint, configured profile, runtime epoch, file, tab, revision, and a structural fingerprint of the document (`computeStructuralFingerprint` in `dist/handleRuntime.js`). It expires in under 24 hours (`DEFAULT_HANDLE_TTL_MS`, `MAX_HANDLE_TTL_MS`), and a successful write consumes it and mints a successor bound to the new revision. `beginDocsMutation` decides which guard is in force: with no request context it runs `legacyGuard` and returns a lease over the tracker; with one, it validates the handle (HTTP must pass `readHandle`; a stdio connection may resolve its own connection-pinned last read) and the `WriteControl` value comes from the validated record, never from caller input. `expectedRevisionId` is an assertion that must agree with the record; it authorizes nothing.

The range-scoped layer on top of this (`lease.guardTargets`) is described in [docs/architecture.md, "Range precision"](docs/architecture.md#range-precision-issue-108). The client-facing contract is in [docs/http-mode.md](docs/http-mode.md#the-readhandle-contract-on-http).

When you add a Docs mutation:

1. Declare `readHandle: ReadHandleParameter` (from `dist/docsHandles.js`) in the schema.
2. Open the lease with `beginDocsMutation(documentId, { tabId, readHandle, expectedRevisionId, legacyGuard })` before any side effect.
3. Perform the write through `lease.write(perform, extractRevision)`, which hands `perform` the authorized `WriteControl` and settles the lease from the outcome (`complete` on success, `fail` on a thrown write).
4. Call `lease.abort()` when the tool decides not to write after taking the lease (a `dryRun`, a range that fails validation), and `lease.requireReread()` when the write's resulting revision cannot be observed. Leaving a lease unsettled leaves the handle `reserved` and the caller's corrected retry is rejected as an in-flight mutation.
5. Add the tool to `tests/mutatingDocsToolsWriteControl.test.js` or a sibling suite so it is proven to reject an unread document and to send the tracked revision as `WriteControl`.

## Seeding after create or copy

Any tool that creates or copies a file the guard covers must seed read state on success, so that create-then-write works without an intervening read. This was the #87 gap that PR [#135](https://github.com/karthikcsq/google-tools-mcp/pull/135) closed: `createDocument` and `createFromTemplate` seeded, `createSpreadsheet` and `copyFile` never had, and the most obvious workflow those Sheets tools have ("create a spreadsheet, write to it") was rejected with "has not been read in this session" for the entire life of the feature while every unit test passed. Nothing in the repo said seeding was a requirement. This section is that sentence.

The rule is **trustworthy or not at all**: seed exactly what a real read of that file would have recorded, and nothing when you cannot.

- **Docs** (`dist/tools/drive/createDocument.js`, `createFromTemplate.js`, and the Docs branch of `copyFile.js`): fetch the document back with `documents.get`, then `trackRead` with the rendered markdown and the fetched `revisionId`, and `mintDocsReadHandle` with the same content. Fetch rather than trusting your own inputs, so the seeded snapshot matches what `readDocument` would have returned, including any partial state a warned-but-continued content step left behind.
- **Sheets** (`createSpreadsheet.js`, the Sheets branch of `copyFile.js`): `trackRead(spreadsheetId)` with no content and no revision, which is exactly the metadata-only baseline `readSpreadsheet` records.
- **Binary and other Drive copies**: not seeded. `copyFile` has no content snapshot for a binary destination, and `deleteFile` is guarded, so claiming a read there would weaken that guard.
- **A partial result**: not seeded. `createFromTemplate` seeds only when every replacement applied; a failed replacement leaves the document unseeded and says so in the result.
- **A failed seed**: warn and leave the file unseeded. The file already exists, so the tool must not throw and hide it. The next mutation fails closed with "read it first", which is the correct outcome.

Why a false seed is worse than a rejection: a rejection is loud, and the caller's recovery is one `readDocument` or `readSpreadsheet` call. A seed that claims a read which never happened, or records content or a revision the file does not actually have, turns that loud rejection into a silent overwrite, or into a write pinned to a revision that is guaranteed to conflict. The whole guard exists to make the second thing impossible, and a convenience seed that lies defeats it for every caller.

Tests: `tests/createAndCopyReadSeeding.test.js` and `tests/createFlowsReadSeeding.test.js` pin the seeded and deliberately unseeded cases. A new creating or copying tool gets a case in one of them.

## Working copies

`readDocument` with `format='markdown'` writes what it read to a local file, and `replaceDocumentWithMarkdown` accepts that file back through `filePath`. The user-facing description is in the README under [Local Working Copies](README.md#local-working-copies). The contributor-facing facts:

**Two layers, one directory.** Everything lives under `getWorkspaceDir()` in `dist/workspace.js` (the OS temp dir, `google-tools-mcp-<user>`, or `GOOGLE_MCP_WORKSPACE_DIR` when set), created 0700 and lstat-checked on every write. Off the v2 runtime (unit tests, direct callers) the copy is the legacy shared mirror at `getWorkspacePath(documentId, tabId)`, one file per document and tab, written by `writeWorkspaceFile`. On the runtime, each handle owns a private editable copy under `<workspace>/v2-handles/handles/<workspaceId>/content.md`, copied from a content-addressed immutable baseline under `<workspace>/v2-handles/baselines/` that identical reads share (`createHandleWorkspace` in `dist/handleRuntime.js`). Copies are never linked or shared: handle A's edits must never appear in B's file.

**Which copy is canonical.** The Google document is. The working copy is a convenience for edit-then-push, and the handle's revision, not the file, is what authorizes a write. The bytes written are always the rich markdown (`docsJsonToMarkdown` with no `plainMarkdown`), never the plain variant, so a push from the file cannot silently drop colors and formatting.

**Rewrite.** `replaceDocumentWithMarkdown` mirrors an inline push into the legacy shared copy only after the Docs write succeeded, so the mirror always holds the last content that actually landed. A failure after the delete writes the markdown being pushed to a separate `<base>.recovery-<stamp>.md` file, never over the mirror. On the v2 runtime the handle that authorized the write is consumed, and the successor handle's workspace starts empty on purpose: the post-write revision is known, the post-write content is not, and seeding it with pre-write content would hand the caller a copy that reverts their own edit. Re-read to refill it.

**Staleness.** Document staleness is the guard's job (revision and handle validation above). Local staleness is `backupIfLocallyModified` in `dist/workspace.js`: before any overwrite of an editable file, if its content is not what this process last wrote there (or there is no record, because this is the first write or the process restarted), the current bytes are copied to `<path>.bak` and the read reports it (issue #122). The overwrite still proceeds; recovery is from the `.bak`. `writeLocalFile=false` on `readDocument` skips the mirror write for a staleness check that must not touch it.

**Cleanup and retention.** `cleanupHandleWorkspaces` runs on every mint and at shutdown, never on a timer, and removes only the exact paths recorded in each workspace's ownership manifest, never a glob. A workspace whose editable file diverged from its baseline hash is dirty: it is retained, reported in the shutdown log, and never deleted. A baseline is removed when its last referencing workspace is gone. The store side (`dist/readHandles.js`) keeps a failed write's dirty workspace for recovery instead of reclaiming it. Nothing in `dist/workspace.js` removes legacy mirrors or `.bak` files.

## The error boundary

`dist/errors.js` is the boundary between what a caller sees and what stays on the server.

- `publicError(message)` (and its alias `UserError`) marks a message as safe for an MCP caller. The message is frozen at construction.
- `wrapOperationError(operation, cause, { code, status })` is for everything else. The caller sees `The <operation> operation failed.`; the cause is kept privately in a `WeakMap` for server-side logging.
- `getApiErrorDetail(error)` returns the structured `error.response.data.error.message` a googleapis client attaches to a rejected request. That validated field is the only part of a caught API error that may cross the boundary. A `null` result means fall through to `wrapOperationError`, not to `error.message`.
- `redactDiagnostic(value)` produces the bounded, secret-redacted shape used for logs and persisted diagnostics.

The rule: **caught error text never reaches a caller-visible error or a persisted diagnostic.** Do not interpolate `error.message` into `publicError`, `UserError`, a `warnings` field, or anything written to disk. The redactor removes registered secrets and labeled credential patterns; it cannot recognize a filesystem path, a resolved host, or a project number as sensitive, so the only way those stay server-side is never to put them in a public string in the first place.

The shape every catch block in `dist/tools/` follows (`dist/tools/drive/copyFile.js` is a clean example): rethrow when `isPublicError(error)`, `log.error` the caught text server-side, map known status codes to fixed sentences, and `wrapOperationError` for the rest. `tests/publicErrorBoundary.test.js` pins the rule with a path-shaped diagnostic; a new catch block that maps errors gets a case there.

## Running the tests

```bash
npm test              # node --experimental-vm-modules node_modules/jest/bin/jest.js
npm run test:ci       # same, with --ci --coverage
```

`--experimental-vm-modules` is required; a bare `npx jest` fails on `import` syntax. Config is `jest.config.js` (`testTimeout` is 30s because four suites dynamically import all 12 tool categories).

**Read the `Test Suites:` line, not `Tests:`.** A suite that fails to link, most often `SyntaxError: The requested module './x.js' does not provide an export named 'y'` after a `jest.unstable_mockModule` factory stopped exporting a name the module under test now imports, counts as a failed suite while registering zero failed tests. `Tests:` alone can read fully green for a broken run. Both lines go in a PR description, verbatim. A fully green run looks like:

```
Test Suites: 96 passed, 96 total
Tests:       2 skipped, 1419 passed, 1421 total
```

Mocking pattern: `jest.unstable_mockModule('../dist/x.js', factory)` before the `await import()` of the module under test, and the factory must export every name the real module's importers use.

**Inventory snapshot.** `tests/mcpMigrationInventory.test.js` compares the tracked `dist/` and `tests/` files and their imports against `tests/fixtures/mcp-migration-inventory.json`. Any new `dist/` module or test file, and any changed import, fails it until you regenerate:

```bash
node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json
```

Commit the regenerated fixture with the change that caused it.

## Changelog and version

Every merged pull request adds its own entry at the top of `CHANGELOG.md` with its own semantic version (bump rules are at the top of that file) and moves `package.json` to that version in the same PR:

```powershell
npm.cmd --no-git-tag-version version X.Y.Z
```

The version at the top of the changelog, the version in `package.json`, and the next tag are always the same number. Not every version is tagged. The full flow, including what the publish workflow checks, is in [RELEASING.md, "Release a version"](RELEASING.md#release-a-version).

## Live testing

Unit tests mock Google. Two harnesses run the real tools against a real account: [docs/live-smoke.md](docs/live-smoke.md) (`npm run live-call` for one tool from your worktree's `dist/`, `npm run live-smoke` for the scenario clusters, and the rule that a PR touching a cluster carries a passing run in its description) and [docs/live-agent-loop.md](docs/live-agent-loop.md) (`npm run live-mission`, a multi-step task in one process, which is what proves create-then-write). The safety boundary is enforced in `scripts/live-smoke/guard.mjs`, in code: every write stays inside the configured `GOOGLE_MCP_TEST_FOLDER_ID` sandbox folder, Gmail is never sent (the send paths are denied at two layers), nothing the run did not create is deleted, and the workspace directory is a run-scoped sandbox. Never disable, weaken, or route around a check in that file; a scenario that needs a new mutating method gets a new rule with its own containment check.
