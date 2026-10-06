# Google Tools MCP: current audit and proposed release

Audit date: 2026-09-07. Execution approved by the maintainer on 2026-09-07, including implementation, PR publication and review follow-up, release verification, and persistent PR monitoring. The findings below record the audited baseline; implementation acceptance still requires the listed evidence.

## Recommendation

Finish the existing migration and ship a deliberately breaking **4.0 HTTP-first release**. Use one supervised local HTTP service per configured profile/account, explicit read handles, a lightweight tool catalog, and an agent-usable setup/update path. Retire the full per-client stdio runtime through a documented migration window. Preserve the useful Google operations while simplifying redundant interfaces.

The repository already uses the latest published official MCP SDK packages. Replacing its framework again would miss the current failures. The hard work is completing state handling, startup and service management, improving tool behavior, and getting existing installations onto the released version and recommended configuration.

## Verified baseline

| Item | Evidence on this audit |
| --- | --- |
| Repository and code | [karthikcsq/google-tools-mcp](https://github.com/karthikcsq/google-tools-mcp), local HEAD and live main both `9b3ea0bcb4327d7f009c079cd779f2f06fffd9a1` |
| Version | `package.json` and npm latest both **3.4.6** |
| Protocol / SDK | MCP **2026-07-28**; `@modelcontextprotocol/server` and `@modelcontextprotocol/node` locked at **2.0.0**, also their npm latest versions |
| GitHub inventory | 121 issues in the complete paginated snapshot: **27 open**, 94 closed; 49 PR records, **0 open PRs** |
| Tool inventory | Generated production registration inventory: **160 default tools**. Counts near 180 in reports are not the current default catalog; aliases are separately opt-in. |
| Local verification | `npm run test:ci -- --runInBand`: **97 suites passed, 1429 tests passed, 2 skipped**, 145.247 seconds on Windows / Node 26.7.0. Skips are POSIX workspace permission/symlink assertions. |
| Coverage | 65.18% statements, 55.87% branches, 66.64% lines. `dist/index.js` is excluded from coverage collection. Green tests do not imply every Google operation was exercised. |
| Dependencies | `npm ci --ignore-scripts` installed 427 packages; production `npm audit --omit=dev --json` reported **0 vulnerabilities**. Deprecation warnings in transitive packages are separate from an advisory result. |
| Package / release checks | Release version/changelog consistency passed. Pack dry-run: 185 entries, 396,680 bytes packed, 1,595,384 bytes unpacked. |
| Current CI | [Tests](https://github.com/karthikcsq/google-tools-mcp/actions/runs/33976682024) and [npm publish](https://github.com/karthikcsq/google-tools-mcp/actions/runs/33976716427) succeeded on this SHA. PR CI tests Node 20/22 on Linux; publishing tests Node 24. |
| Release controls | Live main is unprotected and repository ruleset listing is empty. Publish is tag-triggered; the named npm environment is deliberately not a reviewer gate. |

Machine-readable snapshots and command output are in [the audit task list](../../.planning/audit-task-list.md). All current issue bodies and comments were collected. Historical issue/PR metadata and bodies were collected across all pages; detailed historical review is concentrated on the migration, subsequent fixes, and closure decisions. This is an architecture, backlog, code-path and test audit, not a claim of exhaustive live execution of all 160 tools. No Google account data was mutated and no runtime/client configuration was changed.

## What the new standard actually changes

The current protocol revision is 2026-07-28. It uses per-request version/capability metadata, mandatory server support for `server/discover`, explicit cross-request state identifiers, and HTTP routing headers. **stdio is still a standard transport.** Deprecating it here is a product decision to eliminate repeated startup and state ambiguity, not an Anthropic requirement. Sources: [versioning](https://modelcontextprotocol.io/specification/versioning), [transport bindings](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports), [statelessness](https://modelcontextprotocol.io/specification/2026-07-28/basic).

The repo already has discovery, deterministic catalog ordering, private cache hints, stateless HTTP, per-request authentication, explicit Docs handles, and no old `/sse` or `/messages` routes. Both modern and legacy clients are supported by the SDK defaults used in `dist/mcpServer.js`; tests explicitly execute legacy HTTP and stdio handshakes. Therefore #155's grep-based claim of current-only support is false. SDK implementation is part of the runtime even when old version strings do not appear in `dist/`. See [SDK migration guidance](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28).

One real standards gap remains: modern stdio shares implicit connection-pinned read state (`dist/mcpServer.js:400`, `dist/requestContext.js:206`, `dist/readTracker.js:110`). The current spec requires explicit identifiers for application state across requests, including stdio. The new design should use the same explicit handle contract on every modern transport; a temporary legacy adapter must not define modern behavior.

Do not treat every optional extension as a release requirement. Use structured tool outputs and accurate annotations now; evaluate MRTR/input-required for auth and high-risk previews, and Tasks for genuinely long-running operations after their durable-state requirements are designed. Apps, enterprise identity, public hosting, and horizontal scaling do not solve the current local startup problem. They need separate deployment contracts, rather than being implicitly enabled by changing the transport.

Keep the SDK workarounds until tests against the installed package prove they are unnecessary. Upstream [#2589](https://github.com/modelcontextprotocol/typescript-sdk/issues/2589) is closed, but npm latest remains 2.0.0; closure alone does not prove a published fix. [#2650](https://github.com/modelcontextprotocol/typescript-sdk/issues/2650), empty subscription streams, remains open. The facade contains narrow workarounds for both plus stdio EOF cleanup.

## Root causes and additional findings

### 1. HTTP migration stopped at the Docs boundary

`writeSpreadsheet`, `batchWrite`, the publicly registered `clearRange` (file named `clearSpreadsheetRange.js`), and `deleteFile` still call the session-style `guardMutation` without handle input. `readSpreadsheet` calls only `trackRead`; `getFileInfo` issues no read state at all. HTTP correctly refuses these writes because each request has fresh implicit state. Changing the default alone would remove working capabilities from users.

A further weakness exists on stdio: `readSpreadsheet` records no content/revision baseline, while the three writes import `trackMutation` but do not call it. A transport port alone is insufficient. Give each resource kind a real baseline and post-write transition.

### 2. A detached process is not a supervised service

`dist/httpLifecycle.js:192` checks for an existing service, then spawns without a per-profile start lock. Concurrent starts can still duplicate expensive loads before only one binds. Readiness defaults to 15 seconds, below the cold-start durations reported in #160. `docs/http-mode.md:205` provides manual Task Scheduler/LaunchAgent/systemd instructions; setup does not install or verify those integrations.

Add an atomic start/attach owner, stale-lock recovery, bounded startup progress, owner-safe failure cleanup, and supported per-user supervisor installation/removal. Verify after login and after a crash. Do not resolve collisions by killing unrelated listeners. Persist one endpoint per profile and make profile/port conflicts explicit.

### 3. Eager imports are paid before any useful answer

`dist/index.js:19` imports the runtime before command dispatch; `dist/tools/index.js` loads every category before the server starts at `dist/index.js:247`. This affects even operational commands. A fast bootstrap must parse version/help/errors first. Split static names/descriptions/schemas from lazy execution imports so discovery returns a complete stable catalog promptly. Do not return a temporarily empty catalog and hope the client notices new tools later. Measure the improvement; the Defender explanation in #160 remains a reported hypothesis, not a proven root cause from this audit.

### 4. Errors lose meaning at the shared boundary

`dist/mcpServer.js:53-76` exposes branded public errors but collapses other failures and diagnostics to safety-worded prose. `dist/errors.js` retains operation causes privately; this provides a place to normalize safe upstream status/reason without exposing credentials or arbitrary internals. Fix this across services, including auth retry classification, rather than special-casing one Gmail query. Return actionable codes for rate limiting, missing resources, permission failures, stale handles, unavailable auth, invalid input, and uncertain write outcomes.

### 5. Configuration has no complete upgrade transaction

Setup defaults to stdio (`dist/setup.js:706`), assumes interactive prompts, and can repair entries but provides no non-interactive end-to-end migration. The version check only logs after startup (`dist/index.js:324`). `status` always checks HTTP; `doctor` treats detected-but-unconfigured clients as faults (`dist/setupInspect.js:184-225`). These are separate defects in the user-facing operational model.

Distinguish Google OAuth credentials from the local MCP bearer token, configured clients from merely installed clients, and running version from installed/latest version. Use the existing client adapters: [Codex HTTP configuration](https://developers.openai.com/codex/mcp/) supports bearer-token environment references; [Claude Code HTTP configuration](https://code.claude.com/docs/en/mcp) has its own type/header shape. Verify credential inheritance from actual GUI launches, not only the shell running setup.

### 6. Test success is broader than transport coverage

The real two-client HTTP test (`tests/twoClientHttpE2E.test.js`) uses synthetic read/edit tools. It is useful transport/state evidence but cannot demonstrate that the four broken production tools work. Add production registration through real HTTP with mocked Google responses, then isolated live API scenarios. Include Windows CI for startup, shell quoting, permissions and service lifecycle; retain Linux coverage and add the Node version used for publishing. Live smoke scripts exist but their presence or static coverage inventory is not proof of a successful live run.

### 7. Documentation and release governance need reconciliation

`docs/plans/README.md` still schedules the already-shipped migration and scoped API imports. `.planning/v3-release-plan.md` retains superseded branch/PR state. `RELEASING.md` says there is no `--help`, although help is implemented. Replace stale operational guidance with one current plan and generated catalog examples, retaining historical documents as clearly dated evidence.

The release workflow checks main ancestry and version agreement, runs tests, packs, then publishes via OIDC. Those are useful controls. However, ancestry does not prove PR review when main is unprotected, and no repository ruleset restricts tag creation. Recommend main and `v*` protection for the intended maintainer set. Respect the deliberate removal of the old required-reviewer gate; do not resurrect #50 as an unsolved setup task without a new decision.

### 8. Closed work retains a small, verified release-blocker ledger

Closure is not sufficient evidence when current behavior contradicts a closed issue or
merged review. The history audit found 10 unresolved threads across 7 PRs, containing
11 comments. Keep the following release-relevant exceptions visible beside the 27 open
issues until their acceptance evidence exists:

- **#73/#127 MIME filename continuations are a release blocker.**
  `.planning/audit-mime-probe.mjs` independently reproduced parser corruption and
  `.planning/audit-mime-result.json` records the failing long ASCII filename with spaces
  and semicolons. `dist/mime.js:403-418` emits unquoted RFC 2231 continuations whenever
  the value does not require extended encoding. The regression at
  `tests/mime.test.js:452-471` exercises a hyphen-only long ASCII name; the quote and
  semicolon test at `:474-479` takes the extended-encoding branch because of the quote.
  Existing live coverage is non-ASCII. Repair the parser-facing encoding/quoting rule,
  add a long ASCII spaces-and-semicolons regression, and prove the exact filename through
  a real Gmail draft create/get round trip. Do not release a MIME claim based only on
  the closed issue/PR status.
- **#135 Sheets creation/copy seeding remains incomplete.**
  `dist/tools/sheets/createSpreadsheet.js:45-67` records `trackRead(spreadsheetId)` even
  after optional `initialData` failed, without a spreadsheet values/revision baseline.
  `dist/tools/drive/copyFile.js:93-102` gives copied Sheets the same metadata-only
  baseline. Treat both paths as one Phase 2 contract: a failed initial-data seed must
  not authorize a subsequent write, and successful create/copy must either obtain a
  trustworthy Sheet baseline or return an explicit reread requirement.
- **#144 is a bounded legacy-path safety residue.** The comment-revision updater can
  pair a newly observed revision with an older tracked structured snapshot when a
  collaborator body edit occurs before its probe and Drive metadata lags. This is not a
  modern read-handle defect. Before legacy `refreshRevision` rearms a record, fetch the
  authoritative structured document and compare it with the stored snapshot; on any
  difference or fetch failure, require reread rather than updating only the revision.
  Fold this invariant into #145 and keep its regression scoped to the legacy updater.
- **#140 is not a release blocker.** `dist/clients.js:127-147` joins
  `reauthInFlight`, so a concurrent request joins the existing reauthorization rather
  than opening a second callback-port race. Keep its regression coverage; do not retain
  an already-fixed OAuth race in the critical path.
- **#147 is not an npm-version/provenance blocker.**
  `.planning/audit-publish-evidence.txt` records a successful published provenance
  statement on Node `v24.20.0` and npm `11.19.0`. Future release checks still need to
  run the supported published workflow, but this historical claim is disproven.
- **#148 is a documentation release gate.** `RELEASING.md:205-208` uses Bash `&&` and
  `/dev/null` in a section that says PowerShell is the supported shell. Replace the
  verification examples with explicitly labelled PowerShell 5.1 and Bash variants, and
  test both command sequences from a clean scratch directory before publication.
- **#146 is a documentation and error-boundary repair.** `CONTRIBUTING.md:52-66`
  presents create/copy seeding as settled while the partial Sheet paths above remain
  untrustworthy. `dist/tools/drive/createDocument.js:193-208` also puts the caught
  `seedError.message` into a caller-visible warning, contradicting
  `CONTRIBUTING.md:82-93`. Correct the implementation and contribution guidance
  together, then add a public-error-boundary regression; documentation must describe
  actual partial-create behavior, not the intended rule.

## Complete disposition of the 27 open issues

Every item below belongs in this release program. "Adjust" means implement the useful outcome while correcting an assumption or impossible guarantee in the request. Exact phase order follows the matrix.

| Issue | Disposition and proposed acceptance |
| --- | --- |
| [#75 HTTP default](https://github.com/karthikcsq/google-tools-mcp/issues/75) | Complete after production tool parity, atomic start/attach, supervisor setup and reversible existing-client migration. A fresh installation and upgraded 2.x/3.x installation must both connect to one verified service. |
| [#130 quality gates](https://github.com/karthikcsq/google-tools-mcp/issues/130) | Implement portable Husky/lint-staged and applicable pre-push checks in separate tooling changes. No invented build/typecheck for dist-only JS; consumer installs must not require dev tools or a Git checkout. Preserve existing CI. |
| [#136 metadata ordering](https://github.com/karthikcsq/google-tools-mcp/issues/136) | Adjust: distinguish metadata anomalies from actual content conflicts. Revision IDs are opaque, not sortable. Comment activity and lagging metadata are not automatically corruption. Re-fetch authoritative content; fail closed where freshness cannot be established. |
| [#137 legacy workspaces](https://github.com/karthikcsq/google-tools-mcp/issues/137) | Move remaining readGoogleDoc/whole-document rewrite paths onto per-handle workspaces. Two clients reading the same doc/tab must receive separate editable files; preserve dirty copies and provide migration/recovery behavior. |
| [#145 revision-only conflicts](https://github.com/karthikcsq/google-tools-mcp/issues/145) | Revalidate relevant content/structure when only revision changes, including target-less writes. Pin the final mutation to the newly observed revision. For the bounded #144 legacy comment-refresh path, compare a freshly fetched full structured snapshot before rearming; a difference or fetch failure requires reread. Comment-only changes succeed; actual overlapping edits fail with useful differences. |
| [#149 HTML comments lost](https://github.com/karthikcsq/google-tools-mcp/issues/149) | Already addressed subject to closure evidence: the issue accepts a caller-visible warning that lists dropped constructs, and `dist/markdown-transformer/markdownToDocs.js:592-597` plus `dist/tools/utils/replaceDocumentWithMarkdown.js:436,491-507` emit warning data including comment source. Add a production response regression for the standalone issue input and close only after it proves the warning reaches the caller; do not invent a new preservation/rejection requirement. |
| [#150 placeholder links](https://github.com/karthikcsq/google-tools-mcp/issues/150) | Detect unresolved template targets before URL normalization. Preserve marker text/intent or reject with a targeted warning before mutation; never emit junk live hyperlinks. Cover encoded variants and ordinary valid links. |
| [#151 soft newlines](https://github.com/karthikcsq/google-tools-mcp/issues/151) | Add explicit newline semantics for literal multiline blocks/signatures, with a documented default. Preserve standard Markdown behavior when selected; verify lines, lists and paragraphs in a live document round trip. |
| [#152 findText](https://github.com/karthikcsq/google-tools-mcp/issues/152) | Add a read-only match operation returning tab, UTF-16 indices, context and revision/handle. Reuse the structural walker; no mutation-error scraping. Cover duplicate matches, Unicode, tables and multiple tabs. |
| [#153 automatic quoted threads](https://github.com/karthikcsq/google-tools-mcp/issues/153) | Separate threading headers from body quoting. Make quoted history explicit; passing threadId alone must not change caller body. Verify create/update/send MIME for text and HTML without duplicated history. |
| [#154 agent setup CLI](https://github.com/karthikcsq/google-tools-mcp/issues/154) | One reusable setup core for wizard and flags. Non-interactive missing inputs return stable JSON/errors, never prompts. Credential inputs via protected files/env; provision config/service independently of browser consent. Document command schemas and exit codes. |
| [#155 protocol support](https://github.com/karthikcsq/google-tools-mcp/issues/155) | Adjust: discovery and legacy support already exist, and setup already writes the Codex stdio env flag. Publish an accurate tested support matrix and explicit deprecation policy. Validate version-error responses; do not remove client-specific settings until supported clients negotiate without them. |
| [#156 writeSpreadsheet HTTP](https://github.com/karthikcsq/google-tools-mcp/issues/156) | Add range-bound Sheets handles and fresh-state checks. Valid handle writes succeed, missing/stale/wrong-resource handles fail, success returns a successor. |
| [#157 batchWrite HTTP](https://github.com/karthikcsq/google-tools-mcp/issues/157) | Extend that contract to every target range; validate the complete write set before sending. Cover multiple tabs, overlapping ranges and concurrent calls. |
| [#158 clearSpreadsheetRange HTTP](https://github.com/karthikcsq/google-tools-mcp/issues/158) | Fix the actual public tool `clearRange`, and correct its documentation names. Validate scope, freshness, clearing outcome and successor handle over HTTP. |
| [#159 deleteFile HTTP](https://github.com/karthikcsq/google-tools-mcp/issues/159) | Mint deletion-capable metadata handles from getFileInfo; bind file identity and observed metadata, distinguish trash/permanent action. Cover already-deleted and shared-drive cases. Do not assume Docs revision controls apply to Drive deletion. |
| [#160 concurrent cold starts](https://github.com/karthikcsq/google-tools-mcp/issues/160) | Shared supervised service plus static catalog/lazy handlers and bounded startup diagnostics. Benchmark fresh install and three simultaneous clients on Windows. A forced process termination cannot always emit its own final log; supervisor observations must cover it. |
| [#161 version flag](https://github.com/karthikcsq/google-tools-mcp/issues/161) | Early --version/-v, version in help, and nonzero unknown-argument exits. Verify with stdin held open that these never open a transport, import all categories, or require credentials. |
| [#162 status semantics](https://github.com/karthikcsq/google-tools-mcp/issues/162) | Report effective transport and separate service/OAuth status. Unconfigured HTTP on a stdio setup is not an unhealthy server; label it not applicable without asserting a spawned stdio process is healthy. |
| [#163 doctor false failures](https://github.com/karthikcsq/google-tools-mcp/issues/163) | Only required/selected registrations affect health. Merely installed but unconfigured clients are informational; configured broken entries remain failures. Absent binaries are already skipped, so that part is not the root fix. |
| [#164 stale global installs](https://github.com/karthikcsq/google-tools-mcp/issues/164) | Expose running/installed/latest versions in doctor and a bounded user-visible update notice. Add managed update with verification, restart and client migration. Never replace code during an arbitrary tool call or silently cross major versions. |
| [#165 opaque API failures](https://github.com/karthikcsq/google-tools-mcp/issues/165) | Normalize safe status/reason and retryability across API wrappers. Distinguish quota 403, permission 403, missing 404 and internal error in tool results and diagnostics. Bounded backoff for retry-safe reads; no blind replay of uncertain writes. |
| [#166 Gmail counts](https://github.com/karthikcsq/google-tools-mcp/issues/166) | Label resultSizeEstimate as approximate. Do not encode a universal 201 cap. Add bounded/paginated count mode returning completeness, continuation and cost; label totals for label-specific questions. |
| [#167 filter explanation](https://github.com/karthikcsq/google-tools-mcp/issues/167) | Explain which current filters appear to match, with match/unknown evidence and unsupported-query reasons. Never claim proof of which historical filter changed a message. Reuse preview matching. |
| [#168 filter preview/replace](https://github.com/karthikcsq/google-tools-mcp/issues/168) | Preview matching samples/count completeness and prospective actions before create. A create result returns the precomputed preview summary and precision, or explicitly says it is unknown; it never runs an unbounded post-create count. Implement recoverable replace only as an explicit `createFirst` or `deleteFirst` multi-step strategy with every completed step and partial outcome reported, never as a fictitious atomic Gmail update. |
| [#169 filter notes](https://github.com/karthikcsq/google-tools-mcp/issues/169) | Store intent notes scoped to Google account/profile and filter ID. Support create with a note and explicit set/clear for an existing filter after verifying that filter still exists. Use atomic local writes, replacement carry-forward, explicit stale/orphan reporting and export/import. Do not imply Google stores the notes or that they automatically roam. |
| [#170 tool ambiguity](https://github.com/karthikcsq/google-tools-mcp/issues/170) | Audit the generated 160-tool catalog, clarify names/descriptions with sibling routing, and consolidate only truly equivalent operations. Keep independent read/write approval boundaries and useful features. Add tool-selection scenarios and alias migration documentation. |

## Proposed implementation sequence

### Phase 1: shared contracts and immediately useful diagnostics

Freeze the modern request context, resource-handle schema, structured error envelope, setup JSON schema, configuration precedence and migration manifest before parallel implementation. Address #161-163/#165 first so every subsequent failure is diagnosable. Add #130 in separate tooling PRs without burying behavior changes in formatting churn. Correct the protocol support documentation (#155).

### Phase 2: complete the state and safety model

Implement #156-159, #137, #136, #145, and the closed #135 Sheets baseline and #144 legacy-refresh residues against one resource-aware handle service. Bind principal/profile/epoch/resource/scope/baseline, expose expiry and successor handles in standard structured output, and ensure reservation/consumption is race-safe. Reads, creates and copies that can lead to writes must all mint useful state. Preserve dirty workspaces through expiry/restart with an explicit recovery path.

The provider contracts differ. [Docs `documents.batchUpdate`](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate) accepts `writeControl.requiredRevisionId` and rejects a stale required revision. [Sheets `spreadsheets.values.update`](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update) documents spreadsheet ID, A1 range and input options, but no revision precondition. [Drive `files.delete`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/delete) documents a file ID and shared-drive support, but no revision precondition. Sheets and Drive handles therefore cannot inherit the Docs `WriteControl` promise. Establish their exact endpoint guarantees using those references and a focused live spike. For Sheets, compare canonical values/formulas and sheet/range identity immediately before writes; serialize this server's overlapping mutations and verify afterward. This catches stale reads and same-service races but cannot alone provide atomic compare-and-swap against an external collaborator between the check and write. State that limit honestly. Use supported conditional requests only where demonstrated. The release must not claim universal atomic conflict protection from a local lock or Drive modifiedTime.

Audit the rest of the mutation catalog for equivalent omissions: append, tab/table deletion, formatting, permission changes, creation seeding and uncertain response recovery. For #135, an `initialData` failure must never be followed by metadata-only `trackRead` authorization; a successful Sheet create/copy must obtain the defined baseline or return a truthful "read before mutation" outcome. For the #144 legacy comment-refresh updater, compare a newly fetched full structured snapshot with the tracked one before rearming; fail closed on a difference or fetch failure. Apply safeguards according to operation semantics, not a blanket requirement to read everything before every action.

### Phase 3: HTTP service, startup and installation migration

Implement #75/#154/#160/#164 together around one durable service identity. Install a per-user supervisor on Windows/macOS/Linux, then start/attach under a lock, authenticate discovery and check the expected executable/version/profile. Publish client configuration only after readiness succeeds. Persist selected clients and support dry-run, repair, uninstall and rollback. Use absolute launch paths, protected secrets, redacted JSON and a stable working directory.

Upgrade flow: inspect old install and client scopes; stage a compatible version; record reversible backups; stop/drain only the owned service; start and verify replacement; rewrite selected owned entries; verify each real client; restore the previous version/config if validation fails. Preserve user-customized entries and report conflicts. No install-time script should unexpectedly edit global client configuration.

Separate the CLI bootstrap and static tool catalog from heavy execution modules. Cold-start work should occur once; first tool execution may load its implementation while cached metadata remains complete and deterministic. Set measured startup/attach budgets before the default flip, rather than merely raising client timeouts.

### Phase 4: document and Gmail behavior improvements

Verify #149's current warning behavior, then implement #150-153, closed MIME residue #73/#127, and #166-169 with representative fixtures and isolated live assertions. Preserve the established caller-visible warning contract for unsupported Markdown constructs rather than replacing it with a new policy. Make partial outcomes visible. Before Gmail filter creation, compute bounded preview output; on creation return that prior summary and its precision or a clear unknown result. Build filter preview, explain, explicit-strategy replacement and notes on shared criteria normalization while clearly distinguishing approximation from evidence. Notes must be editable for existing filters as well as creatable with new ones.

### Phase 5: simplify and deprecate the public surface

Resolve #170 through catalog-driven descriptions, stable schemas and narrowly justified consolidations. Add accurate read-only/destructive/idempotent annotations and structured result fields while preserving readable text for clients that need it. The current facade forwards only description and input schema; it must preserve the new metadata deliberately. Do not merge read and destructive actions into one generic dispatcher if that removes meaningful approval distinctions.

New setup defaults to authenticated loopback HTTP. Stop recommending global stdio/npx-per-session launch. During a documented transition, old explicit stdio registrations may use a thin compatibility adapter to the shared service; they must not keep a second full Google runtime alive. Audit implicit legacy read state before permitting writes through that adapter. Modern requests always carry explicit handles. After the published migration window and client-compatibility gates, remove the full legacy stdio path and obsolete aliases/config synonyms in the announced major version.

Proposed window: at least 90 days after the stable HTTP-first release, with the exact removal release/date in the migration guide. This is a project policy proposal, not a claim that the MCP specification mandates this stdio schedule. Legacy SSE endpoints remain removed. Keep public remote hosting disabled until TLS, MCP OAuth/resource metadata, per-user identity and storage isolation have a separately tested design.

### Phase 6: release verification and publication

Target 4.0.0 for changed defaults and public semantics. Keep fixes in reviewable PRs with per-PR changelog/version discipline, then validate the integrated release candidate. Prerelease publication needs a workflow change: current `npm publish --access public` has no explicit prerelease dist-tag. Route prereleases to `next` (or equivalent) so a candidate cannot become `latest` accidentally.

Required release evidence:

1. All 27 issue dispositions have implementation, meaningful regression tests and an acceptance verdict; correct/reject impossible subclaims explicitly instead of silently ignoring them.
2. Full unit/integration/package/release gates pass on supported Node versions, with Windows coverage for the reported failures. Test the actual packed artifact in an isolated directory.
3. Real HTTP production-tool scenarios prove every formerly blocked read/write flow and stale/expired/reused/cross-profile handles. Synthetic transport tests remain useful but are insufficient alone.
4. Fresh install and upgrades from 2.x and 3.4.6 work in actual supported Claude Code and Codex releases, including GUI credential inheritance and restart. Record client versions rather than assuming one configuration works everywhere.
5. Concurrent start, crash recovery, login startup, owned-stop behavior, port collision, token rotation, upgrade rollback, partial config failure and dirty-workspace recovery are exercised.
6. Use dedicated Google test resources for Docs/Sheets/Drive changes; Gmail send/forward and live filter changes require explicit test scope. Verify API outcomes, not just returned success strings. Record unresolved API limitations.
7. Review the exact candidate independently, address review findings, refresh GitHub issue/comment/thread state, and rerun affected gates after fixes. Publishing a review PR/tag is a later authorized execution step.
8. Verify tag/main/version/lockfile/changelog agreement, package integrity and npm provenance; publish; install the exact registry version and verify discovery plus representative tools; verify `latest` points to the intended release.
9. Reconcile the closed-issue exception ledger. The #73/#127 long-ASCII MIME regression and real draft round trip, #135 create/copy baseline cases, #144 legacy refresh snapshot comparison, #146 public-error and contributor-guide repair, and #148 PowerShell/Bash release instructions must have acceptance evidence. #140 and #147 remain documented disproven historical claims, not blockers.

Do not mark the release complete merely because npm publishing succeeded. Record issue-to-commit/test links and close issues only after their acceptance evidence exists. A change in transport must preserve the intended Google functionality and make existing installations reliably reach it.
