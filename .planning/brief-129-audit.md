# Issue #129: clear the seven production npm audit findings

Work only in `C:/Users/2supe/All Coding/Google-Tools-MCP/gtm-129`, branch `fix/audit-129`, cut from
`main` at `a95bf30`. Dependencies are installed. **Do not push. Do not touch any other worktree.
Do not post to GitHub.**

Read `.planning/constraints.md` in the main worktree first. Two corrections that override it here:
**you DO have network access and `npm` works** (that file's flat no-network line is written for
sandboxed runs; this one is not), and `gh` is still off limits because nothing here touches GitHub.

## The findings, verified on main today

`npm audit --omit=dev` reports 7: 3 high, 3 moderate, 1 low. Direct dependencies are marked.

| package | severity | direct | note |
|---|---|---|---|
| `hono` | high | yes | cookie-name validation on write path; non-breaking space handling |
| `@xmldom/xmldom` | high | no | XML injection via unsafe CDATA serialization |
| `linkify-it` | high | no | quadratic complexity in `LinkifyIt#match` |
| `@hono/node-server` | moderate | no | middleware bypass via repeated slashes in `serveStatic` |
| `markdown-it` | moderate | yes | quadratic-complexity DoS in the smartquotes rule |
| `qs` | moderate | no | `qs.stringify` DoS on null/undefined in comma-format arrays |
| `diff` | low | yes | DoS in `parsePatch` / `applyPatch`; **fix is semver-major, 7 -> 9** |

Six have non-breaking fixes. `npm audit fix` should handle those. Confirm each actually moved rather
than trusting the summary line.

## `diff` needs judgment, not a flag

This is the only one that changes a major version, so it is the only one that can break us.

The advisory is specifically about `parsePatch` and `applyPatch`. **This codebase calls neither.**
It imports exactly two functions, at five sites:

- `diffLines` — `dist/docsChangePrecision.js:231`
- `createPatch` — `dist/docsChangePrecision.js:405`, `dist/readTracker.js:225`,
  `dist/tools/docs/batchModifyText.js:488`, `dist/tools/docs/readGoogleDoc.js:309`,
  `dist/tools/utils/replaceDocumentWithMarkdown.js:34`

So the exposure is nil and the bump is about keeping the audit clean, not about closing a reachable
hole. Read the jsdiff v8 and v9 changelogs (they are in `node_modules/diff` once installed, or on
npm) and check every behavioural change against those two functions and their options — note
`createPatch(label, before, after, 'when you read it', 'now', { context: 2 })` passes header strings
and a `context` option, and `diffLines` is used for structural change detection.

If `diffLines` or `createPatch` changed output shape, whitespace handling, or option semantics in
v8 or v9, **say so and stop rather than bumping**. Every one of those five call sites feeds a
user-visible diff or a staleness decision on the Docs read/write path, so a silent formatting change
is a correctness bug, not cosmetics. If they are unchanged, bump and prove it with the tests below.

## Gates

- `npm audit --omit=dev` reports **0 vulnerabilities**. Paste the exact final line.
- `npm audit` (including dev) — report what remains; dev-only findings do not block, but say what
  they are rather than hiding them.
- `npm ci` from the regenerated lockfile, then the suite again, so the tree is reproducible.
- `npm test` twice and `npm run test:ci` once, all fully green. Report the **`Test Suites:`** line
  as well as `Tests:` — a suite that fails to *load* reports zero failed tests and looks green.
- Tool count stays **160** default / **232** aliases-enabled.
- **No test count is a target.** Never consolidate, delete, weaken or skip a test to reach a number.
- Regenerate `tests/fixtures/mcp-migration-inventory.json` if it moves:
  `node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json > /dev/null`
- Commit on `fix/audit-129` with a message naming what moved and why. Do not push.

## Known unrelated flake

`tests/doctorSetupInspection.test.js:238` fails roughly 1 run in 5 under heavy IO and passes in
isolation. It is being fixed on a separate branch. If you hit it, note it and re-run; do not "fix"
it here and do not let it mask a real failure.

## Report

Per package: old version -> new version, and whether it was direct or transitive. Then the audit
lines, the test lines, and your verdict on the `diff` major bump with the specific changelog
evidence you based it on. Call out anything you suspect is wrong but left alone.
