# PR #113 (independents) — close out review findings plus issues #115 and #124

You are working on branch `feat/independents` in this worktree. This PR added recursive
Drive folder listing with depth/maxItems bounds (`dist/tools/drive/listFolderContents.js`),
closed test and packaging blind spots, and touched `createDocument`.

Four adversarial-review findings landed AFTER the last commit (5e91562) and none have been
addressed. Two new issues belong on this branch as well.

Note on finding 2: commit 5e91562 was specifically about returning already-fetched pages
when the API budget runs out. Check carefully whether it already covers what the finding
describes, or whether the finding is about a genuinely different thing (stopping pagination
early once maxItems is already satisfiable, rather than what happens at budget exhaustion).
Report ALREADY-CORRECT with evidence if it is covered.

## Standing constraints (apply to every task below)

- You are working in the worktree you were launched in (`-C`). Stay in it. Do NOT `git
  checkout`, `git switch`, `git rebase`, `git merge`, `git push`, or touch any other branch.
- **Commit your work** in logical commits with real messages. Do not push.
- **`dist/*.js` is hand-written runtime source.** There is no `src/`, no TypeScript, and no
  build step. Edit `dist/` directly.
- **Tests are Jest ESM.** Run `npm test` or `npm test -- <path>`. Bare `npx jest` FAILS.
  Read the **`Test Suites:`** line, not just `Tests:` — a suite that fails to *load* reports
  zero failed tests, so a broken suite otherwise looks green.
- The registered tool count is **160**, pinned in `tests/toolRegistration.test.js`,
  `tests/mcpSdkV2Compatibility.test.js`, `tests/mcpServerFacade.test.js`,
  `tests/entrypointSmoke.test.js`. If you add a tool you must update all of them.
- After changing any tracked file under `dist/` or `tests/`, regenerate the inventory:
  `node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json`
  Line shifts alone fail `tests/mcpMigrationInventory.test.js`.
- **Stdout purity is absolute** on stdio transport: only protocol messages may reach stdout.
  A stray `console.log` corrupts the protocol. Use the logger, which writes to stderr.
- **Error-boundary rule:** never interpolate a caught error's message into `publicError()`.
  Use `wrapOperationError()` or a validated field via `getApiErrorDetail()` from
  `dist/errors.js`. Caller-supplied text must never reach persisted diagnostics.
- Do not use `gh` to post anything. Do not `npm install`.
  Everything you need is inlined in this brief or already in the worktree.
- Do not make unrelated changes, do not reformat untouched code, do not bump versions.
- Add or extend tests for every behavioural fix. A fix without a test that fails before it
  and passes after it is not done.

## How to report

For EVERY numbered finding, end your run with one line of the form:

    FINDING <n>: FIXED <commit-sha> — <one sentence on what changed>
    FINDING <n>: ALREADY-CORRECT — <the code and reasoning that disprove it>
    FINDING <n>: INVALID — <why the report is wrong>

Verify each finding against the actual code BEFORE fixing it. Some reports are wrong or
already fixed; saying so with evidence is a correct outcome and is more useful than a
defensive change. Never silently skip one.

---

# Findings 1-4 — unaddressed adversarial review


## Finding 1 (posted 2026-08-22T03:40:46Z)

**Adversarial Review — issue**

Recursive folder isolation treats every Drive `403` as proof that one of the queried folders is unreadable, but Drive also uses `403` for quota/rate-limit failures. A transient service-wide throttle can therefore be returned as a successful-looking tree with fake permission failures.

Concrete failure scenario:
1. A recursive walk reaches one subfolder and calls `files.list` for that parent.
2. Drive returns `403 User rate limit exceeded` / `userRateLimitExceeded` because the caller is temporarily over quota. Google explicitly documents this as a 403 and recommends exponential backoff: https://developers.google.com/workspace/drive/api/guides/limits
3. `listWithIsolation()` checks only `error.code === 403`, so with one parent it records that folder in `unreadable` as `Permission denied or folder unavailable.` and returns `{ files: [], budgetExhausted: false }`.
4. The outer traversal can then finish with `truncated: false`, falsely telling the caller the tree is complete and that the folder itself is inaccessible. With a multi-parent chunk, the same status triggers recursive bisection, spending more Drive calls precisely while the service is asking the client to back off.

The initial `files.get` has the same status-only issue: any 403 is converted to `Permission denied` even when the structured Drive error says quota/rate limit.

Smallest fix / acceptance criteria: classify the structured Drive error reason, not just the HTTP status. Only isolate/mark a parent when the failure is actually an access/not-found condition attributable to that folder; propagate or retry quota/rate-limit 403s according to Drive guidance. Add a regression test where `files.list` returns a 403 with reason `userRateLimitExceeded` and verify no `unreadable` entry is fabricated and no binary isolation retries are issued.


