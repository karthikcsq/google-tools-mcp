# Plan: close high-risk test and package blind spots (#56)

Issue: [#56](https://github.com/karthikcsq/google-tools-mcp/issues/56) (canonical for closed #100, #101) · Verified against `main` @ 8640240. Revised after adversarial review.

## Root cause

Three separate protections all failed quietly, and each failure is invisible from a green CI run:

1. **The dist test is triply dead.** `dist/tools/docs/modifyText.test.js` doesn't match `testMatch` (`jest.config.js:3`), is excluded by `testPathIgnorePatterns` (`:4`), and — worse than the issue knew — even if it ran it tests a **local copy** of the normalization regex (`modifyText.test.js:56-58`), not the shipped path at `dist/tools/docs/modifyText.js:166-168`. So issue #9's fix has never been guarded by an executing test against production code. It ships in the tarball (`npm pack` confirms, 3.6 kB; `files: ["dist"]` has no exclusions) and inflates the coverage denominator.
2. **`createDocument` and the four permissions tools have no behavioral or identity coverage.** They *are* counted by the aggregate 156-tool assertion (`tests/toolRegistration.test.js:291-295`) — registration is indirectly covered — but no test names them (the drive `expectedTools` list at `:84-94` names only 9 of 24 drive tools) and zero tests execute them. These are the tools where a silent regression means data loss (ownership transfer, permission broadening) or the #94 class of bug.
3. **No structural guard prevents recurrence** — CI (`test.yml`) runs the suite only; the publish workflow's `npm pack --dry-run` prints the manifest without asserting on it.

## Implementation

### 1. Dead test: port the unique assertions, delete the file, guard the class

- Port to `tests/modifyText.test.js`: the six issue-#9 escape-normalization cases (`dist/.../modifyText.test.js:54-91`), **written against production code** — extract the inline regex (`modifyText.js:166-168`) into an exported `normalizeEscapes(text)` so the test executes the shipped path (also removing the duplicated-regex disease that let the dead test drift). Port the three `stripMarkdownListMarkersForSearch` cases (`:93-108`) — real, exported (`googleDocsApiHelpers.js:364`), tested nowhere live.
- `git rm dist/tools/docs/modifyText.test.js`.
- Class guard in `tests/packageContents.test.js` (shared home with #74's dead-module assertions), **allowlist-based** — a deny-list of `*.test.js` would miss the next kind of non-runtime artifact: run `npm pack --dry-run --json` and assert every packed path matches exactly `package.json`, `README.md`, `LICENSE`, or `dist/**/*.js` excluding `dist/**/*.test.js`. Any future fixture, `.map`, `.md`, or helper under `dist/` fails deterministically. Runs in normal CI on every PR.

### 2. `createDocument` coverage

New `tests/createDocument.test.js`, mocking `dist/clients.js` + `dist/markdown-transformer/index.js` (established patterns):

- root vs `parentFolderId` (parents array in `files.create`), `supportsAllDrives` carried.
- `initialContent` absent (no insert call) / `contentFormat:'raw'` / markdown (delegates to `insertMarkdown` with `firstHeadingAsTitle: true`). **Assert the raw path semantically** — an `insertText` of the content at index 1 is present — *not* "exactly one request": #14 adds a follow-up `updateTextStyle` on this same path, and a call-count assertion would create a cross-plan conflict.
- Response: `id`, `name`, `webViewLink`, fidelity `warnings` + `warningNote` (`createDocument.js:72-74, 85-88`).
- Error mapping: 404 → parent-folder message, 403 → permission message.
- **The `:77-79` swallow**: content-insert failure currently logs and returns success shaped as clean. Change it to include a `warnings` entry ("document created but initial content failed: …") and assert that; a created-but-empty doc reported as clean success is exactly the silent-partial-result pattern this repo keeps hitting.

### 3. Permissions tools coverage

New `tests/drivePermissions.test.js`, mocking `dist/clients.js`:

- Identity assertions: extend the drive `expectedTools` list (`toolRegistration.test.js:84-94`) to the **complete set of 24** drive tools (15 are currently missing from the explicit list, including `createDocument` and all four permissions tools), so absence of any one fails by name rather than only perturbing the aggregate count.
- `listPermissions`: exact field mask pinned; normalization defaults (`listPermissions.js:20-30`).
- `addPermission` matrix: user/group require email (UserError), domain requires domain; `anyone` cases; **`allowFileDiscovery` omitted vs explicit false vs true** — the schema documents a false default (`addPermission.js:37-40`) but the implementation only sends the field when provided (`:60-62`), so all three request shapes must be pinned; role enum passed through verbatim (the "not broadened" criterion); notification default logic (`:63-64`) and `emailMessage` dropped when `sendNotify` false (`:70`); `role:'owner'` without `transferOwnership` rejected (`:43-51`), with it → `transferOwnership: true` in the request.
- `updatePermission`: exact `permissionId` targeted; body only `{role}`; owner guard. `removePermission`: exact id; `supportsAllDrives` on all four.
- API failure propagation: 403 mock → tool throws, never success-shaped.

### 4. Create-then-write regression — explicit cross-plan contract

The test itself lands with #87 (tracker seeding), but it is **this issue's acceptance item too**: #56 is not closeable until the create-then-write test exists and runs, whether #87 has landed (test lives there) or not (in which case a pending/failing marker test documents the gap rather than silence). This replaces the earlier "independent" framing — the dependency is real and stated.

### 5. CI / packaging defense in depth

`test.yml` already runs the suite on PRs — `packageContents.test.js` rides it. Additionally narrow `package.json` `files` with `"!dist/**/*.test.js"` so even a reintroduced file can't ship regardless of test state.

## Acceptance criteria

- Every listed test runs under plain `npm test`; deleting `normalizeEscapes`, any permission-role mapping, or reintroducing any non-runtime file under `dist/` makes CI fail by name.
- The packed tarball is provably allowlist-clean on every PR.
- `createDocument` partial failure is visible in its response and pinned.
- Create-then-write coverage exists (via #87) before this issue closes.

## Sequencing

Mostly independent; hard coordination points: `packageContents.test.js` with #74 (same file), create-then-write with #87 (stated above), raw-path assertion style with #14. Good "first issue" territory once plans are approved.
