# 3.0 issue-coverage verdicts

Audit date: 2026-08-30. I read the full bodies of all 32 currently open issues and inspected the stated PR-head worktrees, not the PR descriptions as evidence. This report uses these heads:

| PR | Branch / head |
|---|---|
| #109 | `docs/mcp-plan-client-evidence` / `45fc243` |
| #110 | `feat/docs-cluster` / `eea7725` |
| #111 | `feat/gmail-cluster` / `078ba94` |
| #112 | `feat/ops-cluster` / `1dd0452` |
| #113 | `feat/independents` / `4e9b3ba` |

`branch:path:line` is source evidence. Test source is cited only where the issue explicitly requires a test; I did not treat a test name or a PR claim as implementation evidence. I did not run the suite or make any repository/GitHub change.

Two current PR bodies use comma-separated closure clauses that the supplied extraction says do **not** auto-close every later number. The additions below intentionally use one explicit `Closes #N` line per issue.

## #14 - Text inserted by editing tools has no explicit font color

**Verdict: CLOSES on `feat/docs-cluster` (PR #110).**

| Requirement | Finding and evidence |
|---|---|
| New text receives an explicit document-default foreground color rather than an unset/inherited value. | `getDefaultTextColor` explicitly resolves an omitted NORMAL_TEXT color to black, then emits `foregroundColor` in `feat/docs-cluster:dist/googleDocsApiHelpers.js:826-865`. `modifyText` inserts, then applies that color before caller styles (`feat/docs-cluster:dist/tools/docs/modifyText.js:100-121`); raw `createDocument` and table-cell insertion use the same helper (`feat/docs-cluster:dist/tools/drive/createDocument.js:77-103`, `feat/docs-cluster:dist/tools/docs/insertTableWithData.js:56-68`). |
| A caller-supplied color remains authoritative. | The default-color request is deliberately emitted before caller style requests (`feat/docs-cluster:dist/tools/docs/modifyText.js:80-86`, `123-136`). |

## #48 - Master: idempotent setup/update and repair of client config

**Verdict: CLOSES on `feat/ops-cluster` (PR #112).**

| Requirement | Finding and evidence |
|---|---|
| Returning user reuses valid credentials and avoids OAuth by default. | Setup inspection is explicitly read-only (`feat/ops-cluster:dist/setupInspect.js:1-2`); the returning-user path is documented in the runtime code (`feat/ops-cluster:dist/setup.js:781-784`) and covered for a healthy returning credential path (`feat/ops-cluster:tests/doctorSetupInspection.test.js:176-178`). |
| Inspect existing entries, show the proposed repair, and safely repair conflicts. | Adapters compare normalized entries, ask before add/replace, reject unknown inspection results, and return an actionable declined result (`feat/ops-cluster:dist/clientAdapters.js:181-213`). Setup displays the current redacted entry and recommended command before confirmation (`feat/ops-cluster:dist/setup.js:750-763`). |
| Never silently skip stale/duplicate/broken config; provide dry-run diagnosis. | `doctor` resolves the desired entry per client and reports the actual registration mismatch (`feat/ops-cluster:dist/doctor.js:27-45`); setup reports an unconfigured client as incomplete rather than success (`feat/ops-cluster:dist/setup.js:759-765`). |
| Explicit Claude Code and Codex adapters. | The normalized adapter shape is defined for both clients, including Codex's nested transport representation (`feat/ops-cluster:dist/clientAdapters.js:23-32`). |
| Recoverable backup/rollback for rewritten configuration. | Before replacement, `reconcileClientEntry` invokes backup and restores the old entry if the add fails (`feat/ops-cluster:dist/clientAdapters.js:203-213`). Setup persists a private client-entry backup record (`feat/ops-cluster:dist/setup.js:608-622`) and atomically backs up/replaces its `.env` (`feat/ops-cluster:dist/setup.js:624-678`). |
| Test first install, healthy return, broken entry, declined repair, partial failure. | The exercised cases include unchanged entries, declined repair, propagation of incomplete setup, and rollback failure (`feat/ops-cluster:tests/setupIdempotency.test.js:138-164`, `344-383`). |

## #50 - Required reviewer on `npm-publish`

**Verdict: NOT ADDRESSED.**

| Requirement | Finding and evidence |
|---|---|
| Add a required reviewer and, optionally, a release-branch/tag policy to the GitHub environment. | This is a repository-admin setting, not a worktree change. The workflow can only name the environment (`docs/mcp-plan-client-evidence:.github/workflows/publish.yml:67-75`); the tracked release plan explicitly says the environment has zero protection rules and requires an admin action (`docs/mcp-plan-client-evidence:docs/plans/SESSION-STATE.md:228-233`). |

## #56 - Master: high-risk test and package blind spots

**Verdict: PARTIAL on `feat/independents` (PR #113). Do not auto-close it from PR #113 alone.**

| Requirement | Finding and evidence |
|---|---|
| `createDocument`: root/parent placement, raw and markdown content, identity/warnings/API failure behavior. | Implemented and executed tests cover root return fields, parent + raw content, markdown warnings, total failure, and partial batch failure (`feat/independents:tests/createDocument.test.js:37-119`); the runtime returns the created document plus a truthful partial-result warning (`feat/independents:dist/tools/drive/createDocument.js:30-115`). |
| `createDocument` create-then-write regression, so the Docs read-tracker gap cannot recur. | **Not on this branch.** The required Docs seeding implementation and regression are in the separate `feat/docs-cluster` worktree, not PR #113. PR #113's `createDocument` has no `trackRead`/handle import (`feat/independents:dist/tools/drive/createDocument.js:1-6`). |
| Drive-permission registration, field mapping/types/roles/ID targeting/shared drives/errors/ownership transfer. | The actual tool contracts are exercised against exact Drive request objects, including ownership confirmation and forbidden errors (`feat/independents:tests/drivePermissions.test.js:35-116`). |
| Remove the dead `dist` test, port useful assertions, exercise literal escapes, keep test files out of the tarball, audit package payload. | The package now excludes `dist/**/*.test.js` (`feat/independents:package.json:9-12`); the shipped `normalizeEscapes` implementation is imported and tested for literal `\\n`/`\\t` (`feat/independents:tests/modifyText.test.js:1-4`, `191-210`). |

**Exact remaining work:** land the `createDocument` read-seeding implementation and create-then-write regression from `feat/docs-cluster` before closing #56. If PR #110 is merged first, the release composite meets this remaining requirement, but PR #113 by itself does not.

## #71 - Replace umbrella `googleapis` with scoped packages

**Verdict: NOT ADDRESSED.**

| Requirement | Finding and evidence |
|---|---|
| Remove `googleapis`, use the scoped API packages, and verify the smaller dependency tree/startup behavior. | The migration branch still declares `googleapis` (`docs/mcp-plan-client-evidence:package.json:73-76`), locks it (`docs/mcp-plan-client-evidence:package-lock.json:15-18`), and imports it in runtime code (`docs/mcp-plan-client-evidence:dist/auth.js:1-5`). The only change is a plan; no implementation exists. |

## #73 - Master: RFC-compliant Gmail MIME generation

**Verdict: CLOSES on `feat/gmail-cluster` (PR #111).**

| Requirement | Finding and evidence |
|---|---|
| RFC 2047 for unsafe/non-ASCII subjects and display names, with legal chunking/folding and ASCII compatibility. | `encodeEncodedWords` chunks by code point under the encoded-word/line budget and `encodeHeaderValue` preserves printable ASCII (`feat/gmail-cluster:dist/mime.js:133-200`); address display names use the same safe path without encoding addr-specs (`feat/gmail-cluster:dist/mime.js:217-250`). |
| Safe folded `Content-Type` and `Content-Disposition`, including long/Unicode attachment names. | MIME type validation rejects header injection, RFC 2231 parameters are segmented, and both headers are folded through dedicated constructors (`feat/gmail-cluster:dist/mime.js:271-312`, `394-435`). |
| Send/draft/reply/forward use the corrected construction path. | Gmail message tools import and use the MIME assembly primitives (`feat/gmail-cluster:dist/tools/gmail/messages.js:1-24`); the shared builder constructs real quoted-printable/base64 multipart payloads (`feat/gmail-cluster:dist/mime.js:442-615`). |

## #74 - Master: Gmail maintenance cleanup

**Verdict: CLOSES on `feat/gmail-cluster` (PR #111).**

| Requirement | Finding and evidence |
|---|---|
| Remove the five dead root-level Gmail modules and ensure they are not published. | The five modules are deleted on the PR branch; the tarball guard enumerates the exact forbidden paths and runs `npm pack --dry-run` (`feat/gmail-cluster:tests/packageContents.test.js:1-36`, `56-60`). |
| Extract repeated message formatting dispatch. | Thread handling routes every message through the shared `formatMessageForOutput` rather than duplicating mode dispatch (`feat/gmail-cluster:dist/tools/gmail/threads.js:76-88`). |
| Document/retain `maxMessages: 0` as unlimited. | Runtime only slices positive values, making zero and negatives unlimited, and descriptions state that contract (`feat/gmail-cluster:dist/tools/gmail/threads.js:76-102`). |

## #75 - Master: production-ready shared HTTP transport

**Verdict: PARTIAL on `feat/ops-cluster` (PR #112). The existing `Closes #75` claim is too broad.**

| Requirement | Finding and evidence |
|---|---|
| Lifecycle: start/attach/health/restart/stop, collision diagnosis, persistent private token, and documented login/service mode. | Implemented and tested: stable private tokens survive restarts (`feat/ops-cluster:tests/httpState.test.js:13-36`), lifecycle operations are tested in `feat/ops-cluster:tests/httpOperations.test.js:10-45`, and documented Windows/macOS/Linux service-manager recipes exist (`feat/ops-cluster:docs/http-mode.md:90-96`, `200-240`). |
| One profile/one account, loopback/TLS boundary, two-client end-to-end isolation, and manual-lifecycle documentation. | The explicit one-profile boundary is documented (`feat/ops-cluster:docs/http-mode.md:75-80`), service mode rejects non-loopback before a TLS model exists (`feat/ops-cluster:docs/http-mode.md:122-125`), and two authenticated SDK clients with distinct workspaces are tested (`feat/ops-cluster:tests/twoClientHttpE2E.test.js:74-104`). |
| Guided setup configures HTTP end-to-end for **both** Claude Code and Codex, including the token handoff. | **Not complete for Codex.** The adapter deliberately returns a manual registration path when the bearer token is not inherited (`feat/ops-cluster:dist/clientAdapters.js:181-197`), and setup prints the Codex command rather than producing an authenticated registration (`feat/ops-cluster:dist/setup.js:555-565`). That is useful guidance, but it is not end-to-end configuration. |

**Exact remaining work:** make guided HTTP setup create or safely complete an authenticated Codex registration, including durable token availability, rather than refusing it and printing a manual command.

## #82 - Master: load shared machine configuration before startup

**Verdict: CLOSES on `feat/ops-cluster` (PR #112).**

| Requirement | Finding and evidence |
|---|---|
| Load shared config before startup consumers and preserve process-env precedence. | `config.js` is designed to load before consumers (`feat/ops-cluster:dist/config.js:1-5`); a defined process value, even empty, wins over file values (`feat/ops-cluster:dist/config.js:151-156`). `dist/index.js` then chooses transport from the resolved environment (`feat/ops-cluster:dist/index.js:175-180`). |
| User config, project/package layers, secure profile choice, and required environment families. | The user layer is deliberately higher trust than cwd/package files (`feat/ops-cluster:dist/config.js:85-99`), `GOOGLE_MCP_PROFILE` is snapshotted/validated before file loading (`feat/ops-cluster:dist/config.js:14-43`), and config-file profile attempts are refused (`feat/ops-cluster:dist/config.js:140-155`). This makes transport, logging, Maps, and workspace values visible through ordinary `process.env` consumers. |
| Secure on-disk credentials/config and process/file precedence tests. | Token persistence creates restrictive directory/file modes (`feat/ops-cluster:dist/auth.js:171-191`); stable HTTP token permissions are exercised (`feat/ops-cluster:tests/httpState.test.js:13-36`). |

## #86 - Master: reliable Docs comments workflow

**Verdict: CLOSES on `feat/docs-cluster` (PR #110).**

| Requirement | Finding and evidence |
|---|---|
| Resolve for real and fail when verification does not persist. | `resolveComment` creates a reply with `action: 'resolve'`, reads the comment back, and throws if `resolved` is still false (`feat/docs-cluster:dist/tools/docs/comments/resolveComment.js:8-39`). |
| Reply fields/counts, incremental listing/pagination, quoted text, answered filter. | `listComments` exposes `updatedAfter`, pagination, quoted-text and unanswered controls (`feat/docs-cluster:dist/tools/docs/comments/listComments.js:41-70`), requests `replies` plus `startModifiedTime` (`76-83`), and computes real reply counts from the returned replies (`92-106`). |
| Update comment content in place. | A dedicated `updateComment` tool exists in the Docs comment registry (`feat/docs-cluster:dist/tools/docs/comments/updateComment.js:1-160`). |

## #87 - Master: Docs read/write state and isolated working copies

**Verdict: PARTIAL across `docs/mcp-plan-client-evidence` + `feat/docs-cluster`. Do not add a `Closes #87` line.**

| Requirement | Finding and evidence |
|---|---|
| Docs content/revision-aware guarding and useful conflict behavior. | The v2 handle records capture a structural projection at read time (`docs/mcp-plan-client-evidence:dist/docsHandles.js:156-168`) and classify a later snapshot before re-arming (`docs/mcp-plan-client-evidence:dist/docsHandles.js:464-466`); range-scoped writes use that guard (`feat/docs-cluster:dist/tools/docs/replaceRangeWithMarkdown.js:43-48`, `504-546`). |
| Per-session/per-handle editable copies and preservation of unpushed work. | Handle reads create an independent editable path (`docs/mcp-plan-client-evidence:dist/docsHandles.js:122-176`); local copies are fingerprinted and backed up before overwrite (`feat/docs-cluster:dist/workspace.js:145-217`). |
| Seed trustworthy state after create/copy/template operations, with Docs **and Sheets** create-then-write coverage. | **Not complete.** `createSpreadsheet` creates/writes data without importing or seeding `trackRead`/a read handle (`feat/docs-cluster:dist/tools/sheets/createSpreadsheet.js:1-70`). `copyFile` likewise has no tracker/handle seeding (`feat/docs-cluster:dist/tools/drive/copyFile.js:1-64`). Thus the required Sheets and copy flows remain unseeded, regardless of the Docs-specific seeding added elsewhere. |

**Exact remaining work:** seed a trustworthy read baseline after spreadsheet creation and copied/template files, then add Docs-and-Sheets create/copy/template immediate-write regression coverage. The current PR #110 claim that #87 is fully satisfied is wrong.

## #88 - Master: safe structured Docs editing

**Verdict: CLOSES on `feat/docs-cluster` (PR #110).**

| Requirement | Finding and evidence |
|---|---|
| Atomic targeted multi-editing and non-overlap/base-revision handling. | `batchModifyText` resolves all operations from one snapshot, rejects overlap, applies highest-index first, and sends one guarded `batchUpdate` (`feat/docs-cluster:dist/tools/docs/batchModifyText.js:318-329`, `353-442`, `530-573`). |
| Preview and applied diff/deletion summary. | The same implementation calculates a proposed patch and deletion totals, returns them in dry run, then returns the applied patch after the single write (`feat/docs-cluster:dist/tools/docs/batchModifyText.js:483-524`, `558-573`). |
| Section-scoped structural replacement that protects out-of-range content. | `replaceRangeWithMarkdown` supports semantic/explicit targets, dry run, fidelity policy, and states that content outside the resolved range is untouched (`feat/docs-cluster:dist/tools/docs/replaceRangeWithMarkdown.js:391-409`). |
| Collateral comment/link protection and a lightweight heading API. | Whole-body replacement warns about comment anchors and regenerated heading IDs (`feat/docs-cluster:dist/tools/utils/replaceDocumentWithMarkdown.js:100-108`); `listHeadings` returns heading ID, level and indices using narrow fields (`feat/docs-cluster:dist/tools/docs/listHeadings.js:43-108`). |

## #91 - Master: actionable diagnostics

**Verdict: CLOSES on `feat/ops-cluster` (PR #112).**

| Requirement | Finding and evidence |
|---|---|
| Redacted structured call logs, rotation, documented fields and startup timing. | The facade records a safe outcome/argument shape for every invoked tool (`feat/ops-cluster:dist/mcpServer.js:69-109`) and the logger rotates the JSONL sink safely (`feat/ops-cluster:dist/logger.js:32-41`, `241-310`). The runbook defines fields, redaction, defaults and the pre-handshake timing location (`feat/ops-cluster:docs/troubleshooting-runbook.md:3-35`, `52-57`). |
| Privacy-safe troubleshooting/feedback with explicit public-post review. | `troubleshoot` aggregates safe recent tool records (`feat/ops-cluster:dist/tools/index.js:399-425`); feedback defaults diagnostics off and requires an expiring reviewed `draftId` before publication (`feat/ops-cluster:dist/tools/index.js:450-575`). |
| Tests/runbook kept synchronized. | The runtime source makes the review boundary explicit and the runbook is the operational contract; the PR adds diagnostics/feedback test modules in its diff (`feat/ops-cluster:dist/tools/index.js:450-575`, `feat/ops-cluster:docs/troubleshooting-runbook.md:15-35`). |

## #96 - `readDocument` plainMarkdown

**Verdict: CLOSES on `feat/docs-cluster` (PR #110).**

| Requirement | Finding and evidence |
|---|---|
| Expose `plainMarkdown`, default false, forward it to conversion, and document working-copy safety. | Schema and description define the flag and its rich-working-copy rule (`feat/docs-cluster:dist/tools/docs/readGoogleDoc.js:120-133`); markdown output returns the plain conversion only when requested while retaining the rich value for tracking and local editing (`feat/docs-cluster:dist/tools/docs/readGoogleDoc.js:257-273`, `416-419`). |

## #99 - Recursive Drive folder listing

**Verdict: CLOSES on `feat/independents` (PR #113).**

| Requirement | Finding and evidence |
|---|---|
| Depth/default compatibility, bounded recursion and reconstructable tree. | Schema preserves depth 1 and adds bounded `depth`/`maxItems`; recursive responses provide `path` and `parentIds` (`feat/independents:dist/tools/drive/listFolderContents.js:45-60`, `118-139`). |
| Safe traversal: cycles/shortcuts, truncation, partial failures, shared drives, trashed filtering. | Folder visits are de-duplicated and shortcuts not expanded (`feat/independents:dist/tools/drive/listFolderContents.js:120-139`, `197-228`); queries consistently exclude trashed items and carry shared-drive fields/scoping (`feat/independents:dist/tools/drive/listFolderContents.js:109-116`, `161-166`); unreadable branches are isolated and reported (`172-194`). |

## #105 - Affordable `readDocument` index mode

**Verdict: CLOSES on `feat/docs-cluster` (PR #110).**

| Requirement | Finding and evidence |
|---|---|
| Compact structural index with true Docs indices and pagination. | `format: 'index'`, cursor, and response-budget parameters are public schema (`feat/docs-cluster:dist/tools/docs/readGoogleDoc.js:80-105`); the index uses narrow fields rather than raw JSON (`141-157`) and serializes its result with an element cursor (`208-226`). |
| Bound oversized JSON, support explicit JSON limit/stripping, and direct callers to index mode. | Oversized raw JSON returns an actionable index-mode refusal; explicit `maxLength` still permits JSON truncation (`feat/docs-cluster:dist/tools/docs/readGoogleDoc.js:230-255`). |

## #106 - Working-copy rewrites corrupt markdown list structure

**Verdict: CLOSES on `feat/docs-cluster` (PR #110).**

| Requirement | Finding and evidence |
|---|---|
| Preserve nested list structure and avoid invalid loose-list whitespace. | The exporter computes nesting from actual ancestor marker widths rather than fixed two-space indents (`feat/docs-cluster:dist/markdown-transformer/docsToMarkdown.js:355-393`) and separates a following block from the last list item (`312-353`). |
| Do not silently destroy an edited local copy. | A caller can use `writeLocalFile:false` for a staleness read (`feat/docs-cluster:dist/tools/docs/readGoogleDoc.js:127-133`); defaults also detect local modifications, save `<path>.bak`, and report it (`feat/docs-cluster:dist/workspace.js:181-220`, `feat/docs-cluster:dist/tools/docs/readGoogleDoc.js:317-345`). Per-handle editable paths prevent one handle's read from overwriting another's (`docs/mcp-plan-client-evidence:dist/docsHandles.js:122-176`). |

**Live-smoke reconciliation:** this agrees with the supplied latest result: #106 passes. I found no code contradiction.

## #107 - Safe one-section Docs rewrite

**Verdict: CLOSES on `feat/docs-cluster` (PR #110).**

| Requirement | Finding and evidence |
|---|---|
| Replace a selected range/heading/text target with Markdown while leaving outside content intact. | `replaceRangeWithMarkdown` accepts target modes, preserves content outside the range, and defaults to blocking format-loss inside the selected range (`feat/docs-cluster:dist/tools/docs/replaceRangeWithMarkdown.js:391-409`). |
| Allow real list control as the smaller alternative. | `modifyText.paragraphStyle.bulletPreset` maps to actual `createParagraphBullets`/`deleteParagraphBullets`, not literal prefixes (`feat/docs-cluster:dist/tools/docs/modifyText.js:147-168`). |

**Live-smoke reconciliation:** this agrees with the supplied passing rerun. The corrected scenario must use the implemented `target` parameter, not `range`; `modifyText` exposes `target` at `feat/docs-cluster:dist/tools/docs/modifyText.js:50-75`.

## #108 - Range-precise stale guard

**Verdict: CLOSES on `feat/docs-cluster` (PR #110, on the #109 handle foundation).**

| Requirement | Finding and evidence |
|---|---|
| Permit non-overlapping semantic edits after an unrelated change, explain conflicts, and retain explicit compare-and-write control. | Batch operations classify every target against a current snapshot; semantic targets re-resolve, while explicit indices remain conservative (`feat/docs-cluster:dist/tools/docs/batchModifyText.js:318-325`, `402-425`). The range writer documents and enforces the same distinction (`feat/docs-cluster:dist/tools/docs/replaceRangeWithMarkdown.js:406-409`, `504-546`). |

## #114 - Feedback title shell injection

**Verdict: CLOSES on `feat/ops-cluster` (PR #112).**

| Requirement | Finding and evidence |
|---|---|
| Use argv execution, preserving title as one inert argument. | `tryGhCli` explicitly passes an argv array to `runArgv` (`feat/ops-cluster:dist/tools/index.js:40-61`); `runArgv` invokes `execFile` and applies Windows metacharacter escaping only to construct the child argv (`feat/ops-cluster:dist/shellSafe.js:68-96`). |

## #115 - Re-auth without a replacement refresh token

**Verdict: CLOSES on `feat/independents` (PR #113).**

| Requirement | Finding and evidence |
|---|---|
| Request re-consent and refuse to claim durable success without a refresh token. | Interactive auth now forces `prompt: 'consent'` (`feat/independents:dist/auth.js:253-274`); a token exchange missing `refresh_token` fails clearly rather than logging success, and only a refresh token reaches `saveCredentials` (`315-330`). Invalid-grant recovery enters this same flow (`362-372`). |

## #116 - Gmail quoted-printable double decode

**Verdict: CLOSES on `feat/gmail-cluster` (PR #111).**

| Requirement | Finding and evidence |
|---|---|
| Preserve literal `=` in draft/create/send/reply/forward message bodies. | The shared MIME path performs quoted-printable **encoding** of source body text (`feat/gmail-cluster:dist/mime.js:442-503`) and serializes the final raw MIME payload (`549-615`); Gmail message tools consume this builder rather than applying a second body decode (`feat/gmail-cluster:dist/tools/gmail/messages.js:1-24`). |

## #117 - Link-target mismatch warnings

**Verdict: CLOSES on `feat/docs-cluster` (PR #110).**

| Requirement | Finding and evidence |
|---|---|
| Detect visible email/URL text whose target differs, including a broken autolink boundary, and advise a real repair path. | `detectLinkMismatches` normalizes display/target values and detects a non-whitespace preceding boundary (`feat/docs-cluster:dist/markdown-transformer/docsToMarkdown.js:192-263`); markdown reads present the warning and explain that `findAndReplace` cannot repair a link target (`feat/docs-cluster:dist/tools/docs/readGoogleDoc.js:290-304`). |

## #118 - Trailing-space emphasis delimiter corruption

**Verdict: CLOSES on `feat/docs-cluster` (PR #110).**

| Requirement | Finding and evidence |
|---|---|
| Export styled whitespace outside emphasis delimiters so a read/write round trip stays valid Markdown. | The exporter extracts leading/trailing whitespace, wraps only the non-whitespace core in bold/strike delimiters, then reattaches whitespace outside (`feat/docs-cluster:dist/markdown-transformer/docsToMarkdown.js:451-507`). |

## #119 - Phantom stale error with an empty diff

**Verdict: CLOSES for the 3.0 MCP runtime on `feat/docs-cluster` + `docs/mcp-plan-client-evidence`.**

| Requirement | Finding and evidence |
|---|---|
| Do not reject a Docs edit simply because metadata changed without a content/structural conflict; keep subsequent write state correct. | The deployed v2 path captures a structural projection on read (`docs/mcp-plan-client-evidence:dist/docsHandles.js:156-168`) and classifies the current projection before deciding/re-arming a target write (`docs/mcp-plan-client-evidence:dist/docsHandles.js:464-466`). This replaces the old metadata-only decision for MCP Docs mutations. |

The legacy direct-module fallback still has an unconditional throw after producing a patch (`docs/mcp-plan-client-evidence:dist/readTracker.js:142-197`). That is not the 3.0 facade path, but it should be removed or separately tested if direct tool execution is to remain a supported mutation surface.

## #120 - `modifyText` cannot make real lists

**Verdict: CLOSES on `feat/docs-cluster` (PR #110).**

| Requirement | Finding and evidence |
|---|---|
| Expose real bullet/numbered-list control for a targeted edit. | `bulletPreset` is extracted from paragraph style and becomes `createParagraphBullets`; `null` becomes `deleteParagraphBullets` (`feat/docs-cluster:dist/tools/docs/modifyText.js:147-168`). |

## #121 - Replacement text inherits unwanted character style

**Verdict: CLOSES on `feat/docs-cluster` (PR #110).**

| Requirement | Finding and evidence |
|---|---|
| Let callers clear inherited character style and make the behavior explicit. | `clearStyle` is a public option with the specific inherited-italic explanation (`feat/docs-cluster:dist/tools/docs/modifyText.js:50-61`); after insertion it emits a full direct-style clear before default/caller styles (`100-121`). |

## #122 - `readDocument` silently overwrites local mirror edits

**Verdict: CLOSES on `feat/docs-cluster` (PR #110).**

| Requirement | Finding and evidence |
|---|---|
| Do not silently destroy pending local edits; offer a non-writing diff read. | `writeLocalFile:false` leaves the mirror untouched (`feat/docs-cluster:dist/tools/docs/readGoogleDoc.js:127-133`). Otherwise, local-content fingerprints force a private `.bak` before overwrite (`feat/docs-cluster:dist/workspace.js:181-220`), and the read result names that backup (`feat/docs-cluster:dist/tools/docs/readGoogleDoc.js:317-345`). |

## #123 - Missing blank line after list merges following header

**Verdict: CLOSES on `feat/docs-cluster` (PR #110).**

| Requirement | Finding and evidence |
|---|---|
| Export a block separator after a list before a following paragraph/header. | The markdown exporter tracks a preceding list item and inserts the extra separator before non-list paragraphs, tables, and section breaks (`feat/docs-cluster:dist/markdown-transformer/docsToMarkdown.js:285-316`, `330-353`). |

## #124 - `copyFile` ignores `name`

**Verdict: CLOSES on `feat/independents` (PR #113).**

| Requirement | Finding and evidence |
|---|---|
| Accept Drive's `name`, preserve the legacy alias, and pass the requested name to `files.copy`. | Schema accepts `name`, keeps `newName` as a deprecated fallback, and is strict against silently dropped keys (`feat/independents:dist/tools/drive/copyFile.js:12-30`); `requestedName` is used in the copy request body (`31-56`). |

## #125 - Browser-open helpers build shell strings around URLs

**Verdict: CLOSES on `feat/ops-cluster` (PR #112), though the PR body never mentions it.**

| Requirement | Finding and evidence |
|---|---|
| Open OAuth/setup/browser URLs as argv, not interpolated shell strings. | Auth imports `openBrowser` from `shellSafe` and calls it with the generated OAuth URL (`feat/ops-cluster:dist/auth.js:9-13`, `226-233`); clients and setup import that same helper for browser actions (`feat/ops-cluster:dist/clients.js:1-7`, `feat/ops-cluster:dist/setup.js:12-16`, `251-255`). The helper uses `execFile`-based argv invocation (`feat/ops-cluster:dist/shellSafe.js:68-111`). |

## #126 - Second-level shared-folder enumeration returns empty

**Verdict: NOT ADDRESSED.**

| Requirement | Finding and evidence |
|---|---|
| A direct, one-level `listFolderContents(folderId)` must enumerate accessible shared-folder children rather than silently return empty. | PR #113 fixes the **recursive** path by reading the root's `driveId` and supplying `corpora:'drive'`/`driveId` (`feat/independents:dist/tools/drive/listFolderContents.js:96-116`, `161-166`). Its unchanged depth-1 path still calls `files.list` without either shared-drive scope (`71-87`), exactly the path in this issue's reproduction. |

## Add these explicit closure lines to PR bodies

- PR #110
  ```text
  Closes #96
  Closes #106
  Closes #107
  ```

- PR #111
  ```text
  Closes #74
  ```

- PR #112
  ```text
  Closes #48
  Closes #82
  Closes #91
  Closes #125
  ```

Do **not** add a line for #56, #75, or #87. #56 becomes closable only after the separate #110 create-then-write work is merged; #75 and #87 have remaining product work. PR #109 and PR #127 need no added closure lines.

## Issues that must stay open after 3.0

- #50: only a repository admin can add the required reviewer environment protection.
- #71: `googleapis` is still the runtime dependency; scoped-package migration is only planned.
- #75: guided HTTP setup still cannot complete authenticated Codex registration.
- #87: Sheets and copy/template read-state seeding plus regression coverage are missing.
- #126: direct depth-1 listing still omits shared-drive scoping and can return the reported false-empty result.