## Finding 2 (posted 2026-08-22T03:40:55Z)

**Adversarial Review — issue**

`maxItems` caps only the returned array; it does not stop recursive Drive pagination when that cap has already been satisfiable. A request for one item can still consume the entire 50-call API budget before the code notices `maxItems: 1`.

Concrete failure scenario:
1. Call `listFolderContents({ folderId, depth: 'all', maxItems: 1 })` on a folder with thousands of direct children.
2. After the initial `files.get`, `listParentChunk()` paginates the entire parent query in 100-item pages before any result is passed to `addEntry()`.
3. With more than 4,900 children, it makes the remaining 49 `files.list` calls, buffers roughly 4,900 entries, and only then returns because the API-call budget is exhausted.
4. The processing loop adds the first item, sees the second item exceed `maxItems`, and reports `truncationReason: maxItems (1) ...`. The caller asked for one item, but the server already spent its full traversal budget. It also hides that the API budget was exhausted because `truncated` was already set by the later maxItems check.

This contradicts the PR's stated behavior that traversal "stops at whichever limit comes first" and makes the advertised hard cap ineffective at bounding Drive work. It is materially expensive now that Google documents `files.list` as 100 quota units per request: https://developers.google.com/workspace/drive/api/guides/limits

Smallest fix / acceptance criteria: process recursive list results page-by-page (or otherwise feed remaining capacity into pagination) and stop requesting additional pages once `maxItems` has been satisfied, while still handling duplicates/filtering correctly. Add a regression test with `maxItems: 1` and a paginated root response; it should not fetch later pages after the first eligible unique entry is accepted.


## Finding 3 (posted 2026-08-22T03:41:43Z)

**Adversarial Review — issue**

The new `createDocument` partial-result warning assumes initial-content insertion is all-or-nothing, but the markdown path is explicitly multi-batch and can leave content already applied before a later batch fails.

Concrete failure scenario:
1. Create a document with enough markdown to generate more than 50 insert/format requests.
2. `insertMarkdown()` calls `executeBatchUpdateWithSplitting()`, which sends delete/insert/format requests in separate `documents.batchUpdate` calls and splits each phase into batches of 50.
3. The first insert batch succeeds and changes the new document; a later insert or format batch then fails (quota/transient/API error is enough).
4. `insertMarkdown()` throws. `createDocument` catches that and returns:
   - `warnings: ['Document created but initial content failed.']`
   - `warningNote: 'The document was created, but its initial content could not be added.'`

That response tells the caller the content was not added even though some—or, if only formatting failed, all—of the text may already be present. A caller following the warning and re-applying the initial content can therefore duplicate what already landed, and there is no signal that the returned document needs inspection first.

The non-atomic behavior is visible in `executeBatchUpdateWithSplitting()`: every successful batch is committed before the next batch is attempted; there is no rollback across calls.

Smallest fix / acceptance criteria: make the failure result explicit about possible partial application (or carry progress metadata out of the splitting helper so the response can state what phases/batches succeeded). Add a regression test where one batch succeeds and a later batch throws; the returned create result must not claim that initial content simply “could not be added,” and should tell the caller to inspect/reconcile the created document before retrying.


## Finding 4 (posted 2026-08-22T16:00:01Z)

**Adversarial Review — issue** Recursive traversal can silently omit shared-drive descendants because every `files.list` call leaves `corpora` at its default `user` scope. Google documents that `includeItemsFromAllDrives: true` + `corpora=user` searches files the user has accessed, while `corpora=drive` + `driveId` is the mode that searches all items in a specific shared drive: https://developers.google.com/workspace/drive/api/guides/enable-shareddrives#search_for_content_on_a_shared_drive

Failure scenario: a caller has access to a shared-drive folder but has not individually accessed every descendant. `listFolderContents({ depth: 2|'all' })` can return `truncated: false` while omitting those descendants, so the new recursive response presents an incomplete tree as complete. This directly breaks the PR's shared-drive/truncation guarantees.

Smallest fix/acceptance criteria: fetch the start folder's `driveId` (for example alongside `id,name`), and for recursive calls inside a shared drive send `corpora: 'drive'` plus that `driveId` on every `files.list`. Add a test asserting those parameters are propagated for a shared-drive root. Keep the legacy depth-1 request unchanged if byte compatibility is intentional.

---

# Findings 5 and 6 — new issues

**Finding 5 is issue #115** (`dist/auth.js`, around line 245). Two defects, fix both:
(a) the authorization URL does not request re-consent, so a returning user who already
granted this client can complete the exchange without Google returning a refresh token;
(b) more importantly, when no refresh token comes back the code logs a warning, skips
`saveCredentials()`, and then still reports `Authentication successful!`. A re-auth that
did not persist offline access must NOT report success. Make the failure loud and
actionable. The `invalid_grant` recovery path is the sharpest case: it deletes the old
token then calls this same path, so it can destroy a credential without replacing it.

