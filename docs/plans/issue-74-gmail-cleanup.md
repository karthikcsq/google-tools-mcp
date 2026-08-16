# Plan: Gmail maintenance cleanup (#74)

Issue: [#74](https://github.com/karthikcsq/google-tools-mcp/issues/74) (canonical for closed #53, #57) · Verified against `main` @ 8640240. Revised after adversarial review.

## Root cause

The Gmail consolidation (merge `53bf2ad`) moved the live implementations to `dist/tools/gmail/*` but left five stale root-level forks at `dist/tools/`. They are unreferenced, trail the live builders, and still ship in the tarball, so a contributor can fix code that never runs. The live clean/metadata/full format dispatch is also copy-pasted six times, and `maxMessages` has an undocumented zero-value contract.

## Pre-deletion check (one final gate)

Recon verified: `dist/tools/index.js` imports Gmail only from `./gmail/*` (`:148,149,156,162,168`); repo-wide grep for `tools/(drafts|labels|messages|settings|threads).js` and relative-import variants finds no references; all dynamic `import()` sites are enumerated (`tools/index.js:126-198`, `index.js:30,42`, `setup.js:421`, `googleDocsApiHelpers.js:931-932`, `extras/readFile.js:32`) and none touch them; no `readdir`/glob-based loading exists anywhere in `dist/`. Re-run these checks at implementation time, delete the five files in the implementation worktree with `git rm`, then run the full suite and `npm pack --dry-run` with that deletion staged. If a gate fails, restore only these paths with Git and investigate; do not use temporary rename proof mechanisms.

## Implementation

### 1. Delete the five dead modules

`git rm dist/tools/drafts.js dist/tools/labels.js dist/tools/messages.js dist/tools/settings.js dist/tools/threads.js`

Do not diff-merge anything back: prior comparison established that the forks trail the live files. Note the unsupported deep-import removal in CHANGELOG.md as a defensive courtesy.

### 2. Extract the shared format dispatch

Six identical blocks — `dist/tools/gmail/messages.js:293-295, 329-331, 418-420` and `dist/tools/gmail/threads.js:97-99, 142-144, 198-200`:

```js
if (params.format === 'clean')    return formatMessageClean(msg, params.maxBodyChars, params.includeQuoted);
if (params.format === 'metadata') return formatMessageMetadata(msg);
if (msg.payload) msg.payload = processMessagePart(msg.payload, params.includeBodyHtml, params.maxBodyChars);
```

Add to `dist/helpers.js` (next to the three formatters it calls, `helpers.js:26,396,558`):

```js
export function formatMessageForOutput(msg, params) { ... } // returns the formatted message
```

and replace all six call sites. The three `threads.js` sites additionally share the surrounding `maxMessages` slice (`:95,:140,:196`) and `capThreadMessages` call (`:102,:147,:203`); extract those into a thread-local helper in `gmail/threads.js` (where `capThreadMessages` already lives at `:49`) rather than moving thread-specific logic into `helpers.js`. Net: one behavior, one definition per file family.

### 3. Document `maxMessages: 0`

Three `.describe()` strings — `dist/tools/gmail/threads.js:87, 121, 186` — currently say "Omit for all." while the implementation (`if (params.maxMessages > 0)`) also treats `0` and negatives as "all". Append "0 = unlimited." to match the exact convention `maxBodyChars` uses (`threads.js:83,118,183`). Add `.int().min(0)` while touching the schema so negatives are rejected instead of silently meaning "all".

## Tests

- Existing `tests/gmailThreads.test.js` and `tests/gmailConsolidation.test.js` must stay green — they pin the live behavior the extraction must not change (`maxMessages` slicing at `:65-134`, dispatch outcomes).
- Add `maxMessages: 0` cases for **all three** slicing tools — `getThread`, `listThreads`, `batchGetThreads` slice independently (`threads.js:95, 140, 196`) — each asserting all messages are returned.
- Schema-level tests: parse each of the three tools' `parameters` schema with `maxMessages: -1` and assert rejection (current tests call `execute()` directly and never exercise the zod schema, so `.int().min(0)` would otherwise be unverified).
- Add dispatch-extraction tests: `formatMessageForOutput` for each of the three formats against a fixture message (pure function, no mocking needed).
- Structural assertion that the extraction actually replaced the call sites: a test that reads `dist/tools/gmail/messages.js` and `dist/tools/gmail/threads.js` and asserts the old three-line dispatch pattern (`params.format === 'clean'` adjacent to `params.format === 'metadata'`) appears zero times outside `helpers.js` — otherwise the helper tests pass while stale copies linger.
- Package guard: assert the tarball no longer contains the five paths. Cheapest durable form: extend `tests/` with a manifest test running `npm pack --dry-run --json` and asserting no `dist/tools/{drafts,labels,messages,settings,threads}.js` entries — this also becomes the home for #56's "no *.test.js under dist/" assertion, so coordinate the file with that plan (`tests/packageContents.test.js`).

## Acceptance criteria

- Full suite green with the five modules deleted; `npm pack --dry-run` contains no `dist/tools/{drafts,…}.js`.
- The clean/metadata/full dispatch exists in exactly one place per concern; the six former sites are one-line calls.
- `maxMessages: 0` returns all messages, is documented as such, and is covered by a test.

## Sequencing

Land before #73: #73 edits the same live builders, and the MIME fix must have exactly one copy of each function to change.
