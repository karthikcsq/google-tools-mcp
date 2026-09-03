# Changelog

The format loosely follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/):

- **MAJOR** (`X.0.0`): breaking changes to how the server is configured,
  launched, or spoken to (transport, protocol version, removed endpoints or env
  vars, changed tool contracts, Node floor).
- **MINOR** (`0.X.0`): a new tool, a new user-facing capability, or a new CLI
  command or option.
- **PATCH** (`0.0.X`): bug fixes, docs, refactors, dependency bumps, test and
  harness work, and other small changes.

Each entry is **one logical change**: a merged pull request (all its commits
collapsed into one version bump) or a standalone direct commit to `main`,
recording **what changed**, **who contributed it**, and the **PR or commit** it
came from. Planning notes under `docs/plans/` and `.planning/` are not logged.
The 2.0.0 entry predates this convention and collapses thirteen pull requests
into one release.

## [3.4.4] - 2026-09-03

PR [#146](https://github.com/karthikcsq/google-tools-mcp/pull/146) by
[@ElliotDrel](https://github.com/ElliotDrel): `CONTRIBUTING.md`; version 3.4.4.

### Added

- `CONTRIBUTING.md` (#138): the rules a change has to follow that no single
  file in the repo stated. The read-before-write model (`guardMutation`, the
  fifteen Docs tools that open a lease through `beginDocsMutation`, the three
  Sheets tools and `deleteFile` that call the guard directly, and how a read
  handle differs from the in-process tracker), the seeding rule for any tool
  that creates or copies a file ("trustworthy or not at all", with the #135
  `createSpreadsheet` / `copyFile` gap as the reason the rule is written down),
  the working-copy lifecycle (which copy is canonical, rewrite, staleness,
  cleanup and retention), the error boundary (caught error text never reaches
  `publicError` or a persisted diagnostic), how to read a test run (`Test
  Suites:` is the line that matters, since a suite that fails to link reports
  zero failed tests), the inventory snapshot, the one-entry-per-PR changelog
  and version bump, and the live-testing safety boundary. Every file, function,
  anchor, and test named in it was checked against `main` before it landed.
  `README.md` and `docs/README.md` link to it.

## [3.4.3] - 2026-09-02

PR [#144](https://github.com/karthikcsq/google-tools-mcp/pull/144) by
[@ElliotDrel](https://github.com/ElliotDrel): Comment tools no longer leave the
next Docs write refused as a revision conflict; per-PR changelog; version 3.4.3.

### Fixed

- **A body write after our own comment tools was refused as a conflict.**
  Every Drive comment write (`addComment`, `replyToComment`, `resolveComment`,
  `updateComment`, `deleteComment`) advances the Docs `revisionId` but leaves
  Drive's `modifiedTime` exactly where it was (measured live: `modifiedTime`
  identical across all three while `revisionId` changed each time). The read
  tracker's external-change check compares only `modifiedTime`, so it passed,
  and the next `appendText` or `replaceDocumentWithMarkdown` went out pinned to
  the pre-comment revision. Google refused it and the caller was told "This
  document (...) changed since you last read it" when the only change was the
  comment they had just added. The five comment tools now re-arm the tracked
  revision after they succeed (one `documents.get` for `revisionId`, only when
  the document was read in this session); the content snapshot and
  `modifiedTime` are kept because the body did not change. A refresh that
  fails is logged and leaves the old revision in place, so that write still
  fails closed (conflict, then re-read) rather than open. Found by the
  `verify-comment-collateral` live mission on its first run; that mission now
  asserts a body write after each of the five tools goes through with no
  re-read.

### Changed

- This file now records one entry per merged pull request or standalone
  direct commit, with its own semantic version, in the format described at the
  top. The single `3.0.0` section that had accumulated every change since 2.0.0
  is split into the twenty entries from 2.0.1 to 3.4.2, each attributed to its
  PR or commit and author and dated by its merge. No bullet was dropped;
  bullets that later PRs had amended in place are split so each entry reads as
  it was when its PR merged. `package.json` and `package-lock.json` move from
  the never-published 3.0.0 to 3.4.3, the version at the top of this file.
- `RELEASING.md` describes the per-PR changelog: the version at the top of
  this file is the one to tag, and the PR that bumps `package.json` is the one
  whose entry carries that version.

### Testing

- `tests/commentRevisionRefresh.test.js` drives all five comment tools against
  fake clients and asserts the tracked revision moves to the post-comment
  value, the content snapshot survives, an unread document is never probed, a
  failed probe keeps the old revision, and a failed comment write refreshes
  nothing.
- `live/missions/verify-comment-collateral.mjs` proves #141 (a reply is
  counted) and #142 (a dry run and a real replace both name the comment anchor
  they remove, and `onCollateral='block'` refuses before touching the
  document) against the real API, alongside the write-after-comment check
  above. `updateComment` and `deleteComment` are driven live for the first
  time, so `live-coverage` now reports 31 tools driven live and 129 with unit
  tests only.

## [3.4.2] - 2026-09-02

PR [#143](https://github.com/karthikcsq/google-tools-mcp/pull/143) by
[@ElliotDrel](https://github.com/ElliotDrel): Pre-publish review of the
2026-09-01 main changes: eight fixes before v3.0.0.

### Fixed

- **`setup` and `doctor` could not finish on any machine that had Codex or
  Claude Code installed.** Both clients report a missing registration as a
  failed command (`codex mcp get google --json` exits 1 with "No MCP server
  named 'google' found."), and every rejection was mapped to `unknown` without
  reading it, so setup stopped at Step 5 with "was left unconfigured (unknown).
  Setup is incomplete." and doctor said "unrecognized client entry". The Claude
  Code probe was worse: `claude mcp get -s user google --json` is answered by
  every version with `error: unknown option '-s'`, so inspection was `unknown`
  on every machine. A rejection whose text says "missing" now means missing,
  and Claude Code's user-scope entry is read from the file `claude mcp add -s
  user` writes (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`), with
  its `type: 'stdio'` discriminator and empty `env` stripped so a correct entry
  compares equal to the desired one instead of being re-added on every run.
- **`doctor` reported every README-documented registration as a problem.** Its
  "recommended" stdio entry is the absolute path of the copy running doctor,
  while setup writes `node <global npm root>/google-tools-mcp/dist/index.js`
  and the README's own instructions register the bare `google-tools-mcp` bin
  or `npx -y google-tools-mcp`. All three were "entry differs from recommended
  configuration", exit 1, including `npx -y google-tools-mcp doctor` run right
  after a successful setup. An entry that launches this package (its bin, a
  Windows shim, `npx google-tools-mcp[@version]`, a `dist/index.js` next to a
  `google-tools-mcp` package.json) is now `configured` with a note saying it is
  not the entry setup would write, and the npx form additionally says why setup
  prefers a direct launch. A Codex entry without `CODEX_MCP_PROTOCOL_VERSION`
  in its env stays a problem, and now names the missing variable and value. An
  entry that launches something else, a `@latest` target, or an HTTP URL that
  differs is still a problem. So is an entry that launches this package with a
  subcommand or flag after it (`google-tools-mcp doctor`, `npx google-tools-mcp
  setup`, `dist/index.js auth`), because `dist/index.js` dispatches on
  `argv[2]` and such an entry never starts the server, and one whose env sets
  `GOOGLE_MCP_TRANSPORT` to an HTTP transport.
- **`doctor --json` printed `"args": "[Circular]"` for the second client.** The
  diagnostic redactor treated every object it had already seen as a cycle, so
  the `args` array the two recommended entries share was replaced on its second
  appearance. It now tracks ancestors only: a true cycle still prints
  `[Circular]`, a shared reference prints its value.
- **The update check hit the npm registry on every launch.** `checkForUpdate`
  read and wrote its cache through injectable `readFile`/`writeFile`/`mkdir`
  parameters whose defaults were never set, so outside the unit tests every
  cache read threw, was swallowed, and the registry was asked again. The
  defaults are the real `node:fs/promises` functions, and a test now proves a
  second launch within the TTL makes no network request.
- **`logout` and re-authorization could still race the auth latch that 3.4.1
  introduced.** Each flow now releases only the latch it owns: `logout` drops
  the latch mid-flow and the next request starts a fresh one, and when the
  abandoned flow later fails it must not clear that newer latch, or a third
  request would open a third browser window behind the one the user is already
  looking at. Nor may the abandoned flow *succeed*: `logout` bumps an
  authorization generation, and a flow that started under the old one throws
  `Logged out while authorization was in progress` instead of installing a
  client the user has just asked to discard, whichever flow finishes last. A
  cold request that arrives while a re-authorization is running joins it rather
  than opening a second consent screen beside it.
- **`help tool=X` reported optional fields as required.** The schema it returns
  is now rendered the same way the SDK renders `tools/list` (`io: 'input'`,
  draft 2020-12): the first cut used Zod's bare `toJSONSchema()`, whose default
  is the *output* schema, so every `.optional().default(x)` field came back as
  `required`. For 50 of the 160 tools that contradicted `tools/list`;
  `readDocument` alone claimed all seven of its optional fields were mandatory.
  A test now pins `help`'s schema to the SDK's conversion for every registered
  tool.

### Testing

- `npm run live-coverage` now reports 29 tools driven against the real Google
  API by checked-in code and 131 with unit tests only, and exits non-zero if it
  finds no covered tools at all (a silent zero means the scan broke, not the
  coverage). Calls through the `ctx.createDoc()` and `ctx.createFolder()`
  helpers are credited to `createDocument` and `createFolder`, any quote style
  around a tool name counts, and `live/missions/archive/` is skipped: it holds
  the frozen iteration-1 and iteration-2 transcripts, which record what the
  agent hit at the time and are not expected to pass on fixed code (loop-2
  sends the nested `formatCells` shape that 3.0 rejects by design). A mission
  whose purpose is to prove a guard deny still holds exports
  `expectsSafetyRefusals = N`, and exactly `N` refusals are forgiven in its
  report, no more.
- The cleanup loop is now one shared implementation
  (`scripts/live-smoke/cleanup.mjs`) instead of two copies, because both copies
  had the same holes: a file the run had already deleted was reported as left
  behind (the containment check ran before the existence check, and an
  unreadable file is "not proven inside"); an `invalid_grant` rebuild inside
  the run's last call left the raw Drive handle null so every trash failed with
  a `TypeError`; a guard refusal was counted as neither pass nor fail; and a
  mission that `track()`ed an id the runner had already registered made
  cleanup say `2/2` for one file. After cleanup both runners now list the test
  folder and any leftover drafts and fail on anything this run left there, and
  `--keep` prints each kept id with the `npm run live-call -- --cleanup <ids>`
  command that trashes them later.
- The set of tools `live-coverage` reports as "denied by `guard.mjs`" is derived
  from the guard's own deny table and read-only deciders (`MUTATING_VERB` is now
  exported for that) rather than a hand-maintained list beside it, so the two
  cannot drift. The created-resource pin test executes all eight creating tools
  against fake clients and feeds their real return values to the shared id
  extractor, replacing a test that only compared two hand-written literals.
- `verify-preserve-heading` probe 3 deletes a heading on purpose; its verdict
  logic expected the heading to survive and reported false friction on every
  run. The probe now states which outcome it expects.
- The post-cleanup audit fails closed. It listed only the top level of the test
  folder, so a file inside a folder the run created was hidden behind its
  parent; a listing that threw came back as an empty array; a listing the tool
  cut short was read as complete; and any `getDraft` error (auth, quota,
  network) was taken as "the draft is gone". The scan is now recursive
  (`depth: 'all'`, up to 5000 items), and a listing that could not be made, was
  truncated, or skipped a folder it could not read is reported as `UNVERIFIED`
  and fails the run. Only an error carrying a real 404 status counts as a
  deleted draft; anything else is reported per draft and fails the run too.
  Covered by `tests/liveHarnessCleanupAudit.test.js`.
- Seven suites now call `registerAllTools` (up from four in 3.4.0), all inside
  the 30s `testTimeout`.

### Docs

- The README's Codex registration commands carry
  `--env CODEX_MCP_PROTOCOL_VERSION=2026-07-28` and say why, and its tool-count
  section describes `help` with `tool: "<name>"` and `listTools: true` and
  recommends the per-tool form first.

## [3.4.1] - 2026-09-01

PR [#140](https://github.com/karthikcsq/google-tools-mcp/pull/140) by
[@ElliotDrel](https://github.com/ElliotDrel): Fix six pre-tag review findings,
five verified and one disproven.

### Fixed

- **A busy OAuth callback port hung the whole sign-in instead of reporting
  itself.** `authenticate()` awaited `server.listen()` on a Promise with no
  rejection path, and `listen` reports failure by emitting `error`, never by
  throwing. With `GOOGLE_MCP_OAUTH_PORT` set to a port already in use, the flow
  never settled: the `EADDRINUSE` went to the process-level handler in
  `index.js`, which logs and returns, and the caller waited forever. The
  `port_in_use` remedy `clients.js` has always carried was unreachable as a
  result. It now rejects with that remedy named, and the port in it.
- **Authentication was not concurrency-safe, and HTTP mode is concurrent.**
  `ensureAuth()` checked `authClient` and then awaited, with nothing holding the
  gap, so requests arriving before the first authorization finished each started
  their own — six concurrent cold requests produced six authorizations, which on
  a cold machine means six browser windows racing for one loopback port.
  `reauthorize()` had the same hole and a worse consequence: a revoked refresh
  token fails every in-flight call at once, and each failure nulled the shared
  clients out from under the others mid-rebuild. Both now hold the in-flight
  Promise, and both release it when it settles, so a declined consent screen is
  never replayed to the next caller.
- **`GET /healthz` reported a closed runtime as healthy.** The health branch sat
  above the `closed` check, so a drained handler answered `200 {"status":"ok"}`
  while `/mcp` already answered `503` — the one probe meant to notice a dead
  runtime was the only route that never did. It now answers
  `503 {"status":"closed"}`, still behind the same auth gate.

### Security

- **The OAuth callback is now bound to the request that started it.** The
  loopback redirect server accepted any request carrying a `code`, and the
  authorization URL carried no `state`. During the five-minute sign-in window,
  a page the user happened to visit could point their browser at
  `http://localhost:<port>/?code=<the attacker's code>`; the exchange succeeded
  and this server persisted the **attacker's** refresh token, so every later
  tool call ran against someone else's Google account while looking entirely
  normal. `authenticate()` now issues a random `state`, compares it in constant
  time on return, and ignores any callback that does not match — ignores rather
  than rejects, so nobody who can reach the port can cancel a sign-in that is
  still in progress. PKCE (`S256`) is sent on the same flow, so an
  authorization code observed on the loopback redirect is useless without the
  verifier, which never leaves the process. Matches
  [Google's OAuth guidance](https://developers.google.com/identity/protocols/oauth2/resources/best-practices).

### Testing

- The live harness could leave real files in a real Drive and still report a
  clean run. `live-mission` and `live-call` each kept their own copy of the
  "tools that create something" map, under a comment saying the two were kept in
  sync, and both then read `JSON.parse(result).id` and nothing else. That
  silently dropped two of the eight tools they listed: `createPresentation`
  answers with `presentationId`, and `createDocumentFromTemplate` answers in
  prose, so `JSON.parse` threw and the id was discarded. Anything not registered
  is never trashed, and the cleanup line still printed `N/N` because `N` only
  counted what the runner had noticed. One shared extractor now handles every
  shape including the prose form, and a creating call whose id cannot be found
  is reported as `UNTRACKED` and fails the run rather than passing quietly.
- `live-coverage` reports tools that provably cannot reach Google separately
  rather than counting them as covered, because a scenario names them only to
  assert the refusal holds: `forwardMessage`, which the runner blocks before
  `execute()`, and `createPresentation`, which `guard.mjs` denies outright
  because the Slides API creates in Drive root whatever parent it is given.

### Docs

- Three places where the docs contradicted the code, corrected in the text that
  now sits under the 3.0.0 and 3.4.0 entries: the release notes and README
  promised stdio users nothing changes, while `docs/http-mode.md` said a Codex
  stdio registration needs `CODEX_MCP_PROTOCOL_VERSION=2026-07-28` (it does,
  and the 3.0.0 intro now says so); three places promised `GET /healthz`
  returns exactly `{"status":"ok"}` when it returns a load-bearing `pid` that
  `setup` and `status` compare against the state file; and the `#000001`
  round-trip loss in `readDocument(format='markdown')` is stated as a known
  limitation rather than left implicit.

## [3.4.0] - 2026-09-01

PR [#139](https://github.com/karthikcsq/google-tools-mcp/pull/139) by
[@ElliotDrel](https://github.com/ElliotDrel): Live agent loop, and the five
defects it found.

### Added

- **`help` can now return one tool at a time.** `help` previously returned the
  entire 39,279-character README on every call, which is enough to push a real
  agent into skipping discovery and guessing argument names. `help` now accepts
  `tool` (returns that tool's description and JSON Schema, ~3,000 characters)
  and `listTools` (just the registered names). Calling it with no arguments
  still returns the full manual, so nothing that worked before changed.

### Fixed

- **`readDocument(format='markdown')` wrapped every run in a colour span nobody
  asked for, which made read-back verification impossible.** #14 requires every
  run this server writes to carry an explicit `foregroundColor`, and Google's
  Color endpoint drops an all-zero RGB value, so the fallback is the nearest
  representable explicit black: `#000001`. That landed on every run of every
  document created from markdown, and the reader echoed it back as author
  intent. A document created from `## Next steps` read back as
  `## <span style="color:#000001">Next steps</span>`. The reader now suppresses
  that one sentinel value, which is indistinguishable from black on screen and
  means "no colour was chosen" by construction; a colour the author actually
  picked still exports, and other styling on the same run is untouched. Found
  by the live agent loop, whose agent read the mangled markdown, concluded its
  own edit had deleted the heading, and spent three documents and seven calls
  chasing a data-loss bug that was never happening.

  Known limitation, stated plainly: text a human deliberately coloured
  `#000001` now exports without its colour span. There is no way to avoid this.
  Google's API drops an all-zero RGB value, so #14 forces *some* non-zero
  stand-in for "explicitly the default", and whichever value is chosen is a
  colour a person could in principle pick. The trade is one indistinguishable-
  from-black shade against a reader that was unusable for verification on every
  document this server writes.
- **`modifyText` rejected a wrong-shaped `target` with an unreadable union
  dump.** Passing `startIndex`/`endIndex` at the top level (the natural mistake
  for anyone who has not seen the schema) produced three parallel branches each
  saying "expected object, received undefined", which reads as "you passed
  nothing" to a caller who passed plenty. The union now carries an explicit
  message naming all three accepted shapes and showing the nesting, with the
  wrong form next to the right one.
- `documentEnd` in a `format='index'` read is now documented as what it is: one
  past the last addressable index, because the Docs body always ends with a
  final newline no range may cover. The README said element ranges "can be
  handed straight to a mutating tool", and a caller reasonably extended that to
  `documentEnd` and got a rejection. Use `documentEnd - 1`.
- **`readDocument(format='index')` was rejected by Google for every document,
  including an empty one.** The field mask asked for
  `lists(listProperties(nestingLevels(glyphType)))`, but `Document.lists` is a
  `map<string, List>` and Google's field-mask syntax does not allow
  sub-selecting inside map values, so `documents.get` failed the whole request
  with "Request contains an invalid argument. (Code: 400)". The mask now names
  `lists` whole. No unit test caught this because every Docs test mocks
  `documents.get`, and a mock cannot validate a field mask; all 92 suites passed
  before and after. Found by the live agent loop, on the first mission.
- **`formatCells` now names its accepted arguments when none are supplied.**
  The tool takes flat options with hex-string colors, not the nested Google
  Sheets API `CellFormat` shape, which is what a caller who knows the underlying
  API reaches for first. When they did, every key landed in the unknown-key
  bucket and the old message ("At least one formatting option must be
  provided.") read as "you passed nothing" while they had in fact passed a full
  format object. The message now lists the seven real options and shows the
  wrong-shape example next to the right one.

### Testing

- **The live agent loop.** `npm run live-mission` runs a whole multi-step task in
  one process against the real Google API, written by an agent that was given a
  goal rather than a script. This closes a structural gap: `live-call` starts a
  fresh process per call, so the read tracker and read handles die between them,
  making create-then-write (the most common real agent workflow, and the subject
  of #87 and #135) impossible to prove. The runner records every call, failure,
  retry, and friction note to a JSON report. Protocol in
  [`.claude/skills/live-agent-loop/SKILL.md`](.claude/skills/live-agent-loop/SKILL.md),
  reference in [docs/live-agent-loop.md](docs/live-agent-loop.md).
- `npm run live-coverage` reports which of the 160 registered tools are driven
  against the real Google API by checked-in code (28) and which have unit tests
  only (132), and exits non-zero if a scenario calls a tool that is no longer
  registered. It runs offline, registering every category against a recording
  stub. The point is that "all suites pass" and "this tool works" are different
  claims, and the gap between them should be a number rather than a feeling.
- Jest `testTimeout` raised to 30s. The four suites that call `registerAllTools`
  dynamically import all 12 tool categories (~180 modules): about 750ms warm, but
  measured past Jest's 5s default against a cold filesystem cache. That is
  exactly the CI shape, since both workflows run `npm ci` and then the suite, and
  it reproduced on 1 of 3 cold cycles while never failing across 12 consecutive
  warm runs. The module loading is legitimate work, so the time budget was what
  was wrong.

## [3.3.6] - 2026-08-31

PR [#135](https://github.com/karthikcsq/google-tools-mcp/pull/135) by
[@ElliotDrel](https://github.com/ElliotDrel): Seed read state after
createSpreadsheet and copyFile (#87).

### Fixed

- `createSpreadsheet` and `copyFile` now seed read-tracker state, so creating a
  spreadsheet or copying a file and immediately writing to it no longer fails
  with "this file has not been read in this session". Sheets writes are guarded
  (`writeSpreadsheet`, `batchWrite`, `clearSpreadsheetRange`), so this made the
  most obvious workflow those tools have unusable. Docs copies re-fetch content
  and revision and mint a read handle; Sheets copies and creates record the same
  metadata-only baseline `readSpreadsheet` does; binary copies stay deliberately
  unseeded, because claiming a read that never happened would convert a loud
  rejection into a silent overwrite (#87, #135).

## [3.3.5] - 2026-08-31

PR [#133](https://github.com/karthikcsq/google-tools-mcp/pull/133) by
[@ElliotDrel](https://github.com/ElliotDrel): Name the Google Cloud API in Maps
authorization failures (#128).

### Fixed

- Maps authorization failures now name the specific Google Cloud API that needs
  enabling (Places API (New), Geocoding API, or Routes API), derived from the
  request URL, plus the console pages for enabling it and for checking key
  restrictions. `PERMISSION_DENIED`, `REQUEST_DENIED`, and bare `403` all
  qualify; every other error is byte-identical to before. Previously the message
  was "The caller does not have permission", which reads as broken OAuth when
  the real cause is a separate, unconfigured `GOOGLE_MAPS_API_KEY` (#128, #133).

## [3.3.4] - 2026-08-31

PR [#134](https://github.com/karthikcsq/google-tools-mcp/pull/134) by
[@ElliotDrel](https://github.com/ElliotDrel): Clear all production and dev npm
audit findings (#129).

### Security

- **Seven production `npm audit` findings cleared, and the manifest floors moved
  past the vulnerable ranges** (#129). `hono` advances 4.12.9 to 4.13.5 and
  `markdown-it` 14.1.1 to 14.3.1, pulling their affected transitive dependencies
  (`@hono/node-server`, `@xmldom/xmldom`, `linkify-it`, `qs`) with them. Bumping
  only the lockfile would have left `hono: ^4.11.4` and `markdown-it: ^14.1.1`
  in `package.json`, so a consumer resolving fresh could land back inside the
  advisory range; the declared floors moved too. `diff` advances 7.0.0 to 9.0.0
  after checking every `diffLines`/`createPatch` call site in this repository
  against v7, v8, and v9 output for all four label shapes the Docs diff path
  produces. The v9 changes are confined to `parsePatch` and `formatPatch`,
  which this server never calls.

## [3.3.3] - 2026-08-31

PR [#132](https://github.com/karthikcsq/google-tools-mcp/pull/132) by
[@ElliotDrel](https://github.com/ElliotDrel): Release 3.0.0: version bump,
changelog, and a real publish gate.

### Changed

- `package.json` and `package-lock.json` move from 2.0.0 to 3.0.0 via
  `npm --no-git-tag-version version major`. The tag is created separately once
  the bump is on `main`, per RELEASING.md.
- **The publish workflow fails fast when the approval gate is not configured.**
  `environment: npm-publish` on the publish job read as an approval gate whether
  or not anyone had set one up, because GitHub creates a referenced environment
  on demand with no protection rules. The `validate` job now asks the API
  whether `required_reviewers` is set on `npm-publish` and fails with fix
  instructions if it is not, or if the API cannot be read. The check runs in
  the ungated job on purpose: a check inside the gated job cannot catch a
  missing gate, because the gate is what would have paused it. Configuring the
  environment still needs repo admin (#50).

### Testing

- Three suites pinned `serverInfo` to the literal `'2.0.0'` and went red on the
  bump. They now read the version from `package.json`, and a new assertion
  checks that value is real semver so the comparison cannot pass on two
  `undefined`s.

### Docs

- The Unreleased changelog section cited 11 issues when 28 had shipped; the 19
  missing ones were added along with a **Security** heading, and RELEASING.md
  documents that the workflow now enforces the `npm-publish` gate.

## [3.3.2] - 2026-08-31

PR [#131](https://github.com/karthikcsq/google-tools-mcp/pull/131) by
[@ElliotDrel](https://github.com/ElliotDrel): Replace the umbrella googleapis
package with per-API @googleapis/* packages.

### Changed

- The umbrella `googleapis` dependency is replaced by the ten per-API
  `@googleapis/*` packages the server actually uses (#71). Installed size drops
  from 195 MB across 1,823 files to 8.1 MB across 148, `node_modules` as a whole
  from 303 MB / 11,591 files to 117 MB / 9,916, and cold import from roughly
  1,120 ms to 149 ms. `npx` re-verifies the tree per file on every launch, so
  the file count is paid back on every start.

### Docs

- `docs/architecture.md` and `docs/startup-performance.md` describe the
  umbrella package as removed and carry the measurements above, and the two
  README passages that blamed the full `googleapis` client library for slow
  `npx` launches no longer make that claim.

## [3.3.1] - 2026-08-30

PR [#127](https://github.com/karthikcsq/google-tools-mcp/pull/127) by
[@ElliotDrel](https://github.com/ElliotDrel): Live smoke: run every filed
issue's repro against real Google before merging.

### Testing

- **The live smoke harness.** `npm run live-smoke [cluster|scenario ...]` runs
  22 scenarios under `live/{docs,drive,gmail,checklist}/` against real Google
  Docs, Drive, and Gmail, one per filed issue that described concrete steps,
  doing what the reporter did in the order they gave it. Scenarios call
  `execute()` on tool definitions in-process with real auth, so an agent on a
  branch can run its own repro against its own change without a client
  restart. Each scenario declares `expectedOnBase`, so the table shows both
  what happened and whether that is the known-broken behaviour of the base.
  `npm run live-call <tool> '<json>'` pokes a single tool without writing a
  scenario, and every call is appended to a gitignored JSONL journal. The
  safety layer (`scripts/live-smoke/guard.mjs`) is enforced in code: the
  runner refuses to start without `GOOGLE_MCP_TEST_FOLDER_ID`, every mutating
  Drive/Docs/Sheets/Slides call on an existing id has its parent chain verified
  to reach the test folder, `sendMessage`, `sendDraft`, `replyMessage`, and
  `forwardMessage` throw before reaching the API, cleanup trashes exactly the
  ids the run created, and tool stdout is captured and any leak counted. How to
  run it and how to add a scenario are in
  [docs/live-smoke.md](docs/live-smoke.md). Run against a build with every
  cluster fix, it found five fixes that were reported as done, had passing unit
  tests, and did not work.

## [3.3.0] - 2026-08-30

PR [#113](https://github.com/karthikcsq/google-tools-mcp/pull/113) by
[@ElliotDrel](https://github.com/ElliotDrel): Recursive Drive folder listing,
plus test and packaging gaps.

### Added

- `listFolderContents` gains `depth` and `maxItems` for bounded recursive
  traversal (#99). Mapping one subtree previously took 14 sequential calls. A
  single-page listing that hit its cap now says so through `truncated` and a
  `truncationReason` naming the fix, instead of silently returning a short list.

### Fixed

- `copyFile` no longer ignores its `name` parameter (#124).
- `listFolderContents` scopes depth-1 listings to the shared drive that contains
  the folder (#126). The originally filed symptom, empty results for every
  second-level subfolder, did not reproduce under four independent lines of
  investigation; the real adjacent defect was silent truncation, now reported.
- `createDocument` whose initial content failed to insert reported plain
  success; it now reports the document as created with the content failure
  stated.
- A test file living inside `dist/` shipped in every npm release. It is
  removed, its unique assertions kept, and a packaging test now fails if a
  non-runtime file returns to the tarball.

### Security

- **Re-authentication could report success without replacing the refresh token**
  (#115). `authenticate()` now requests re-consent on every call, including the
  explicit `google-tools-mcp auth` path and the `invalid_grant` recovery path,
  and throws instead of reporting "Authentication successful!" when the exchange
  returns no refresh token. The token file is written atomically and chmodded
  `0600`, and its directory `0700`.

## [3.2.0] - 2026-08-30

PR [#112](https://github.com/karthikcsq/google-tools-mcp/pull/112) by
[@ElliotDrel](https://github.com/ElliotDrel): Ops: config file layer,
convergent setup and doctor, structured diagnostics, HTTP lifecycle.

### Added

- A shared machine configuration file is loaded before startup and applied
  across MCP clients (#82), so settings no longer have to be duplicated into
  every client's config block.
- Diagnostics are actionable rather than decorative (#91): structured
  tool-call logs, startup timing visible where the README says to look, and a
  troubleshooting runbook. Caller-supplied text never reaches persisted
  diagnostics.
- `setup` and `update` are idempotent and repair existing client configs
  instead of appending duplicates or leaving a half-written entry (#48).
- `doctor`, a CLI subcommand that reports the same findings `setup` would act
  on without changing anything, judged against the registration setup would
  actually install, so a missing entry is a problem rather than a pass.

### Changed

- HTTP mode can be operated: the bearer token persists instead of being
  regenerated each run, so a registered client keeps working across restarts;
  `start`, `stop`, `restart`, and `attach` behave predictably, including on a
  port collision, and `attach` refuses a server whose configuration does not
  match what was asked for; `status` authenticates as a real client and reads
  identity from the protocol response. A Codex registration now carries
  `CODEX_MCP_PROTOCOL_VERSION`, without which Codex silently pins this server
  to the old lifecycle.

### Security

- **The `feedback` tool could execute arbitrary shell commands through a crafted
  issue title** (#114). Titles and bodies were interpolated into a `gh` command
  string, so shell metacharacters in user-supplied text reached the shell. Every
  `gh` invocation now passes an argv array to `execFile` with no shell involved.
- **The three browser-open helpers no longer build shell command strings around
  a URL** (#125). `start`, `open`, and `xdg-open` were invoked through a shell
  with the URL concatenated in; they now go through a shared `runArgv` helper
  that passes the URL as a single argv element.

## [3.1.1] - 2026-08-30

PR [#111](https://github.com/karthikcsq/google-tools-mcp/pull/111) by
[@ElliotDrel](https://github.com/ElliotDrel): Gmail: RFC-correct MIME
assembly, dead module removal, shared format dispatch.

### Fixed

- **Gmail messages are now standards-compliant MIME** (#73, closing #54). All
  header and body construction moved into a new `dist/mime.js`, and every send,
  draft, reply, and forward path routes through it:
  - Non-ASCII Subjects and To/Cc/Bcc display names become RFC 2047 base64
    encoded-words, chunked on UTF-8 character boundaries and separated by
    folding whitespace, so a wordless CJK or emoji subject now folds legally
    instead of shipping as one line past the 998-octet limit. Addr-specs,
    Message-IDs, and unsupported address shapes are never encoded.
  - Attachment `Content-Type` and `Content-Disposition` use RFC 2231/6266
    `filename*` with numbered continuations for long or Unicode names, plus a
    sanitized quoted ASCII fallback. A filename or `mimeType` can no longer
    inject a header: CR/LF never survive, and `mimeType` is validated against
    the RFC 2045 grammar and rejected outright when it does not match.
  - `Content-Transfer-Encoding: quoted-printable` is now true. Text and HTML
    single-part bodies are really quoted-printable encoded (8-bit octets, `=`,
    control bytes, and trailing whitespace escaped; CRLF normalized; no line
    over 76 characters). Multipart body and attachment payloads are base64
    wrapped at 76 per RFC 2045 §6.8.
  - Multipart boundaries are derived from the content they delimit and verified
    not to occur in it, replacing a timestamp-plus-random string nothing ever
    checked. The same message now produces the same bytes.
  - ASCII-only messages are otherwise byte-compatible.
- `createDraft` and `updateDraft` no longer double-decode quoted-printable,
  which was stripping every `=` from the body (#116).

### Removed (internal)

- `dist/tools/drafts.js`, `labels.js`, `messages.js`, `settings.js`,
  `threads.js` — pre-consolidation Gmail tool forks left over from the
  `dist/tools/gmail/*` consolidation. Never imported (`dist/tools/index.js`
  always loaded Gmail tools via explicit `./gmail/*.js` paths); nobody could
  have been depending on a deep import of these paths, since none of the
  five ever registered a tool the server actually exposed. (#74)

## [3.1.0] - 2026-08-30

PR [#110](https://github.com/karthikcsq/google-tools-mcp/pull/110) by
[@ElliotDrel](https://github.com/ElliotDrel): Docs cluster: structural reads,
section rewrites, atomic batches, precise conflict guarding.

### Added

- `readDocument` gains `format='index'` (#105): a compact structural map of the
  document — headings with levels, list items with nesting and orderedness,
  tables with per-cell indices, section breaks, horizontal rules, inline object
  anchors — carrying the raw `startIndex`/`endIndex` every index-addressed tool
  needs. It fetches a narrow field mask rather than `fields:'*'`, including for
  tabbed documents, and it mints a `readHandle` like any other read. Paginates
  at element boundaries via `maxResponseChars` / `fromIndex` / `nextFromIndex`.
  Every tool description and error string that used to recommend `format='json'`
  for index discovery now names `format='index'`.
- `readDocument` gains `stripInheritedStyles` (opt-in, `format='json'` only),
  which drops inherited `textStyle`/`documentStyle`/`namedStyles` and every
  `suggested*` map while preserving every index.
- `replaceRangeWithMarkdown`: replaces an index range in a Google Doc with
  parsed Markdown in one call, instead of a `deleteRange` + `appendMarkdown`
  pair. Part of replacing destructive full-body rewrites with safe structured
  editing (#88).
- `updateComment`: edits the body of an existing Google Docs comment.
- `batchModifyText`: applies multiple `modifyText`-style edits to a document
  in a single call, so multi-edit workflows no longer need one round trip per
  edit.
- `listHeadings`: returns the document's heading outline (text, level, and
  `startIndex`/`endIndex`) without paginating through the full `format='index'`
  structural map.
- Text inserted by this server now carries the document's `NORMAL_TEXT`
  foreground color explicitly across every insertion tool — `insertMarkdown`,
  `modifyText`, `batchModifyText`, `appendText`, `createDocument`'s raw path,
  and `insertTableWithData` — instead of leaving it to inherit (#14).
- `readDocument` gains `plainMarkdown`: return a plain-text variant of the
  response body while the rich markdown still mints the read handle, seeds the
  local working-copy file, and feeds diffing/tracking, so a plain read can
  never cause a later push to drop existing formatting (#96).
- `applyParagraphStyle` gains `bulletNestingLevel` (0-8): set a paragraph's
  list depth explicitly by resolving whole-paragraph ranges and emitting
  `deleteParagraphBullets` / leading-tab adjustment / `createParagraphBullets`
  in one batchUpdate, with `bulletPreset` to set the glyph style explicitly
  (#107).
- `batchModifyText` and `modifyText` refuse an explicit-index write when a
  concurrent change since the read cannot be proven not to touch the target
  range, and re-resolve a `textToFind` target against the current document
  when it can; every rejection names what changed and where (#108).
- `modifyText` can create bullets and numbered lists (#120), so a mid-document
  insert can match the formatting of the rest of the document.
- `readDocument` surfaces link targets that disagree with their display text
  (#117), including `mailto:` links, rather than leaving the mismatch for the
  reader to notice.

### Fixed

- `resolveComment` now posts a resolve-action reply and verifies it
  persisted, **throwing** if the comment still reports unresolved, instead of
  silently writing an ignored field and returning a soft note asking the user
  to resolve it manually; `listComments` paginates (`maxResults`/`pageToken`)
  (#86).
- `insertImage` acquires its mutation lease before any Drive upload, on both
  the standard and Apps Script local-file paths, so a rejected mutation
  (unauthorized/expired/never-read document) can no longer leave an uploaded
  file behind in the user's Drive; `createDocument` and `createFromTemplate`
  now seed post-create read state on success, so an immediate follow-up
  mutation no longer fails as "unread" (#87).
- `docsJsonToMarkdown` ordered-list export uses real ordinals (previously
  every item rendered as `1.`), nested-list indentation matches each
  ancestor's actual rendered marker width instead of a flat two spaces, and a
  blank line now separates a list from the following block so re-importing
  the exported markdown preserves nesting depth (#106).
- A failed `textToFind` now says *where* matching diverged — the longest
  matching prefix, the divergence offset, and the surrounding document text —
  instead of a bare "could not find it". Rendered by `modifyText`,
  `getFormatting`, and `applyParagraphStyle`.
- `readDocument format='json'` no longer emits an unbounded raw document when no
  `maxLength` was given; over the response budget it fails with a directive
  naming `format='index'`. `maxLength` is validated as a positive integer
  instead of treating `0` as "unlimited", and its description now says it
  applies to text, markdown, and json.
- `replaceDocumentWithMarkdown` no longer emits literal `**` or `~~` into the
  document when a delimiter carries a trailing space, as in `**text **` (#118).
- `modifyText` no longer raises a phantom staleness error when the document has
  not actually changed and the diff is empty; an immediate identical retry used
  to succeed, which is the signature of a false positive (#119).
- `modifyText` replacement text no longer silently inherits the character style
  of the text it replaced, which italicized whole inserted sections (#121).
- `readDocument` no longer overwrites the local mirror file and destroys pending
  edits (#122).
- Markdown export is round-trip safe across a header that follows a list (#123).
  The blank line between them survived export but was lost on push, merging the
  header into the last list item.

## [3.0.0] - 2026-08-30

PR [#109](https://github.com/karthikcsq/google-tools-mcp/pull/109) by
[@ElliotDrel](https://github.com/ElliotDrel): Adopt MCP 2026-07-28: official
SDK v2 runtime, read handles, stateless HTTP.

Migration to MCP specification **2026-07-28** on the official MCP TypeScript
SDK v2. FastMCP, mcp-proxy, and the v1 SDK are gone. The breaking changes are
all in shared HTTP mode. **stdio users: nothing in your config changes, with one
exception — Codex.** Codex pins stdio servers to the legacy lifecycle unless it
is told otherwise, so a Codex stdio registration needs
`CODEX_MCP_PROTOCOL_VERSION=2026-07-28` added to its `env` block. Every other
stdio client is unaffected. See
[docs/http-mode.md](docs/http-mode.md#codex).

### Breaking

- **Sessionful HTTP is removed.** HTTP is stateless: every request is
  authenticated, served, and forgotten. Removed, all now returning `404` after
  the same bearer-token and `Origin` checks as any other request:
  - `GET /sse` and its `POST /messages` companion — the legacy SSE
    compatibility transport mcp-proxy always stood up alongside the configured
    endpoint, with no supported way to turn it off.
  - `GET /ping` — mcp-proxy's unauthenticated liveness route. Replaced by
    authenticated `GET /healthz`, which returns exactly
    `{"status":"ok","pid":<number>}` and no server, version, profile, tool,
    handle, or client identity. The pid is there because `setup` and `status`
    compare it against the recorded state file to prove the process answering
    the port is the one they started.
  - The `GET` that attached to a session's event stream and the `DELETE` that
    terminated a session.

  The `Mcp-Session-Id` header is never required, never returned, and ignored if
  sent. What remains is one `POST` endpoint (`GOOGLE_MCP_ENDPOINT`, default
  `/mcp`) plus `GET /healthz`.

  Reconfiguration steps for Claude Code and Codex — including the
  `CODEX_MCP_PROTOCOL_VERSION=2026-07-28` env entry a Codex stdio registration
  needs, without which Codex pins the server to the legacy lifecycle — are in
  [docs/http-mode.md](docs/http-mode.md).

- **Google Docs edits over HTTP now require an explicit `readHandle`.** Read
  state is never carried between HTTP requests, so an earlier request's read
  cannot authorize a later write. `readDocument` returns an opaque, server-minted
  handle bound to the credential fingerprint, configured profile, runtime epoch,
  file, tab, revision, and a structural fingerprint of the document; it expires
  in under 24 hours, and a mutation consumes it and returns a successor bound to
  the new revision. A revision string alone cannot authorize a write. The field
  is schema-optional and runtime-required on HTTP, so stdio and its
  connection-pinned implicit read state are unaffected.

- **`writeSpreadsheet`, `batchWrite`, `clearSpreadsheetRange`, and `deleteFile`
  fail closed over HTTP.** They have no handle wiring yet. Use stdio for them in
  this release.

- **`GOOGLE_MCP_USE_SDK_V2` is removed.** The SDK v2 path was the flagged
  runtime during the migration and is now the only runtime, so there is nothing
  left to select.

- **Node `>=20` and Zod `^4.2`** are now the floor.

- One process serves **one** configured Google profile and one effective
  service principal. Handles, trackers, and workspace ownership are valid only
  for that deployment; multiple profiles or horizontal scale are out of scope.

### Added

- `GET /healthz`, authenticated, liveness only. Part of making the shared HTTP
  transport production-ready before it could be considered as a default (#75).
- `server/discover` carrying supported versions, capabilities, `serverInfo`, and
  server `instructions`, with `cacheHints` (60s TTL, private scope) on both
  `server/discover` and `tools/list` so clients can cache the catalog.
- Per-handle editable workspaces over content-addressed immutable baselines,
  with ownership manifests, dirty-file retention, and cleanup on mint and
  shutdown.
- A secret redactor and error classifier at the transport boundary
  (`dist/errors.js`): every caller-visible error string and every server-side
  log field is redacted, and an unclassified internal failure returns a generic
  message instead of a raw stack.
- `docs/http-mode.md`, the reference for HTTP mode and this breaking change.

### Fixed

- Read-tracker state can no longer be shared across HTTP requests. One request's
  read of a document could previously satisfy another request's mutation guard.
- `subscriptions/listen` returns its empty result and closes gracefully instead
  of holding the connection open ([typescript-sdk#2650](https://github.com/modelcontextprotocol/typescript-sdk/issues/2650)).
- A modern POST whose body claims a protocol revision but omits the
  `MCP-Protocol-Version` header gets a JSON-RPC `-32020` HeaderMismatch error
  addressed to the pending request id, rather than a generic HTTP body the
  client would take down the wrong error path.
- `Access-Control-Allow-Origin` and `Vary: Origin` are attached to real
  responses, not just the CORS preflight.

### Removed (internal)

- `fastmcp` and, with it, `mcp-proxy` and the transitive
  `@modelcontextprotocol/sdk` v1.
- `dist/cachedToolsList.js` (unused; the only raw v1 SDK import).
- `dist/sessionContext.js` and every `runWithSession` / `currentSessionKey` /
  `clearSession` call site.
- The `http.createServer` request-guard monkey-patch in `dist/httpAuth.js`
  (`startWithRequestGuard`, `createHttpRequestGuard`) and the FastMCP
  `createHttpAuthenticate` hook. One `checkHttpAuth` middleware now runs ahead
  of routing and covers every method and path.
- The `server.on('disconnect')` session-cleanup handlers.

## [2.1.2] - 2026-08-19

Commit [ab3b243](https://github.com/karthikcsq/google-tools-mcp/commit/ab3b243f94db8afd0c52e0235a1032ba15201824)
by [@karthikcsq](https://github.com/karthikcsq): chore: trailing newline in
README.

### Docs

- README.md ends with a trailing newline.

## [2.1.1] - 2026-08-08

Commit [f8ab1ac](https://github.com/karthikcsq/google-tools-mcp/commit/f8ab1ac725612e2a0db3c0bf67bebbe431d958c8)
by [@karthikcsq](https://github.com/karthikcsq): docs: use systemd-managed SSH
OAuth tunnel.

### Docs

- `docs/remote-oauth-tunnel.md` runs the persistent SSH forward as a systemd
  user unit around plain `ssh -N`, with systemd handling restarts, instead of
  requiring `autossh`.

## [2.1.0] - 2026-08-08

Commit [6894079](https://github.com/karthikcsq/google-tools-mcp/commit/68940797c1ca6da72abc105e311b322dcb1d07df)
by [@karthikcsq](https://github.com/karthikcsq): feat: support fixed OAuth
callback ports.

### Added

- **`GOOGLE_MCP_OAUTH_PORT` pins the OAuth callback to a fixed loopback port.**
  The interactive sign-in used to listen on an ephemeral port, which cannot be
  forwarded ahead of time. Set the variable to an integer from 1 through 65535
  to bind the callback there (anything else is rejected with a message naming
  that range), so a remote MCP host can forward the callback over a persistent
  SSH tunnel to the machine that has the browser. Unset, the behaviour is
  unchanged.

### Docs

- `docs/remote-oauth-tunnel.md`, the walkthrough for a remote MCP host with a
  local browser, linked from the README's environment variable table.

### Testing

- `tests/oauthCallbackPort.test.js` covers the parsing and the default.

## [2.0.3] - 2026-08-03

PR [#77](https://github.com/karthikcsq/google-tools-mcp/pull/77) by
[@ElliotDrel](https://github.com/ElliotDrel): Fix the post-release
verification command in RELEASING.md.

### Docs

- **The post-release check in RELEASING.md could report a healthy package as
  broken.** It closed stdin immediately and then expected the server's ready
  line, so the stdin shutdown handler could win before startup finished; an
  intermediate fix that held stdin open through `npx` still ran the timer during
  package resolution and unpacking. The check now installs the exact published
  version into a scratch directory first, starts the installed entry point with
  stdin held open for the measured startup range, then lets it close so
  shutdown is verified too. Both false-negative modes are documented next to
  the check, piping the install or run through `head` is warned against (it can
  interrupt `npx` unpacking and corrupt the local cache), and the optional
  `npx`-path check requires warming the cache before timing it.

## [2.0.2] - 2026-08-03

PR [#103](https://github.com/karthikcsq/google-tools-mcp/pull/103) by
[@ElliotDrel](https://github.com/ElliotDrel): Document complete Google
Workspace coverage.

### Fixed

- The guided `setup` wizard enables the Google Tasks API alongside the others,
  so the Tasks tools work after a fresh setup.

### Docs

- The documented default tool count is corrected to 156, and the Slides and
  Tasks categories are listed where they had been omitted. A workflow guide
  (`docs/workflows.md`) covers Gmail, Docs, Sheets, Slides, Tasks, and
  destructive operations, and is indexed from `docs/README.md`.

### Testing

- Regression tests compare the README's published tool claims with the live
  default registry, and the setup wizard's API list with what setup actually
  enables, so the docs cannot drift from the runtime surface again.

## [2.0.1] - 2026-07-26

PR [#81](https://github.com/karthikcsq/google-tools-mcp/pull/81) by
[@ElliotDrel](https://github.com/ElliotDrel): Add a docs/ directory for
contributor-facing documentation.

### Docs

- A `docs/` directory for contributor-facing documentation, with an index and
  two pages linked from the README. `docs/architecture.md` covers the internals:
  `dist/` as hand-edited source with no build step, the entry point and its
  subcommands, the two transports and their environment variables, lazy loading
  of the 12 tool categories, and the `addTool` wrapper that silently gives every
  registered tool session binding, `withAuthRetry`, and `appendHintToError`.
  `docs/startup-performance.md` explains why boot time is a correctness
  constraint under Claude Code's fixed 30s stdio timeout, with measured launch
  numbers attributing roughly 80% of startup to `import('googleapis')` (#71)
  and three reproducible ways to re-measure. `docs/` is removed from
  `.gitignore`; `CLAUDE.md` and `AGENTS.md` stay ignored, and `"files":
  ["dist"]` keeps the directory out of the published package.

## [2.0.0] - 2026-07-26

PR [#76](https://github.com/karthikcsq/google-tools-mcp/pull/76) by
[@ElliotDrel](https://github.com/ElliotDrel): Release 2.0.0.

First release since 1.2.12 (2026-06-01). Thirteen pull requests, one breaking change.

### Breaking

- **Gmail tool names are now camelCase, and the old `snake_case` names are opt-in** (#65).
  The Gmail surface was consolidated and renamed: `send_message` is now `sendMessage`,
  `get_thread` is now `getThread`, `create_draft` is now `createDraft`, and so on across
  the whole group. By default the server registers 156 tools, and the old Gmail names are
  not among them. (This rename covered Gmail only. The six `forms` tools still use
  snake_case and are unaffected.)

  If you have saved prompts, scripts, or client configs that call the old names, set:

  ```
  GOOGLE_MCP_ENABLE_LEGACY_ALIASES=true
  ```

  That registers the previous names as aliases alongside the new ones, for 228 tools
  total, and gives you time to migrate. The aliases are intended as a migration path
  rather than a permanent surface.

### Added

- **Google Maps and Places tools** (#66): `mapsDirections`, `mapsGeocode`,
  `mapsPlaceDetails`, `mapsReverseGeocode`, `mapsSearchNearby`, `mapsSearchPlaces`.
  Requires `GOOGLE_MAPS_API_KEY`, which is separate from OAuth. Without it the tools stay
  listed but fail with a clear error rather than disappearing.
- **Optional shared HTTP transport** (#59): set `GOOGLE_MCP_TRANSPORT=http` to run one
  long-lived server for many clients instead of spawning a process per client. Binds to
  `127.0.0.1` and requires a bearer token by default; refuses to start if you combine
  `GOOGLE_MCP_HTTP_NO_AUTH=1` with a non-loopback bind. Read-tracking state is isolated
  per session, but all clients share one process and one OAuth token.
- **Fidelity warnings when markdown is silently dropped** (#61, #69). Converting markdown
  to Docs previously discarded unsupported constructs without saying so. The markdown
  tools now report a warning count in their success line and list what was dropped.
  `readDocument` and `replaceDocumentWithMarkdown` also keep a local workspace copy so an
  edit-and-push cycle starts from current document state.
- **Optimistic concurrency on Docs writes** (#64). Replace, append, and modify now pass
  `WriteControl` with the revision they read, so a write fails instead of silently
  clobbering an edit someone else made in between.
- **Output size controls for Gmail threads and messages** (#63), so a large thread no
  longer blows past the response budget.
- **Trusted npm publishing** (#68). Releases publish from a tag via GitHub Actions OIDC
  with provenance, gated on environment approval. No npm token is stored in the repo.
  See `RELEASING.md`.
- **Startup timing on the server's ready line** (#70), plus a warning when startup exceeds
  5 seconds, to separate a slow server from a slow launcher.

### Fixed

- **Long email headers are folded per RFC 5322** (#60), resolving `Invalid Cc header` when
  sending to many recipients.
- **Ordered lists survive tab-scoped Docs reads** (#67); they previously came back
  flattened.
- **Emulated horizontal rules match Google's native line color** (#58).

### Changed

- `npx -y google-tools-mcp setup` now installs the package globally and points your MCP
  config at that install rather than at `npx` (#70). `npx` re-resolves the whole dependency
  tree on every launch, which on some machines takes long enough to lose the race against
  an MCP client's connection timeout. This widens the margin; it does not eliminate it.
  See #46, and #71 for the remaining dependency-size work.
- Documented that `dist/` is the hand-edited source for this repository, with no
  TypeScript, bundler, or build step (#62).