**Finding 6 is issue #124** (`dist/tools/drive/copyFile.js`). Note the schema parameter is
currently named `newName`, and the reporter called it `name` — so the argument was dropped
by schema validation rather than by the copy call. Accept `name` as well (the Drive API
field is `name`, so that is the natural spelling), keep `newName` working for compatibility,
and make the tool reject an unknown parameter rather than silently ignoring it if that is
achievable without breaking other tools. Verify what the schema actually does with unknown
keys before claiming a fix.

## Issue #115: Re-auth can finish without replacing the refresh token

## Summary

The interactive OAuth re-authentication flow requests `access_type: 'offline'` but does not request re-consent. Google documents that a refresh token is returned on the **first** authorization; when a new refresh token is needed after a prior grant, `prompt=consent` is the mechanism for prompting re-authorization.

This can make the server report a successful re-authentication while failing to persist any usable replacement refresh token.

## Concrete failure mode

1. The user has previously authorized this OAuth client, so Google already has a consent grant for the client/user pair.
2. The local `token.json` is deleted, becomes scope-stale, or the saved refresh token reaches the `invalid_grant` recovery path.
3. `authenticate()` generates a new authorization URL with only:

```js
{
  access_type: 'offline',
  scope: SCOPES.join(' '),
}
```

4. Because this is not the first authorization and the flow does not force re-consent, Google can exchange the code without returning `tokens.refresh_token`.
5. The implementation logs `Did not receive refresh token. Token might expire.`, skips `saveCredentials()`, then still logs `Authentication successful!` and returns the access-token-only client.
6. The current process works until that access token expires, but no replacement `token.json` was saved. The next process/tool authorization therefore starts the browser flow again instead of recovering persistent offline access.

The `invalid_grant` branch is especially direct: it deletes the old token and immediately calls this same `authenticate()` path, so a recovery intended to replace a revoked refresh token can complete without persisting its replacement.

## Evidence

Current implementation (also present before PR #112):
https://github.com/karthikcsq/google-tools-mcp/blob/220f97fb744289d5cc68943da28f6c2d88baa817/dist/auth.js

The same authorization URL behavior is present at PR #112's base, confirming this exists independently of the PR:
https://github.com/karthikcsq/google-tools-mcp/blob/45fc243e80a8555c9e5e828289ca60a9dab840e3/dist/auth.js

Google's current OAuth documentation says `access_type=offline` causes a refresh token to be returned the first time the code is exchanged, and documents `prompt=consent` for prompting re-consent when needed:
https://developers.google.com/identity/protocols/oauth2/web-server

Review context where this was found:
https://github.com/karthikcsq/google-tools-mcp/pull/112

## Smallest fix / acceptance criteria

- When the flow is specifically re-authenticating because persistent credentials are absent/stale/revoked, request re-consent so the exchange is expected to produce a refresh token. A targeted `prompt: 'consent'` on recovery/explicit `--reauth` is preferable to forcing consent on every first-time login.
- Do not report persistent authentication success when the flow required a replacement refresh token but Google returned none.
- Add a regression test where the token exchange returns only an access token during a recovery flow. The flow must either obtain/retry with explicit consent or fail clearly without claiming durable authentication.

Found by an automated Adversarial Review on behalf of Elliot while tracing the authentication paths touched by PR #112.


## Issue #124: copyFile silently ignores the name parameter

## Description

**What happened:** `copyFile` accepted a `name` argument and returned a file named `"Copy of <original>"` instead. No error, no warning that the parameter was dropped.

**Repro:** `copyFile(fileId='1lgUTj4ETTeuYFNB4u5WqifDXxvneVRCtDab_gTpruN0', name='TEMP - markdown push test - DELETE ME')` → returns `{"name": "Copy of Kickoff Email Drafts - Partner, Guest, Net-New"}`.

**Expected:** the copy is created with the requested name, since Drive's `files.copy` supports `name` in the request body. Failing that, reject the unsupported parameter instead of dropping it.

**Why it matters:** naming a throwaway copy is how you keep a temporary artifact from being mistaken for real content in a shared Drive folder.

**Evidence:** 2026-08-28, google-tools-mcp.

<details>
<summary>Diagnostic Info</summary>

- **Server version:** 2.0.0
- **Node version:** v22.22.3
- **OS:** win32 10.0.26200 (x64)
- **Auth status:** valid
- **Scopes:** documents, drive, spreadsheets, script.external_request, gmail.modify, gmail.compose, gmail.send, gmail.settings.basic, gmail.settings.sharing, calendar, forms.body, forms.body.readonly, forms.responses.readonly, presentations, tasks, service.management

</details>
