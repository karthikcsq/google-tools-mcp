# Plan: close high-risk test and package blind spots (#56)

Issue: [#56](https://github.com/karthikcsq/google-tools-mcp/issues/56) (canonical for closed #100, #101) · Verified against `main` @ 8640240.

## Root cause

Three separate protections all failed quietly, and each failure is invisible from a green CI run:

1. **The dist test is triply dead.** `dist/tools/docs/modifyText.test.js` doesn't match `testMatch` (`jest.config.js:3`), is excluded by `testPathIgnorePatterns` (`:4`), and — worse than the issue knew — even if it ran it tests a **local copy** of the normalization regex (`modifyText.test.js:56-58` defines its own `normalize()`), not the shipped path at `dist/tools/docs/modifyText.js:166-168`. So issue #9's fix has *never* been guarded by an executing test against production code. It also ships in the tarball (`npm pack` confirms, 3.6 kB) because `files: ["dist"]` has no exclusions, and it inflates the coverage denominator (`collectCoverageFrom` includes it).
2. **`createDocument` and all four permissions tools have zero coverage** — not even registration assertions (`tests/toolRegistration.test.js:84-94` names only 9 of 24 drive tools). These are the tools where a silent regression means data loss (ownership transfer, permission broadening) or the #94 class of bug (create-then-write).
3. **No structural guard prevents recurrence** — CI (`test.yml`) runs `npm test` only; the publish workflow's `npm pack --dry-run` step prints the manifest without asserting on it.

## Implementation

### 1. Dead test: port the unique assertions, delete the file, guard the class

- Port to `tests/modifyText.test.js`: the six issue-#9 escape-normalization cases (`dist/.../modifyText.test.js:54-91`) — but **written against the real code path**. The regex lives inline in the `execute` handler (`modifyText.js:166-168`); extract it to an exported `normalizeEscapes(text)` beside `buildModifyTextRequests` so the test executes production code (this also removes the duplicated-regex disease that let the dead test drift). Port the three `stripMarkdownListMarkersForSearch` cases (`:93-108`) — that function is real and exported (`googleDocsApiHelpers.js:364`) but tested nowhere live.
- `git rm dist/tools/docs/modifyText.test.js`.
- Class guard, in a new `tests/packageContents.test.js` (shared home with #74's dead-module assertions): run `npm pack --dry-run --json` (or glob `dist/`) and assert (a) no `*.test.js` under `dist/`, (b) no other non-runtime artifacts (recon: currently none besides this file — the test keeps it that way). This runs in normal CI on every PR, which beats a publish-time check.

### 2. `createDocument` coverage

New `tests/createDocument.test.js`, mocking `dist/clients.js` + `dist/markdown-transformer/index.js` (patterns exist):

- root vs `parentFolderId` (parents array in `files.create` request), `supportsAllDrives` carried.
- `initialContent` absent (no insert call) / `contentFormat:'raw'` (single `insertText` at index 1) / markdown (delegates to `insertMarkdown` with `firstHeadingAsTitle: true`).
- Response: `id`, `name`, `webViewLink`, fidelity `warnings` + `warningNote` surfaced (`createDocument.js:72-74, 85-88`).
- Error mapping: 404 → parent-folder message, 403 → permission message.
- **The `:77-79` swallow**: content-insert failure currently logs and returns success with no warning — assert current behavior, then change it to include a `warnings` entry ("document created but initial content failed: …") and assert that. A created-but-empty doc reported as clean success is exactly the silent-partial-result pattern this repo keeps hitting.
- Create-then-write regression: covered by #87's plan (seeding); the test lands there but is *this* issue's acceptance item too — cross-linked, not duplicated.

### 3. Permissions tools coverage

New `tests/drivePermissions.test.js`, mocking `dist/clients.js`:

- Registration: add all four (plus `createDocument` and the other missing 11) to the drive `expectedTools` list at `tests/toolRegistration.test.js:84-94` — make it the *complete* 24, so absence of any drive tool fails.
- `listPermissions`: exact field mask pinned; normalization defaults (`listPermissions.js:20-30`).
- `addPermission` matrix: user/group require email (UserError), domain requires domain, `anyone` + `allowFileDiscovery`; role enum passed through **verbatim** (assert the request body role equals input — the "not broadened" criterion); notification default logic (`:63-64`) and `emailMessage` dropped when `sendNotify` false (`:70`); `role:'owner'` without `transferOwnership` rejected (`:43-51`); with it, `transferOwnership: true` in the request.
- `updatePermission`: exact `permissionId` targeted; body is only `{role}`; owner guard.
- `removePermission`: exact id in `permissions.delete`; `supportsAllDrives` on all four.
- API failure propagation: mock a 403 → tool throws (not success-shaped output).

### 4. CI

`test.yml` already runs the suite on PRs — the new packageContents test rides it; no workflow edit needed beyond (optional) adding `npm pack --dry-run` output as an artifact for release archaeology. Defense in depth for publishing: add `"files"` exclusion `"!dist/**/*.test.js"` to `package.json` so even a reintroduced file can't ship.

## Acceptance criteria

- Every listed test runs under plain `npm test`; deleting `normalizeEscapes`'s regex, any permission-role mapping, or reintroducing a dist test file makes CI fail.
- Tarball contains runtime files only, enforced per-PR.
- `createDocument` partial failure is visible in its response, and the suite pins it.

## Sequencing

Independent; coordinate `tests/packageContents.test.js` with #74 (same file), the create-then-write test with #87, and the `createDocument` color test with #14. Good "first issue" territory once the plans are approved.
