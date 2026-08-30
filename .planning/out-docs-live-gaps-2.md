OpenAI Codex v0.151.0
--------
workdir: C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
model: gpt-5.6-terra
provider: openai
approval: on-request
sandbox: workspace-write [workdir, /tmp, $TMPDIR, C:\Users\2supe\.config\google-tools-mcp] (network access enabled)
reasoning effort: xhigh
reasoning summaries: none
session id: 01a050b4-2243-7de1-b6ed-4133c6972120
--------
user
You were stopped mid-flight for an unrelated reason. Your uncommitted changes were preserved and committed for you as ae23783 on this branch; the working tree is exactly as you left it, so continue from there. Gates, unchanged: all three of #14, #106 and #108 must PASS in a live run; a full 22-scenario live run must show 22 passed / 0 failed with nothing that previously passed now failing; npm test must stay at 91 suites / 1295 tests. Commit as you go from now on, do not leave work uncommitted. End your report with the full 22-row live table and the Test Suites: line.
warning: This session was recorded with model `codex-auto-review` but is resuming with `gpt-5.6-terra`. Consider switching back to `codex-auto-review` as it may affect Codex performance.
codex
I’ll resume from `ae23783`, verify the preserved commit and worktree, then run the two live scenarios that were awaiting verification before finishing #108 and the full acceptance gates.
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-int' status --short; git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-int' branch --show-current; git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-int' rev-parse HEAD; git -c safe.directory='C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-int' show --stat --oneline --summary HEAD" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
 succeeded in 756ms:
warning: unable to access 'C:\Users\2supe/.config/git/ignore': Permission denied
warning: unable to access 'C:\Users\2supe/.config/git/ignore': Permission denied
verify/live-smoke-on-fixes
ae23783159298176879166348dc23d1bb0482743
ae23783 WIP (agent stopped mid-flight): #14 markdown-path color + #106 list nesting
 dist/googleDocsApiHelpers.js                | 11 +++++--
 dist/markdown-transformer/docsToMarkdown.js | 50 ++++++++++++++++++++++++++---
 tests/defaultTextColor.test.js              | 28 ++++++++++++++++
 tests/markdownRoundTrip.test.js             | 26 +++++++++++++++
 4 files changed, 108 insertions(+), 7 deletions(-)

codex
The worktree is clean at the preserved #14/#106 commit. I’m now running their unchanged guarded live repro to determine whether those fixes actually moved the real API behavior.
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '$env:GOOGLE_MCP_TEST_FOLDER_ID='"'15m5wq1pA8Mn0ETxIaLdN0kaUFwnrfzHN'; "'$env:LOG_LEVEL='"'warn'; node scripts/live-smoke.mjs issue-14-explicit-font-color issue-106-mirror-rewritten-list-structure" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
 exited 1 in 55730ms:
live-smoke scenarios
  build      C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int\dist
  folder     15m5wq1pA8Mn0ETxIaLdN0kaUFwnrfzHN
  run id     2026-08-30T13-05-23-619-26eb
  journal    C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int\live-smoke-results\2026-08-30T13-05-23-619-26eb.jsonl
  workspace  C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int\live-smoke-results\workspace\2026-08-30T13-05-23-619-26eb
  sandbox    "google-tools-mcp live smoke (safe to delete)"
  account    elliotdrel@gmail.com
  scenarios  2 of 22

  [docs] issue-106-mirror-rewritten-list-structure (#106)
      PASS in 4.6s — assertions held

  [docs] issue-14-explicit-font-color (#14)
      FAIL in 4.3s — 3 of 3 text run(s) written by replaceDocumentWithMarkdown carry no explicit foregroundColor (e.g. "Font Color Probe"), so Google Docs treat…


live-smoke  run 2026-08-30T13-05-23-619-26eb  folder 15m5wq1pA8Mn0ETxIaLdN0kaUFwnrfzHN

SCENARIO                                   ISSUE   RESULT  BASE           REASON
-----------------------------------------  ------  ------  -------------  ------------------------------------------------------------
issue-106-mirror-rewritten-list-structure  #106    PASS    expected-fail  assertions held
issue-14-explicit-font-color               #14     FAIL    expected-fail  3 of 3 text run(s) written by replaceDocumentWithMarkdown carry no explicit foregroundColor (e.…

1 passed, 1 failed, 0 skipped, of 2.
1 scenario(s) disagreed with expectedOnBase: issue-106-mirror-rewritten-list-structure.
Cleanup: trashed 2 of 2 created item(s).
Test folder after cleanup: 0 item(s).
Drafts this run created and did not delete: 0.
Stdout leaks from tool code paths: 0.
Guard: 3 containment lookup(s), 0 refusal(s), 0 quota wait(s), 0 rate-limit retry(ies).
Journal: C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int\live-smoke-results\2026-08-30T13-05-23-619-26eb.jsonl

codex
#106 now passes live. #14 still produces no explicit color through `replaceDocumentWithMarkdown`, so I’m tracing the request construction and batching path rather than treating the passing mocked test as sufficient.
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "rg -n -C 12 \"getDefaultTextColor|buildDefaultColorStyleRequest|insertMarkdown\\(\" dist/markdown-transformer/index.js dist/googleDocsApiHelpers.js dist/markdown-transformer/markdownToDocs.js dist/tools/utils/replaceDocumentWithMarkdown.js" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '$resultPath='"'live-smoke-results\\2026-08-30T13-05-23-619-26eb.jsonl'; "'$records=Get-Content $resultPath | ForEach-Object { $_ | ConvertFrom-Json }; $records | Where-Object { $_.scenario -eq '"'issue-14-explicit-font-color' } | ConvertTo-Json -Depth 12" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
 succeeded in 0ms:
dist/markdown-transformer/markdownToDocs.js-207-// Therefore:
dist/markdown-transformer/markdownToDocs.js-208-//   CELL_CONTENT_OFFSET = 4  (from insertTable target T to cell content at T+4)
dist/markdown-transformer/markdownToDocs.js-209-//   EMPTY_1x1_TABLE_SIZE = 6 (total positions: 1 newline + 5 table structure)
dist/markdown-transformer/markdownToDocs.js-210-//   Actual table start for updateTableCellStyle = T + 1 (NOT T)
dist/markdown-transformer/markdownToDocs.js-211-//
dist/markdown-transformer/markdownToDocs.js-212-// Verified empirically via documents.get on a real document with a 1x1 table.
dist/markdown-transformer/markdownToDocs.js-213-const CELL_CONTENT_OFFSET = 4;
dist/markdown-transformer/markdownToDocs.js-214-const EMPTY_1x1_TABLE_SIZE = 6;
dist/markdown-transformer/markdownToDocs.js-215-// --- Main Conversion Function ---
dist/markdown-transformer/markdownToDocs.js-216-/**
dist/markdown-transformer/markdownToDocs.js-217- * Converts a markdown string to an array of Google Docs API batch update requests.
dist/markdown-transformer/markdownToDocs.js-218- *
dist/markdown-transformer/markdownToDocs.js:219: * This is an internal function -- callers should use `insertMarkdown()` from
dist/markdown-transformer/markdownToDocs.js-220- * the barrel export instead.
dist/markdown-transformer/markdownToDocs.js-221- *
dist/markdown-transformer/markdownToDocs.js-222- * @param markdown - The markdown content to convert
dist/markdown-transformer/markdownToDocs.js-223- * @param startIndex - The document index where content should be inserted (1-based)
dist/markdown-transformer/markdownToDocs.js-224- * @param tabId - Optional tab ID for multi-tab documents
dist/markdown-transformer/markdownToDocs.js-225- * @param options - Optional conversion options (e.g. firstHeadingAsTitle)
dist/markdown-transformer/markdownToDocs.js-226- * @returns `{ requests, warnings }` — Google Docs API requests (insertions
dist/markdown-transformer/markdownToDocs.js-227- *   first, then formatting) and human-readable warnings for any markdown
dist/markdown-transformer/markdownToDocs.js-228- *   constructs that were silently dropped during conversion.
dist/markdown-transformer/markdownToDocs.js-229- */
dist/markdown-transformer/markdownToDocs.js-230-export function convertMarkdownToRequests(markdown, startIndex = 1, tabId, options) {
dist/markdown-transformer/markdownToDocs.js-231-    if (!markdown || markdown.trim().length === 0) {
--
dist/markdown-transformer/index.js-1-// src/markdown-transformer/index.ts
dist/markdown-transformer/index.js-2-//
dist/markdown-transformer/index.js-3-// Public API for bidirectional markdown <-> Google Docs conversion.
dist/markdown-transformer/index.js-4-//
dist/markdown-transformer/index.js-5-// Main methods:
dist/markdown-transformer/index.js-6-//   extractMarkdown() - Fetch a Google Doc and return its content as markdown
dist/markdown-transformer/index.js:7://   insertMarkdown()  - Convert markdown and insert it into a Google Doc
dist/markdown-transformer/index.js-8-//
dist/markdown-transformer/index.js-9-// Helper:
dist/markdown-transformer/index.js-10-//   docsJsonToMarkdown() - Convert already-fetched Docs JSON to markdown
dist/markdown-transformer/index.js-11-//
dist/markdown-transformer/index.js-12-import { docsJsonToMarkdown } from './docsToMarkdown.js';
dist/markdown-transformer/index.js-13-import { convertMarkdownToRequests } from './markdownToDocs.js';
dist/markdown-transformer/index.js:14:import { executeBatchUpdateWithSplitting, findTabById, getDefaultTextColor } from '../googleDocsApiHelpers.js';
dist/markdown-transformer/index.js-15-import { logger } from '../logger.js';
dist/markdown-transformer/index.js-16-export { docsJsonToMarkdown, checkMarkdownFidelity, detectLinkMismatches } from './docsToMarkdown.js';
dist/markdown-transformer/index.js-17-/** Formats InsertMarkdownResult into a concise human-readable debug summary. */
dist/markdown-transformer/index.js-18-export function formatInsertResult(result) {
dist/markdown-transformer/index.js-19-    const lines = [];
dist/markdown-transformer/index.js-20-    if (result.warnings?.length) {
dist/markdown-transformer/index.js-21-        lines.push('WARNINGS (content dropped):');
dist/markdown-transformer/index.js-22-        for (const warning of result.warnings) {
dist/markdown-transformer/index.js-23-            lines.push(`  - ${warning}`);
dist/markdown-transformer/index.js-24-        }
dist/markdown-transformer/index.js-25-        lines.push('');
dist/markdown-transformer/index.js-26-    }
--
dist/markdown-transformer/index.js-80-/**
dist/markdown-transformer/index.js-81- * Converts markdown to Google Docs formatting and inserts it into a document.
dist/markdown-transformer/index.js-82- *
dist/markdown-transformer/index.js-83- * Handles the full pipeline: markdown parsing, request generation, and batch
dist/markdown-transformer/index.js-84- * execution against the Docs API. Callers never see raw API requests.
dist/markdown-transformer/index.js-85- *
dist/markdown-transformer/index.js-86- * @param docs - An authenticated Google Docs API client
dist/markdown-transformer/index.js-87- * @param documentId - The document ID
dist/markdown-transformer/index.js-88- * @param markdown - The markdown content to insert
dist/markdown-transformer/index.js-89- * @param options - Optional: startIndex (default 1), tabId
dist/markdown-transformer/index.js-90- * @returns Debug metadata about the operation (request counts, timing, API calls)
dist/markdown-transformer/index.js-91- */
dist/markdown-transformer/index.js:92:export async function insertMarkdown(docs, documentId, markdown, options) {
dist/markdown-transformer/index.js-93-    const overallStart = performance.now();
dist/markdown-transformer/index.js-94-    const startIndex = options?.startIndex ?? 1;
dist/markdown-transformer/index.js-95-    const tabId = options?.tabId;
dist/markdown-transformer/index.js-96-    const writeControl = options?.writeControl;
dist/markdown-transformer/index.js-97-    // Fetch the document's default text style so we can explicitly set
dist/markdown-transformer/index.js-98-    // foreground color on inserted text (fixes issue #14 — text without
dist/markdown-transformer/index.js-99-    // explicit color shows "no color selected" in the Docs color picker).
dist/markdown-transformer/index.js:100:    // Shared with every other insertion path via getDefaultTextColor so the
dist/markdown-transformer/index.js-101-    // lookup and its "no rgb / fetch failed" semantics live in one place.
dist/markdown-transformer/index.js:102:    const { color: defaultForegroundColor, error: defaultColorError } = await getDefaultTextColor(docs, documentId);
dist/markdown-transformer/index.js-103-    if (defaultColorError) {
dist/markdown-transformer/index.js-104-        // Operational problem (previously swallowed silently) — proceed
dist/markdown-transformer/index.js-105-        // without an explicit color rather than failing the insertion.
dist/markdown-transformer/index.js-106-        logger.warn(`insertMarkdown: could not fetch document default text color for ${documentId}: ${defaultColorError.message}`);
dist/markdown-transformer/index.js-107-    }
dist/markdown-transformer/index.js-108-    const parseStart = performance.now();
dist/markdown-transformer/index.js-109-    const conversionOptions = {
dist/markdown-transformer/index.js-110-        ...(options?.firstHeadingAsTitle && { firstHeadingAsTitle: true }),
dist/markdown-transformer/index.js-111-        ...(defaultForegroundColor && { defaultForegroundColor }),
dist/markdown-transformer/index.js-112-    };
dist/markdown-transformer/index.js-113-    const { requests, warnings } = convertMarkdownToRequests(markdown, startIndex, tabId, conversionOptions);
dist/markdown-transformer/index.js-114-    const parseElapsedMs = Math.round(performance.now() - parseStart);
--
dist/googleDocsApiHelpers.js-853- * Shared by every insertion path that wants inserted text to carry an
dist/googleDocsApiHelpers.js-854- * explicit color (matching the document default) instead of leaving it
dist/googleDocsApiHelpers.js-855- * undefined, which Google Docs treats as "no color selected" in the picker.
dist/googleDocsApiHelpers.js-856- *
dist/googleDocsApiHelpers.js-857- * Does NOT log — callers decide what a fetch failure means for them (most
dist/googleDocsApiHelpers.js-858- * treat it as non-fatal and log a warning, then proceed without a color).
dist/googleDocsApiHelpers.js-859- * Theme-color-based NORMAL_TEXT styles (no `rgbColor`) are treated the same
dist/googleDocsApiHelpers.js-860- * as "no explicit default": matching a theme slot can't be done with a fixed
dist/googleDocsApiHelpers.js-861- * RGB paint without freezing it to today's theme.
dist/googleDocsApiHelpers.js-862- *
dist/googleDocsApiHelpers.js-863- * @returns {Promise<{color: {red?:number,green?:number,blue?:number}|null, error: Error|null}>}
dist/googleDocsApiHelpers.js-864- */
dist/googleDocsApiHelpers.js:865:export async function getDefaultTextColor(docs, documentId) {
dist/googleDocsApiHelpers.js-866-    try {
dist/googleDocsApiHelpers.js-867-        const styleRes = await docs.documents.get({
dist/googleDocsApiHelpers.js-868-            documentId,
dist/googleDocsApiHelpers.js-869-            fields: 'namedStyles',
dist/googleDocsApiHelpers.js-870-        });
dist/googleDocsApiHelpers.js-871-        const normalTextStyle = styleRes.data.namedStyles?.styles?.find((s) => s.namedStyleType === 'NORMAL_TEXT');
dist/googleDocsApiHelpers.js-872-        const foregroundColor = normalTextStyle?.textStyle?.foregroundColor;
dist/googleDocsApiHelpers.js-873-        const rgbColor = foregroundColor?.color?.rgbColor;
dist/googleDocsApiHelpers.js-874-        // Google serializes an all-zero RGB value as `{}`. That is its
dist/googleDocsApiHelpers.js-875-        // inherit/default representation, not a usable direct paint: sending
dist/googleDocsApiHelpers.js-876-        // the empty object back in updateTextStyle leaves the run without an
dist/googleDocsApiHelpers.js-877-        // explicit foregroundColor. A color with at least one numeric channel
--
dist/googleDocsApiHelpers.js-887-        if (normalTextStyle && !foregroundColor?.color?.themeColor) {
dist/googleDocsApiHelpers.js-888-            return { color: { red: 0, green: 0, blue: 0 }, error: null };
dist/googleDocsApiHelpers.js-889-        }
dist/googleDocsApiHelpers.js-890-        return { color: null, error: null };
dist/googleDocsApiHelpers.js-891-    }
dist/googleDocsApiHelpers.js-892-    catch (error) {
dist/googleDocsApiHelpers.js-893-        return { color: null, error: error instanceof Error ? error : new Error(String(error)) };
dist/googleDocsApiHelpers.js-894-    }
dist/googleDocsApiHelpers.js-895-}
dist/googleDocsApiHelpers.js-896-/**
dist/googleDocsApiHelpers.js-897- * Builds an updateTextStyle request that paints [startIndex, endIndex) with
dist/googleDocsApiHelpers.js-898- * an explicit foreground color (an rgbColor object as returned by
dist/googleDocsApiHelpers.js:899: * getDefaultTextColor). Returns null for an empty/invalid range so callers
dist/googleDocsApiHelpers.js-900- * can push-if-truthy without an extra guard.
dist/googleDocsApiHelpers.js-901- */
dist/googleDocsApiHelpers.js:902:export function buildDefaultColorStyleRequest(startIndex, endIndex, color, tabId) {
dist/googleDocsApiHelpers.js-903-    if (!color || endIndex <= startIndex)
dist/googleDocsApiHelpers.js-904-        return null;
dist/googleDocsApiHelpers.js-905-    const range = { startIndex, endIndex };
dist/googleDocsApiHelpers.js-906-    if (tabId)
dist/googleDocsApiHelpers.js-907-        range.tabId = tabId;
dist/googleDocsApiHelpers.js-908-    return {
dist/googleDocsApiHelpers.js-909-        updateTextStyle: {
dist/googleDocsApiHelpers.js-910-            range,
dist/googleDocsApiHelpers.js-911-            textStyle: {
dist/googleDocsApiHelpers.js-912-                foregroundColor: { color: { rgbColor: color } },
dist/googleDocsApiHelpers.js-913-            },
dist/googleDocsApiHelpers.js-914-            fields: 'foregroundColor',
--
dist/tools/utils/replaceDocumentWithMarkdown.js-413-                        if (cleanupWriteControl && (e instanceof UserError || isPublicError(e)) && /changed since you last read/i.test(e.message)) {
dist/tools/utils/replaceDocumentWithMarkdown.js-414-                            throw e;
dist/tools/utils/replaceDocumentWithMarkdown.js-415-                        }
dist/tools/utils/replaceDocumentWithMarkdown.js-416-                        // Non-conflict failure: the cleanup did not modify the document,
dist/tools/utils/replaceDocumentWithMarkdown.js-417-                        // so the revision is unchanged and writeControlChain.current still
dist/tools/utils/replaceDocumentWithMarkdown.js-418-                        // guards the insert below (we deliberately did NOT advance it).
dist/tools/utils/replaceDocumentWithMarkdown.js-419-                        log.info(`Survivor cleanup skipped: ${e.message}`);
dist/tools/utils/replaceDocumentWithMarkdown.js-420-                    }
dist/tools/utils/replaceDocumentWithMarkdown.js-421-                }
dist/tools/utils/replaceDocumentWithMarkdown.js-422-                // 6. Convert markdown and insert (indices calculated for empty document)
dist/tools/utils/replaceDocumentWithMarkdown.js-423-                log.info(`Inserting markdown starting at index ${startIndex} (after delete, document should be empty)`);
dist/tools/utils/replaceDocumentWithMarkdown.js-424-                wroteSomething = true;
dist/tools/utils/replaceDocumentWithMarkdown.js:425:                const result = await insertMarkdown(docs, args.documentId, markdown, {
dist/tools/utils/replaceDocumentWithMarkdown.js-426-                    startIndex,
dist/tools/utils/replaceDocumentWithMarkdown.js-427-                    tabId: args.tabId,
dist/tools/utils/replaceDocumentWithMarkdown.js-428-                    firstHeadingAsTitle: args.firstHeadingAsTitle,
dist/tools/utils/replaceDocumentWithMarkdown.js-429-                    // Carries the current guard; insertMarkdown chains it across its own
dist/tools/utils/replaceDocumentWithMarkdown.js-430-                    // split batches so the whole insert stays guarded.
dist/tools/utils/replaceDocumentWithMarkdown.js-431-                    writeControl: writeControlChain.current,
dist/tools/utils/replaceDocumentWithMarkdown.js-432-                });
dist/tools/utils/replaceDocumentWithMarkdown.js-433-                // The insert landed: the document is whole again, so a later
dist/tools/utils/replaceDocumentWithMarkdown.js-434-                // failure is no longer a partial-document situation.
dist/tools/utils/replaceDocumentWithMarkdown.js-435-                deleteLanded = false;
dist/tools/utils/replaceDocumentWithMarkdown.js-436-                const debugSummary = formatInsertResult(result);
dist/tools/utils/replaceDocumentWithMarkdown.js-437-                log.info(debugSummary);

exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Get-Content -Raw live/docs/issue-14-explicit-font-color.mjs; Get-Content -Raw dist/tools/utils/replaceDocumentWithMarkdown.js' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '$f='"'dist/googleDocsApiHelpers.js'; "'$l=Get-Content $f; $l[1..310]' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
 succeeded in 2050ms:
[
    {
        "ts":  "2026-08-30T13:05:37.547Z",
        "kind":  "tool-log",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "createDocument",
        "level":  "info",
        "message":  "Creating new document \"[live-smoke] #14 explicit font color 2026-08-30T13-05-23-619-26eb\""
    },
    {
        "ts":  "2026-08-30T13:05:39.349Z",
        "kind":  "tool-log",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "createDocument",
        "level":  "info",
        "message":  "Markdown insert completed in 801ms\n  Parse: 1ms\n  Requests: 4 total (2 insertText, 1 updateTextStyle, 1 updateParagraphStyle)\n  API calls: 2 batchUpdate calls in 540ms\n    Insert phase: 2 requests, 1 calls, 371ms\n    Format phase: 2 requests, 1 calls, 168ms"
    },
    {
        "ts":  "2026-08-30T13:05:39.583Z",
        "kind":  "tool-call",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "createDocument",
        "args":  {
                     "title":  "[live-smoke] #14 explicit font color 2026-08-30T13-05-23-619-26eb",
                     "parentFolderId":  "15m5wq1pA8Mn0ETxIaLdN0kaUFwnrfzHN",
                     "initialContent":  "Placeholder body replaced below."
                 },
        "parsedArgs":  {
                           "title":  "[live-smoke] #14 explicit font color 2026-08-30T13-05-23-619-26eb",
                           "parentFolderId":  "15m5wq1pA8Mn0ETxIaLdN0kaUFwnrfzHN",
                           "initialContent":  "Placeholder body replaced below.",
                           "contentFormat":  "markdown"
                       },
        "outcome":  "ok",
        "ok":  true,
        "durationMs":  2036,
        "result":  "{\n  \"id\": \"1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4\",\n  \"name\": \"[live-smoke] #14 explicit font color 2026-08-30T13-05-23-619-26eb\",\n  \"url\": \"https://docs.google.com/document/d/1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4/edit?usp=drivesdk\"\n}"
    },
    {
        "ts":  "2026-08-30T13:05:39.583Z",
        "kind":  "track",
        "scenario":  "issue-14-explicit-font-color",
        "id":  "1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4",
        "resource":  "drive"
    },
    {
        "ts":  "2026-08-30T13:05:39.584Z",
        "kind":  "tool-log",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "readDocument",
        "level":  "info",
        "message":  "Reading Google Doc: 1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4, Format: markdown"
    },
    {
        "ts":  "2026-08-30T13:05:39.716Z",
        "kind":  "tool-log",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "readDocument",
        "level":  "info",
        "message":  "Fetched doc: 1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4"
    },
    {
        "ts":  "2026-08-30T13:05:39.836Z",
        "kind":  "tool-log",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "readDocument",
        "level":  "info",
        "message":  "Generated markdown: 32 characters"
    },
    {
        "ts":  "2026-08-30T13:05:39.837Z",
        "kind":  "tool-log",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "readDocument",
        "level":  "info",
        "message":  "Saved to C:\\Users\\2supe\\All Coding\\Google-Tools-MCP\\google-tools-mcp-int\\live-smoke-results\\workspace\\2026-08-30T13-05-23-619-26eb\\1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4.md"
    },
    {
        "ts":  "2026-08-30T13:05:39.837Z",
        "kind":  "tool-call",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "readDocument",
        "args":  {
                     "documentId":  "1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4",
                     "format":  "markdown"
                 },
        "parsedArgs":  {
                           "documentId":  "1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4",
                           "format":  "markdown",
                           "fromIndex":  0,
                           "stripInheritedStyles":  false,
                           "diffFromLastRead":  false,
                           "plainMarkdown":  false,
                           "writeLocalFile":  true
                       },
        "outcome":  "ok",
        "ok":  true,
        "durationMs":  253,
        "result":  "Placeholder body replaced below.\n\nðŸ“„ Local file: C:\\Users\\2supe\\All Coding\\Google-Tools-MCP\\google-tools-mcp-int\\live-smoke-results\\workspace\\2026-08-30T13-05-23-619-26eb\\1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-â€¦[truncated, 475 chars total]"
    },
    {
        "ts":  "2026-08-30T13:05:39.963Z",
        "kind":  "tool-log",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "replaceDocumentWithMarkdown",
        "level":  "info",
        "message":  "Replacing doc 1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4 with markdown (211 chars)"
    },
    {
        "ts":  "2026-08-30T13:05:40.665Z",
        "kind":  "tool-log",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "replaceDocumentWithMarkdown",
        "level":  "info",
        "message":  "Deleting content from index 1 to 34"
    },
    {
        "ts":  "2026-08-30T13:05:40.819Z",
        "kind":  "tool-log",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "replaceDocumentWithMarkdown",
        "level":  "info",
        "message":  "Delete complete."
    },
    {
        "ts":  "2026-08-30T13:05:41.092Z",
        "kind":  "tool-log",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "replaceDocumentWithMarkdown",
        "level":  "info",
        "message":  "Cleaned surviving paragraph (bullets + text style) at range 1-2"
    },
    {
        "ts":  "2026-08-30T13:05:41.092Z",
        "kind":  "tool-log",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "replaceDocumentWithMarkdown",
        "level":  "info",
        "message":  "Inserting markdown starting at index 1 (after delete, document should be empty)"
    },
    {
        "ts":  "2026-08-30T13:05:41.545Z",
        "kind":  "tool-log",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "replaceDocumentWithMarkdown",
        "level":  "info",
        "message":  "Markdown insert completed in 452ms\n  Parse: 1ms\n  Requests: 13 total (8 insertText, 1 updateTextStyle, 3 updateParagraphStyle, 1 createParagraphBullets)\n  API calls: 2 batchUpdate calls in 348ms\n    Insert phase: 8 requests, 1 calls, 171ms\n    Format phase: 5 requests, 1 calls, 176ms"
    },
    {
        "ts":  "2026-08-30T13:05:41.546Z",
        "kind":  "tool-log",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "replaceDocumentWithMarkdown",
        "level":  "info",
        "message":  "Saved working copy to C:\\Users\\2supe\\All Coding\\Google-Tools-MCP\\google-tools-mcp-int\\live-smoke-results\\workspace\\2026-08-30T13-05-23-619-26eb\\1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4.md"
    },
    {
        "ts":  "2026-08-30T13:05:41.651Z",
        "kind":  "tool-call",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "replaceDocumentWithMarkdown",
        "args":  {
                     "documentId":  "1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4",
                     "markdown":  "# Font Color Probe\n\nThis paragraph is written by replaceDocumentWithMarkdown and should carry an\nexplicit foreground color rather than an inherited default.\n\n- A bullet that should also carry an explicit color.\n"
                 },
        "parsedArgs":  {
                           "documentId":  "1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4",
                           "markdown":  "# Font Color Probe\n\nThis paragraph is written by replaceDocumentWithMarkdown and should carry an\nexplicit foreground color rather than an inherited default.\n\n- A bullet that should also carry an explicit color.\n",
                           "preserveTitle":  false,
                           "firstHeadingAsTitle":  true,
                           "dryRun":  false,
                           "onCollateral":  "warn"
                       },
        "outcome":  "ok",
        "ok":  true,
        "durationMs":  1813,
        "result":  "https://docs.google.com/document/d/1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4/edit\nSuccessfully replaced document content with 211 characters of markdown.\n\nCollateral check: no unresolved comment anâ€¦[truncated, 1284 chars total]"
    },
    {
        "ts":  "2026-08-30T13:05:41.652Z",
        "kind":  "tool-log",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "readDocument",
        "level":  "info",
        "message":  "Reading Google Doc: 1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4, Format: json"
    },
    {
        "ts":  "2026-08-30T13:05:41.753Z",
        "kind":  "tool-log",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "readDocument",
        "level":  "info",
        "message":  "Fetched doc: 1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4"
    },
    {
        "ts":  "2026-08-30T13:05:41.869Z",
        "kind":  "tool-call",
        "scenario":  "issue-14-explicit-font-color",
        "tool":  "readDocument",
        "args":  {
                     "documentId":  "1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4",
                     "format":  "json"
                 },
        "parsedArgs":  {
                           "documentId":  "1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4",
                           "format":  "json",
                           "fromIndex":  0,
                           "stripInheritedStyles":  false,
                           "diffFromLastRead":  false,
                           "plainMarkdown":  false,
                           "writeLocalFile":  true
                       },
        "outcome":  "ok",
        "ok":  true,
        "durationMs":  217,
        "result":  "{\n  \"title\": \"[live-smoke] #14 explicit font color 2026-08-30T13-05-23-619-26eb\",\n  \"body\": {\n    \"content\": [\n      {\n        \"endIndex\": 1,\n        \"sectionBreak\": {\n          \"sectionStyle\": {\n    â€¦[truncated, 16742 chars total]"
    },
    {
        "ts":  "2026-08-30T13:05:41.869Z",
        "kind":  "scenario-result",
        "scenario":  "issue-14-explicit-font-color",
        "cluster":  "docs",
        "issue":  14,
        "status":  "fail",
        "reason":  "3 of 3 text run(s) written by replaceDocumentWithMarkdown carry no explicit foregroundColor (e.g. \"Font Color Probe\"), so Google Docs treats them as \"no color set\" (#14).",
        "durationMs":  4322,
        "expectedOnBase":  "fail"
    },
    {
        "ts":  "2026-08-30T13:05:42.246Z",
        "kind":  "cleanup",
        "id":  "1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4",
        "resource":  "drive",
        "scenario":  "issue-14-explicit-font-color",
        "ok":  true
    }
]

 succeeded in 2845ms:
// Issue #14 -- text inserted by the editing tools has no explicit font color,
// so Google Docs shows no color selected in the picker.
//
// ACCEPTANCE CHECK, not a repro. The report is a UI observation (select the
// text, open the font colour picker, no swatch is highlighted) that no tool
// call can see. What IS checkable, and is exactly the report's suggested fix --
// "When inserting text, explicitly set the foreground color to the document's
// default text color so that Google Docs recognizes it as having a defined
// color value" -- is that the document structure carries a foregroundColor on
// the runs the tool wrote.
export const name = 'issue-14-explicit-font-color';
export const issue = 14;
export const description = 'Acceptance: text written by replaceDocumentWithMarkdown must carry an explicit foreground color.';
export const expectedOnBase = 'fail';

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#14 explicit font color'), 'Placeholder body replaced below.');
    await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });

    await ctx.call('replaceDocumentWithMarkdown', {
        documentId: doc.id,
        markdown: ctx.fixture('issue-14-font-color.md'),
    });

    const structure = JSON.parse(await ctx.call('readDocument', { documentId: doc.id, format: 'json' }));
    const runs = [];
    for (const element of structure.body?.content || []) {
        for (const run of element.paragraph?.elements || []) {
            const content = run.textRun?.content;
            if (!content || !content.trim()) continue;
            runs.push({ text: content.trim().slice(0, 40), hasColor: Boolean(run.textRun.textStyle?.foregroundColor) });
        }
    }

    ctx.assert(runs.length > 0, 'Setup failed: the document has no text runs after the push.');
    const uncolored = runs.filter((run) => !run.hasColor);
    ctx.assert(
        uncolored.length === 0,
        uncolored.length + ' of ' + runs.length + ' text run(s) written by replaceDocumentWithMarkdown carry no explicit '
        + 'foregroundColor (e.g. "' + uncolored[0].text + '"), so Google Docs treats them as "no color set" (#14).',
    );
}

// Whole-body markdown replace.
//
// --- What issue #88 added here (with #93 and #95) ---------------------------
//
// This tool's failure mode was never the text: it was everything the text diff
// does not show. Deleting the body and re-inserting it makes the Docs API treat
// the result as new content, so every unresolved comment anchored in the
// deleted range orphans and every `headingId` is regenerated, breaking every
// in-document link that pointed at a heading. Nothing looked at either before
// deleting.
//
// Three surfaces close that:
//   * `dryRun` â€” resolve the range, gather the collateral, return the
//     proposed-vs-current diff, and write NOTHING. No delete, no survivor
//     cleanup, no insert, no workspace mirror, no post-write heading fetch.
//   * `onCollateral` â€” the collateral is enumerated on every real call too, and
//     'block' turns it from a warning into a refusal.
//   * the post-write heading map â€” the new headingId of every heading, from a
//     narrow field mask, so a caller can repoint the links this call just broke
//     without a full JSON read (`insertMarkdown` returns request/timing
//     metadata only, so the ids genuinely have to be read back).
//
// The delete -> cleanup -> insert sequence still has its failure window: this
// is not a transactional replace. What changed is that a failure after the
// delete now names a recovery file holding the exact markdown that was being
// pushed, and says plainly that the document is partial. The shared workspace
// mirror is deliberately NOT that file â€” it must keep holding the last content
// that actually landed in the document, so a failed push never overwrites the
// caller's previous known-good copy.
import * as fs from 'fs/promises';
import * as path from 'path';
import { UserError, publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { createPatch } from 'diff';
import { getDocsClient, getDriveClient } from '../../clients.js';
import { DocumentIdParameter, MarkdownConversionError } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import { insertMarkdown, formatInsertResult, docsJsonToMarkdown } from '../../markdown-transformer/index.js';
import { guardMutation } from '../../readTracker.js';
import { ReadHandleParameter, beginDocsMutation } from '../../docsHandles.js';
import { fetchHeadingMap, gatherCollateral, formatCollateral } from '../../docsCollateral.js';
import {
    writeWorkspaceFile,
    getWorkspacePath,
    getWorkspaceDir,
    ensureSafeDirectory,
    writeFileSecurely,
} from '../../workspace.js';

const docUrlFor = (documentId) => `https://docs.google.com/document/d/${documentId}/edit`;

/** Cap on the diff carried in a response, so a large rewrite cannot flood the caller. */
const MAX_DIFF_CHARS = 20000;

/** Cap on headings listed inline in the post-write map. */
const MAX_HEADING_MAP_ENTRIES = 200;

/**
 * Write the markdown that was being pushed to a NEW file next to the workspace
 * mirror, for recovery after a partial write. Never the mirror itself: the
 * mirror's contract is "the last content that actually landed".
 */
async function writeRecoveryCopy(documentId, tabId, markdown) {
    const dir = getWorkspaceDir();
    await ensureSafeDirectory(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.basename(getWorkspacePath(documentId, tabId)).replace(/\.md$/, '');
    const file = path.join(dir, `${base}.recovery-${stamp}.md`);
    await writeFileSecurely(file, markdown);
    return file;
}

/** Tab-scoped source for docsJsonToMarkdown, or the whole document body. */
function scopeForMarkdown(data, tabId) {
    if (!tabId) return data;
    const tab = GDocsHelpers.findTabById(data, tabId);
    if (!tab?.documentTab) return null;
    return { body: tab.documentTab.body, lists: tab.documentTab.lists, inlineObjects: data.inlineObjects };
}

function clampDiff(patch) {
    if (!patch) return null;
    if (patch.length <= MAX_DIFF_CHARS) return patch;
    return `${patch.slice(0, MAX_DIFF_CHARS)}\nâ€¦[diff truncated at ${MAX_DIFF_CHARS} characters]\n`;
}

function renderHeadingMap(headings) {
    if (!headings || headings.length === 0) {
        return 'Post-write heading map: this document now has no headings.';
    }
    const shown = headings.slice(0, MAX_HEADING_MAP_ENTRIES);
    const lines = shown.map((h) => `  - level ${h.level} at ${h.startIndex}: "${h.text.slice(0, 80)}" -> ` +
        `${h.headingId ?? '(no headingId yet â€” Google Docs assigns one when the heading is first used as a link target)'}`);
    const more = headings.length > shown.length
        ? `\n  â€¦ and ${headings.length - shown.length} more (call listHeadings for the full outline).`
        : '';
    return `Post-write heading map (${headings.length} heading(s)) â€” use these ids to repoint any in-document links:\n${lines.join('\n')}${more}`;
}

export function register(server) {
    server.addTool({
        name: 'replaceDocumentWithMarkdown',
        description: "Best for rewriting entire sections or full documents. Replaces the entire document body with content parsed from markdown. " +
            "Supports headings, bold, italic, strikethrough, links, tables, bullet/numbered lists, and rich markdown HTML extensions for underline, color, highlight, font, alignment, and blockquotes. " +
            "Does not support markdown images or raw HTML outside those listed extensions; unsupported content is omitted and reported as warnings in the result. Use insertImage for images. " +
            "Use readDocument with format='markdown' first to get the current content, edit it, then call this tool to apply changes. " +
            "PREFERRED WORKFLOW for large edits: readDocument saves the content to a local working-copy file and returns its path â€” edit that file, then pass it here as filePath instead of inline markdown, to avoid truncation and get a reviewable diff before pushing. " +
            "DESTRUCTIVE METADATA WARNING: this rebuilds the whole body, which Google Docs treats as new content, so unresolved comments anchored in the replaced text lose their anchors and every headingId is regenerated, breaking in-document links that pointed at headings. " +
            "Both are enumerated before the delete and reported (onCollateral='block' refuses instead of warning), and the response carries the post-write heading map so links can be repointed. " +
            "Pass dryRun to see the proposed-vs-current unified diff and the full collateral list without writing anything. " +
            "For several small scattered edits, use batchModifyText â€” it edits in place in one atomic batch and costs no comment anchors or heading ids. " +
            "To rewrite ONE section instead of the whole body â€” keeping images, rules, and every other section untouched â€” use replaceRangeWithMarkdown, which builds the same structure inside a caller-chosen range. " +
            "For small single-location edits (one line or paragraph), use modifyText instead. " +
            "To add content without rewriting, use appendMarkdown. " +
            "Inserted text carries the document's default text color explicitly, when the document defines one.",
        parameters: DocumentIdParameter.extend({
            markdown: z.string().optional().describe('Inline markdown content. Prefer filePath instead for content longer than ~2000 characters â€” use the working-copy path returned by readDocument, edit that file, then pass it here.'),
            filePath: z.string().optional().describe('Path to a local markdown file to use as content. Takes precedence over the markdown parameter. Use this for large documents to avoid truncation.'),
            preserveTitle: z
                .boolean()
                .optional()
                .default(false)
                .describe('If true, preserves the first heading/title and replaces content after it.'),
            tabId: z
                .string()
                .optional()
                .describe('The ID of the specific tab to replace content in. If not specified, replaces content in the first tab.'),
            firstHeadingAsTitle: z
                .boolean()
                .optional()
                .default(true)
                .describe('If true (default), the first H1 heading (# ...) in the markdown is styled as a Google Docs TITLE instead of Heading 1. Useful when the markdown represents a full document whose first line is the document title. Set to false if the first H1 should remain a Heading 1.'),
            dryRun: z
                .boolean()
                .optional()
                .default(false)
                .describe('Preview only: returns the proposed-vs-current unified diff, the deletion summary, and the full comment/heading-link collateral list, and performs NO delete, no cleanup, no insert, and no workspace write.'),
            onCollateral: z
                .enum(['warn', 'block'])
                .optional()
                .default('warn')
                .describe("What to do when the replace would orphan unresolved comment anchors or break in-document heading links. 'warn' (default) proceeds and reports them; 'block' refuses and lists them. Under 'block', a collateral check that could not run (for example comments could not be listed) is also a refusal, since a check that did not run cannot clear anything."),
            expectedRevisionId: z
                .string()
                .optional()
                .describe('Optional compare-and-write assertion: the write is refused unless the read handle was issued for this revision. It is an assertion only, never authorization.'),
            readHandle: ReadHandleParameter,
        }),
        execute: async (args, { log }) => {
            const tabId = args.tabId ?? null;
            const dryRun = args.dryRun ?? false;
            const onCollateral = args.onCollateral ?? 'warn';
            const docs = await getDocsClient();
            const lease = await beginDocsMutation(args.documentId, {
                tabId,
                readHandle: args.readHandle,
                expectedRevisionId: args.expectedRevisionId ?? null,
                legacyGuard: () => guardMutation(args.documentId, {
                    contentFetcher: async () => {
                        const current = await docs.documents.get({ documentId: args.documentId });
                        // Return the revision this content came from alongside the
                        // content itself so guardMutation can refresh both together
                        // instead of leaving revisionId stale after a diff (see
                        // readTracker.js guardMutation for why that matters).
                        return { content: docsJsonToMarkdown(current.data), revisionId: current.data.revisionId };
                    },
                }),
            });
            // Resolve markdown content from filePath or inline parameter
            let markdown = args.markdown;
            if (args.filePath) {
                try {
                    markdown = await fs.readFile(args.filePath, 'utf-8');
                    log.info(`Read ${markdown.length} chars from file: ${args.filePath}`);
                } catch (err) {
                    // A local fs error message carries server-side absolute paths,
                    // so it stays an internal cause (matching appendToGoogleDoc).
                    await lease.abort();
                    throw wrapOperationError('read local markdown file', err, { code: err?.code });
                }
            }
            if (!markdown || markdown.length === 0) {
                // A pure input error must not burn the caller's read handle.
                await lease.abort();
                throw new UserError('Either markdown or filePath must be provided with non-empty content.');
            }
            log.info(`Replacing doc ${args.documentId} with markdown (${markdown.length} chars)${tabId ? ` in tab ${tabId}` : ''}`);
            // Set once the delete has landed: from that point a failure leaves a
            // partially rebuilt document, and the caller needs their content back.
            let deleteLanded = false;
            let wroteSomething = false;
            try {
                // The guard's authorized revision: the validated read handle's on
                // the v2 runtime, the tracked read's on the legacy one.
                const revisionId = lease.revisionId;
                // Optimistic-concurrency guard. The first write carries the revision
                // from our last read; each subsequent write advances to the revision the
                // previous write produced (returned by batchUpdate). This keeps every
                // write in the operation (delete â†’ cleanup â†’ insert) guarded against
                // concurrent edits instead of dropping the guard after the first write
                // (PR #42 review).
                const writeControlChain = GDocsHelpers.createWriteControlChain(revisionId);
                // 1. Get document structure
                const doc = await docs.documents.get({
                    documentId: args.documentId,
                    includeTabsContent: !!tabId,
                    fields: tabId ? 'tabs' : 'body(content(startIndex,endIndex))',
                });
                // 2. Calculate replacement range
                let startIndex = 1;
                let bodyContent;
                if (tabId) {
                    const targetTab = GDocsHelpers.findTabById(doc.data, tabId);
                    if (!targetTab) {
                        throw new UserError(`Tab with ID "${tabId}" not found in document.`);
                    }
                    if (!targetTab.documentTab) {
                        throw new UserError(`Tab "${tabId}" does not have content (may not be a document tab).`);
                    }
                    bodyContent = targetTab.documentTab.body?.content;
                }
                else {
                    bodyContent = doc.data.body?.content;
                }
                if (!bodyContent) {
                    throw new UserError('No content found in document/tab');
                }
                let endIndex = bodyContent[bodyContent.length - 1].endIndex - 1;
                if (args.preserveTitle) {
                    // Find first content element that's a heading or paragraph
                    for (const element of bodyContent) {
                        if (element.paragraph && element.endIndex) {
                            startIndex = element.endIndex;
                            break;
                        }
                    }
                }
                const wholeBody = startIndex === 1;

                // 2b. Collateral, BEFORE anything destructive (issues #93, #95).
                //     Tab-scoped: a tabbed call must draw its comments-and-links
                //     picture from the tab being replaced, not the default body.
                const collateralNotes = [];
                let collateral = null;
                try {
                    const drive = await getDriveClient();
                    collateral = await gatherCollateral(docs, drive, args.documentId, { tabId, startIndex, endIndex });
                } catch (error) {
                    // getDriveClient itself failing (no Drive scope, for example)
                    // must not silently clear the check.
                    collateral = {
                        links: [],
                        comments: null,
                        commentScanError: 'a Drive client could not be obtained, so comments could not be listed.',
                        commentsTruncated: false,
                        structureScanError: null,
                    };
                    log.warn(`Collateral scan unavailable for ${args.documentId}: ${error?.message ?? error}`);
                }
                const formatted = formatCollateral({ ...collateral, wholeBody });
                if (collateral.structureScanError) {
                    formatted.lines.push(`Heading-link check UNAVAILABLE: ${collateral.structureScanError} ` +
                        'In-document links to headings may break silently.');
                }
                const scanUnavailable = Boolean(collateral.commentScanError || collateral.structureScanError);
                if (!formatted.hasCollateral && !scanUnavailable) {
                    collateralNotes.push('Collateral check: no unresolved comment anchors and no in-document heading ' +
                        'links are affected by this replace.');
                } else {
                    collateralNotes.push(...formatted.lines);
                }
                if (onCollateral === 'block' && (formatted.hasCollateral || scanUnavailable)) {
                    throw publicError(['This replace was refused because onCollateral is set to "block" and it would ' +
                        'damage metadata that is not visible in a text diff:',
                        ...formatted.lines,
                        "Re-run with onCollateral='warn' to accept this, use batchModifyText or replaceRangeWithMarkdown " +
                        'to edit in place instead, or resolve/move the affected comments first.'].join('\n'));
                }

                // 2c. Current markdown, for the proposed-vs-current diff. Its own
                //     fetch on purpose: the guard exposes no document snapshot
                //     (guardMutation only invokes its content fetcher after
                //     detecting a conflict, and never returns the content), and
                //     the structure fetch above carries indices only.
                let currentMarkdown = null;
                let diffNote = null;
                try {
                    const full = await docs.documents.get({
                        documentId: args.documentId,
                        includeTabsContent: !!tabId,
                    });
                    const source = scopeForMarkdown(full.data, tabId);
                    currentMarkdown = source ? docsJsonToMarkdown(source) : null;
                } catch (error) {
                    diffNote = 'The current content could not be re-read, so no diff is available for this call.';
                    log.warn(`Diff snapshot unavailable for ${args.documentId}: ${error?.message ?? error}`);
                }
                const patch = currentMarkdown === null
                    ? null
                    : clampDiff(createPatch(
                        `${args.documentId}${tabId ? ` (tab ${tabId})` : ''}`,
                        currentMarkdown,
                        markdown,
                        'current',
                        'proposed',
                        { context: 3 },
                    ));
                const deletionLine = endIndex > startIndex
                    ? `Deletion summary: ${endIndex - startIndex} character(s) of the ` +
                      `${tabId ? `tab "${tabId}"` : 'document body'} are deleted (range ${startIndex}-${endIndex})` +
                      `${args.preserveTitle ? ', preserving the first paragraph as the title' : ' â€” the entire body'}, ` +
                      `then replaced with ${markdown.length} characters of markdown.`
                    : `Deletion summary: the ${tabId ? `tab "${tabId}"` : 'document body'} is empty, so nothing is ` +
                      `deleted; ${markdown.length} characters of markdown are inserted.`;
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;

                // 3. dryRun stops here, before ANY write.
                if (dryRun) {
                    await lease.abort();
                    return [
                        docUrl,
                        'DRY RUN â€” nothing was written. No delete, no cleanup, no insert, no local working copy.',
                        deletionLine,
                        '',
                        ...collateralNotes,
                        '',
                        diffNote ?? (patch
                            ? `--- DIFF (current â†’ proposed) ---\n${patch}--- END DIFF ---`
                            : 'The proposed markdown is identical to the current content; this replace would change nothing.'),
                    ].filter((line) => line !== undefined).join('\n');
                }

                // 4. Delete existing content
                if (endIndex > startIndex) {
                    const deleteRange = { startIndex, endIndex };
                    if (tabId) {
                        deleteRange.tabId = tabId;
                    }
                    log.info(`Deleting content from index ${startIndex} to ${endIndex}`);
                    wroteSomething = true;
                    const deleteResult = await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [
                        {
                            deleteContentRange: { range: deleteRange },
                        },
                    ], writeControlChain.current);
                    writeControlChain.advance(deleteResult);
                    deleteLanded = true;
                    log.info(`Delete complete.`);
                }
                // 5. Clean the surviving trailing paragraph.
                //    deleteContentRange always leaves one trailing paragraph that cannot
                //    be deleted. If it has bullet list membership or text formatting from
                //    the old content, all subsequently inserted text inherits those
                //    properties, corrupting the new document. We strip both bullets and
                //    text styles from the survivor before inserting.
                {
                    // Re-read to get the survivor's endIndex (always a short document now)
                    const docAfterDelete = await docs.documents.get({
                        documentId: args.documentId,
                        includeTabsContent: !!tabId,
                        fields: tabId ? 'tabs' : 'body(content(startIndex,endIndex))',
                    });
                    let survivorContent;
                    if (tabId) {
                        const tab = GDocsHelpers.findTabById(docAfterDelete.data, tabId);
                        survivorContent = tab?.documentTab?.body?.content;
                    }
                    else {
                        survivorContent = docAfterDelete.data.body?.content;
                    }
                    const survivorEnd = survivorContent
                        ? survivorContent[survivorContent.length - 1].endIndex
                        : startIndex + 1;
                    const survivorRange = { startIndex, endIndex: survivorEnd };
                    if (tabId) {
                        survivorRange.tabId = tabId;
                    }
                    const cleanupRequests = [
                        { deleteParagraphBullets: { range: survivorRange } },
                        {
                            updateTextStyle: {
                                range: survivorRange,
                                textStyle: {
                                    underline: false,
                                    bold: false,
                                    italic: false,
                                    strikethrough: false,
                                    foregroundColor: {},
                                    backgroundColor: {},
                                },
                                fields: 'underline,bold,italic,strikethrough,foregroundColor,backgroundColor',
                            },
                        },
                    ];
                    // This cleanup is the operation's first write when the delete step
                    // was skipped (empty document), so it must carry the current guard â€”
                    // otherwise it bumps the revision and the insert below fails with a
                    // spurious conflict against the revision from the read. Peek (don't
                    // advance yet): the cleanup is best-effort, and only a SUCCESSFUL
                    // cleanup changes the revision.
                    const cleanupWriteControl = writeControlChain.current;
                    try {
                        wroteSomething = true;
                        const cleanupResult = await GDocsHelpers.executeBatchUpdate(docs, args.documentId, cleanupRequests, cleanupWriteControl);
                        // Advance only after success, so the insert requires the revision
                        // the cleanup produced.
                        writeControlChain.advance(cleanupResult);
                        log.info(`Cleaned surviving paragraph (bullets + text style) at range ${startIndex}-${survivorEnd}`);
                    }
                    catch (e) {
                        // A revision conflict is a genuine concurrent edit â€” surface it
                        // instead of proceeding to clobber the document unguarded.
                        if (cleanupWriteControl && (e instanceof UserError || isPublicError(e)) && /changed since you last read/i.test(e.message)) {
                            throw e;
                        }
                        // Non-conflict failure: the cleanup did not modify the document,
                        // so the revision is unchanged and writeControlChain.current still
                        // guards the insert below (we deliberately did NOT advance it).
                        log.info(`Survivor cleanup skipped: ${e.message}`);
                    }
                }
                // 6. Convert markdown and insert (indices calculated for empty document)
                log.info(`Inserting markdown starting at index ${startIndex} (after delete, document should be empty)`);
                wroteSomething = true;
                const result = await insertMarkdown(docs, args.documentId, markdown, {
                    startIndex,
                    tabId: args.tabId,
                    firstHeadingAsTitle: args.firstHeadingAsTitle,
                    // Carries the current guard; insertMarkdown chains it across its own
                    // split batches so the whole insert stays guarded.
                    writeControl: writeControlChain.current,
                });
                // The insert landed: the document is whole again, so a later
                // failure is no longer a partial-document situation.
                deleteLanded = false;
                const debugSummary = formatInsertResult(result);
                log.info(debugSummary);
                // insertMarkdown chains the guard across its own internal split batches
                // and returns the final revision as batchUpdate.finalWriteControl; fold
                // that into our chain so trackMutation re-arms the guard against the
                // TRUE post-write revision instead of the pre-insert (delete/cleanup) one.
                writeControlChain.advance({ writeControl: result.batchUpdate?.finalWriteControl });
                // Settling the lease is deliberately NOT folded into the write:
                // creating the successor workspace can fail on its own, and that
                // is "your next handle is missing", not "your write failed".
                // Reporting it as a write failure would invite a retry that
                // applied this whole replace a second time.
                let successorWarning = null;
                try {
                    await lease.complete(writeControlChain.current?.requiredRevisionId);
                } catch (error) {
                    successorWarning = 'The document was replaced successfully, but a follow-on read handle could not be ' +
                        'issued for the new revision. Do NOT retry this call. Call readDocument again to get a fresh handle.';
                    log.error(`replaceDocumentWithMarkdown: lease.complete failed after a successful write on ` +
                        `${args.documentId}: ${error?.message ?? error}`);
                }
                // Mirror the pushed markdown to the local workspace only now that the
                // Docs mutation has actually succeeded and been tracked. Writing this
                // earlier (before the fetch/delete/cleanup/insert sequence above)
                // meant that if any of those steps failed, the local file held content
                // that was never committed to the document; worse, if the delete
                // succeeded but the insert failed, the workspace file would show the
                // full intended result while the document itself was left partial.
                // Scoped by tabId so it lines up with the per-tab file readDocument
                // created. Non-fatal: a failure to save the mirror doesn't undo an
                // already-successful Docs write, so we log and continue.
                // On the v2 runtime the working copy belongs to a handle, not to a
                // shared per-(documentId, tabId) path, and the handle that authorized
                // this write was just consumed -- so there is no shared mirror to keep.
                if (!args.filePath && !lease.active) {
                    try {
                        const workspacePath = await writeWorkspaceFile(args.documentId, markdown, args.tabId);
                        log.info(`Saved working copy to ${workspacePath}`);
                    } catch (e) {
                        log.info(`Could not save working copy: ${e.message}`);
                    }
                }
                // 7. Post-write heading map (issue #95). Narrow mask, so this is a
                //    fraction of a full read, and best-effort: the replace has
                //    already succeeded and must not be reported as failed because
                //    a convenience read did not come back.
                let headingMapText;
                try {
                    const { headings } = await fetchHeadingMap(docs, args.documentId, tabId);
                    headingMapText = renderHeadingMap(headings);
                } catch (error) {
                    headingMapText = 'Post-write heading map unavailable: the heading read after the write did not ' +
                        'complete. Call listHeadings to get the new heading ids.';
                    log.warn(`Post-write heading map failed for ${args.documentId}: ${error?.message ?? error}`);
                }
                const warningNote = result.warnings?.length
                    ? ` with ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'} (content dropped â€” see below)`
                    : '';
                return [
                    docUrl,
                    `Successfully replaced document content with ${markdown.length} characters of markdown${warningNote}.`,
                    ...(successorWarning ? ['', `WARNING: ${successorWarning}`] : []),
                    '',
                    ...collateralNotes,
                    '',
                    headingMapText,
                    '',
                    diffNote ?? (patch
                        ? `--- APPLIED DIFF (before â†’ after) ---\n${patch}--- END DIFF ---`
                        : 'The pushed markdown matched the previous content; nothing changed.'),
                    '',
                    debugSummary,
                ].join('\n');
            }
            catch (error) {
                log.error(`Error replacing document with markdown: ${error.message}`);
                if (wroteSomething) {
                    // Settle as a failed write so a dirty per-handle workspace is
                    // retained for recovery rather than silently reclaimed.
                    await lease.fail();
                } else {
                    await lease.abort();
                }
                if (deleteLanded) {
                    // The body was deleted and the new content never landed. No
                    // silent data loss: name where the intended content is and
                    // state plainly that the document is partial.
                    let recovery = args.filePath
                        ? `your own file ${args.filePath}`
                        : null;
                    if (!recovery) {
                        try {
                            recovery = await writeRecoveryCopy(args.documentId, tabId, markdown);
                        } catch (recoveryError) {
                            log.warn(`Could not write recovery copy for ${args.documentId}: ${recoveryError?.message ?? recoveryError}`);
                        }
                    }
                    throw publicError('The old content was deleted but the new content did not land, so this document is ' +
                        'now PARTIAL â€” do not treat it as replaced. ' +
                        (isPublicError(error) || error instanceof UserError
                            ? `The step that failed reported: ${error.message} `
                            : 'The insert step did not complete. ') +
                        (recovery
                            ? `The markdown that was being pushed is saved at ${recovery}; re-read the document, then push it again. `
                            : 'The markdown that was being pushed could not be saved locally; re-send it from your own copy. ') +
                        docUrlFor(args.documentId));
                }
                if (error instanceof UserError || isPublicError(error) || error instanceof MarkdownConversionError) {
                    throw error;
                }
                throw wrapOperationError('apply markdown', error, { status: error?.code });
            }
        },
    });
}


 succeeded in 4586ms:
import { hexToRgbColor, NotImplementedError } from './types.js';
import { logger } from './logger.js';
// --- Constants ---
const MAX_BATCH_UPDATE_REQUESTS = 50; // Google API limits batch size
// Identity brand for "this write was refused because the document moved to a
// new revision". A PublicToolError is frozen at construction, so it cannot
// carry a flag of its own, and re-matching the sentence wording at every call
// site is exactly the kind of coupling that rots. Callers that must react
// differently to a revision conflict than to any other failed write (e.g.
// replaceRangeWithMarkdown, which can only report an exact leftover range when
// the document is still at the revision it measured) ask this predicate.
const revisionConflictErrors = new WeakSet();
function brandRevisionConflict(error) {
    revisionConflictErrors.add(error);
    return error;
}
/** True when `error` is the conflict `executeBatchUpdate` throws on a failed requiredRevisionId. */
export function isRevisionConflictError(error) {
    return typeof error === 'object' && error !== null && revisionConflictErrors.has(error);
}
// --- Core Helper to Execute Batch Updates ---
export async function executeBatchUpdate(docs, documentId, requests, writeControl) {
    if (!requests || requests.length === 0) {
        // console.warn("executeBatchUpdate called with no requests.");
        return {}; // Nothing to do
    }
    // TODO: Consider splitting large request arrays into multiple batches if needed
    if (requests.length > MAX_BATCH_UPDATE_REQUESTS) {
        logger.warn(`Attempting batch update with ${requests.length} requests, exceeding typical limits. May fail.`);
    }
    try {
        const response = await docs.documents.batchUpdate({
            documentId: documentId,
            requestBody: { requests, ...(writeControl && { writeControl }) },
        });
        return response.data;
    }
    catch (error) {
        if (isPublicError(error)) throw error;
        logger.error(`Google API batchUpdate Error for doc ${documentId}:`, error.response?.data || error.message);
        // Translate common API errors to UserErrors
        const apiMessage = error.response?.data?.error?.message || error.message || '';
        const apiStatus = error.response?.data?.error?.status;
        // A write sent with writeControl that fails on the revision is a
        // concurrency conflict. Don't rely on message wording alone â€”
        // FAILED_PRECONDITION is Google's canonical status for this.
        const isRevisionConflict = writeControl && (
            apiStatus === 'FAILED_PRECONDITION' ||
            ((error.code === 400 || error.code === 409) && /revision|write\s*control|updated since/i.test(apiMessage))
        );
        if (isRevisionConflict) {
            throw brandRevisionConflict(publicError(`This document (${documentId}) changed since you last read it. Read the document again before editing to ensure you have current content.`));
        }
        if (error.code === 400 && error.message.includes('Invalid requests')) {
            // Try to extract more specific info if available
            const details = error.response?.data?.error?.details;
            let detailMsg = '';
            if (details && Array.isArray(details)) {
                // Only the API's own structured `description` strings are
                // caller-safe. A detail entry without one is an unknown shape,
                // so it is dropped rather than JSON.stringify'd into the public
                // message â€” the whole error still reaches the server log below.
                detailMsg = details
                    .map((d) => (typeof d?.description === 'string' ? d.description : ''))
                    .filter(Boolean)
                    .join('; ');
            }
            // The raw `error.message` fallback is arbitrary internal text, so it
            // stays an internal cause instead of being promoted to a public message.
            if (!detailMsg) {
                throw wrapOperationError('Google Docs batch update', error, { status: error.code });
            }
            throw publicError(`Invalid request sent to Google Docs API. Details: ${detailMsg}`);
        }
        if (error.code === 404)
            throw publicError(`Document not found (ID: ${documentId}). Check the ID.`);
        if (error.code === 403)
            throw publicError(`Permission denied for document (ID: ${documentId}). Ensure the authenticated user has edit access.`);
        // Generic internal error for others
        throw new Error(`Google API Error (${error.code}): ${error.message}`);
    }
}
/**
 * Creates a small stateful helper for chaining an optimistic-concurrency guard
 * across a sequence of writes that make up a single logical operation (e.g.
 * delete -> cleanup -> insert). The first write carries the revision from the
 * caller's last read; each subsequent write must require the revision the
 * previous write produced (returned as `writeControl` on a successful
 * batchUpdate response), so a collaborator edit landing between any two of
 * our own batches is rejected as a conflict instead of silently applied
 * against (PR #42 review).
 *
 * Guarding is opt-in: when `revisionId` is null/undefined (a legacy read that
 * never captured a revision), `current` stays undefined for the life of the
 * chain and `advance` is a no-op, so the flow remains unguarded.
 *
 * @param revisionId - The revisionId from the caller's last tracked read, or null/undefined
 * @returns { get current(), advance(response) }
 */
export function createWriteControlChain(revisionId) {
    let pendingWriteControl = revisionId ? { requiredRevisionId: revisionId } : undefined;
    return {
        get current() {
            return pendingWriteControl;
        },
        // Advance the chain to the revision produced by a successful write.
        // Only advances when the chain is armed and the response carried a new
        // writeControl â€” a best-effort write that fails (and is swallowed by the
        // caller) must NOT advance the chain, since the document was not modified.
        advance(response) {
            if (pendingWriteControl && response?.writeControl) {
                pendingWriteControl = response.writeControl;
            }
        },
    };
}
// --- Partial-batch progress tracking (PR #113 review finding 3) ---
// executeBatchUpdateWithSplitting sends delete/insert/format requests across
// multiple non-atomic documents.batchUpdate calls; once a batch succeeds its
// changes are committed to the live document with no rollback across calls.
// When a LATER batch throws, callers (createDocument, and anything else that
// wraps insertMarkdown) need to know whether anything already landed so they
// can tell the caller "partially applied, go inspect the document" instead
// of "nothing was added" â€” and so they don't blindly re-send content that is
// already there.
//
// This is a WeakMap side-channel keyed on the very error object that gets
// thrown/rethrown, rather than a wrapper class replacing it. Several callers
// (appendMarkdownToGoogleDoc, replaceDocumentWithMarkdown) branch on
// `error instanceof UserError` to decide whether the underlying error's own
// message is safe to surface directly (e.g. the revision-conflict message
// from executeBatchUpdate). Swapping in a new error type here would silently
// break those existing, tested paths; tagging the original error via WeakMap
// changes nothing about its identity or `instanceof` behavior.
const batchUpdateProgress = new WeakMap();

/**
 * Best-effort progress info attached to an error thrown mid-way through
 * executeBatchUpdateWithSplitting, or undefined if not available/applicable
 * (e.g. the very first batch failed, or the error didn't come from there).
 * @returns {{ completedRequests: number, totalRequests: number, phase: 'delete'|'insert'|'format' } | undefined}
 */
export function getBatchUpdateProgress(error) {
    return typeof error === 'object' && error !== null ? batchUpdateProgress.get(error) : undefined;
}
/**
 * Executes batch updates with automatic splitting for large request arrays.
 * Separates insert and format operations, executing inserts first.
 *
 * @param docs - The Google Docs client
 * @param documentId - The document ID
 * @param requests - Array of requests to execute
 * @param log - Optional logger for progress tracking
 * @returns Metadata about the execution (request counts, API calls, timing)
 */
export async function executeBatchUpdateWithSplitting(docs, documentId, requests, log, writeControl) {
    const overallStart = performance.now();
    if (!requests || requests.length === 0) {
        return {
            totalRequests: 0,
            phases: {
                delete: { requests: 0, apiCalls: 0, elapsedMs: 0 },
                insert: { requests: 0, apiCalls: 0, elapsedMs: 0 },
                format: { requests: 0, apiCalls: 0, elapsedMs: 0 },
            },
            totalApiCalls: 0,
            totalElapsedMs: 0,
        };
    }
    const MAX_BATCH = MAX_BATCH_UPDATE_REQUESTS;
    // Separate requests into three categories
    // Order of execution: delete â†’ insert â†’ format
    const deleteRequests = requests.filter((r) => 'deleteContentRange' in r);
    const insertRequests = requests.filter((r) => 'insertText' in r ||
        'insertTable' in r ||
        'insertPageBreak' in r ||
        'insertInlineImage' in r ||
        'insertSectionBreak' in r);
    const formatRequests = requests.filter((r) => !('deleteContentRange' in r) &&
        !('insertText' in r ||
            'insertTable' in r ||
            'insertPageBreak' in r ||
            'insertInlineImage' in r ||
            'insertSectionBreak' in r));
    let totalApiCalls = 0;
    // Chain the optimistic-concurrency guard across every batch this operation
    // sends. When markdown is split into delete/insert/format phases (or a phase
    // exceeds 50 requests), each successful batchUpdate returns the document's new
    // head revision in its writeControl. Requiring that revision on the next batch
    // means a collaborator edit landing between our batches is rejected as a
    // conflict instead of having our precomputed ranges applied to their content
    // (PR #42 review). Only chain when we started guarded, so legacy flows that
    // never captured a revision stay unguarded.
    let chainedWriteControl = writeControl;
    let completedRequests = 0;
    const executeBatch = async (batch, phase) => {
        try {
            const data = await executeBatchUpdate(docs, documentId, batch, chainedWriteControl);
            if (chainedWriteControl && data?.writeControl) {
                chainedWriteControl = data.writeControl;
            }
            completedRequests += batch.length;
        }
        catch (error) {
            // Tag (don't wrap) the error with how much already landed before
            // this batch failed, so a caller can tell "nothing applied" apart
            // from "some earlier batch in this same call already committed".
            if (typeof error === 'object' && error !== null) {
                batchUpdateProgress.set(error, { completedRequests, totalRequests: requests.length, phase });
            }
            throw error;
        }
    };
    // Execute delete batches first (must happen before inserts)
    const deleteStart = performance.now();
    if (deleteRequests.length > 0) {
        if (log) {
            log.info(`Executing ${deleteRequests.length} delete requests FIRST (in separate API call)`);
        }
        for (let i = 0; i < deleteRequests.length; i += MAX_BATCH) {
            const batch = deleteRequests.slice(i, i + MAX_BATCH);
            if (log) {
                log.info(`Delete batch content: ${JSON.stringify(batch)}`);
            }
            await executeBatch(batch, 'delete');
            totalApiCalls++;
            if (log) {
                const batchNum = Math.floor(i / MAX_BATCH) + 1;
                const totalBatches = Math.ceil(deleteRequests.length / MAX_BATCH);
                log.info(`Executed delete batch ${batchNum}/${totalBatches} (${batch.length} requests)`);
            }
        }
        if (log) {
            log.info(`Delete batches complete. Document should now be empty (except section break).`);
        }
    }
    const deleteElapsed = performance.now() - deleteStart;
    // Then execute insert batches
    const insertStart = performance.now();
    if (insertRequests.length > 0) {
        for (let i = 0; i < insertRequests.length; i += MAX_BATCH) {
            const batch = insertRequests.slice(i, i + MAX_BATCH);
            await executeBatch(batch, 'insert');
            totalApiCalls++;
            if (log) {
                const batchNum = Math.floor(i / MAX_BATCH) + 1;
                const totalBatches = Math.ceil(insertRequests.length / MAX_BATCH);
                log.info(`Executed insert batch ${batchNum}/${totalBatches} (${batch.length} requests)`);
            }
        }
    }
    const insertElapsed = performance.now() - insertStart;
    // Finally execute format batches
    const formatStart = performance.now();
    if (formatRequests.length > 0) {
        for (let i = 0; i < formatRequests.length; i += MAX_BATCH) {
            const batch = formatRequests.slice(i, i + MAX_BATCH);
            await executeBatch(batch, 'format');
            totalApiCalls++;
            if (log) {
                const batchNum = Math.floor(i / MAX_BATCH) + 1;
                const totalBatches = Math.ceil(formatRequests.length / MAX_BATCH);
                log.info(`Executed format batch ${batchNum}/${totalBatches} (${batch.length} requests)`);
            }
        }
    }
    const formatElapsed = performance.now() - formatStart;
    const totalElapsedMs = performance.now() - overallStart;
    return {
        totalRequests: requests.length,
        phases: {
            delete: {
                requests: deleteRequests.length,
                apiCalls: Math.ceil(deleteRequests.length / MAX_BATCH) || 0,
                elapsedMs: Math.round(deleteElapsed),
            },
            insert: {
                requests: insertRequests.length,
                apiCalls: Math.ceil(insertRequests.length / MAX_BATCH) || 0,
                elapsedMs: Math.round(insertElapsed),
            },
            format: {
                requests: formatRequests.length,
                apiCalls: Math.ceil(formatRequests.length / MAX_BATCH) || 0,
                elapsedMs: Math.round(formatElapsed),
            },
        },
        totalApiCalls,
        totalElapsedMs: Math.round(totalElapsedMs),
        // The revision guard after the last batch, so a caller that writes again
        // after this call can keep the chain intact.
        finalWriteControl: chainedWriteControl,
    };
}
// --- Text Finding Helper ---
// This improved version is more robust in handling various text structure scenarios
// --- text-search snapshots (issue #88) --------------------------------------
//
// `findTextRange` used to be the only entry point, and it fetched the document
// on every call. `batchModifyText` resolves N text-search targets that must all
// address ONE consistent document state, so the search core is split into a
// pure `findTextRangeInDoc(docJson, ...)` over a caller-supplied snapshot, with
// `findTextRange` becoming fetch-then-delegate. Both share this field mask, so
// a snapshot taken with `textSearchFields()` resolves identically either way.
const TEXT_SEARCH_BODY_SUBTREE =
    'content(paragraph(elements(startIndex,endIndex,textRun(content))),table,sectionBreak,tableOfContents,startIndex,endIndex)';

/** Field mask a snapshot must be fetched with to be usable by findTextRangeInDoc. */
export function textSearchFields(tabId) {
    return tabId

exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '$f='"'live-smoke-results\\2026-08-30T13-05-23-619-26eb.jsonl'; "'$r=Get-Content $f | ForEach-Object { $_ | ConvertFrom-Json }; $r | Where-Object { $_.scenario -eq '"'issue-14-explicit-font-color' -and "'$_.kind -eq '"'tool-log' } | Select-Object -ExpandProperty message" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '$f='"'dist/markdown-transformer/index.js'; "'$l=Get-Content $f; $l[88..170]; $f='"'dist/markdown-transformer/markdownToDocs.js'; "'$l=Get-Content $f; $l[230..620]' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'rg -n -C 5 "defaultForegroundColor|buildDefaultColorStyleRequest|foregroundColor" dist/markdown-transformer/markdownToDocs.js tests/defaultTextColor.test.js tests/markdownTransformer.test.js' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Get-Content -Raw live/docs/issue-14-explicit-font-color.mjs; $f='"'dist/tools/drive/createDocument.js'; "'$l=Get-Content $f; $l[1..240]' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
 succeeded in 1488ms:
Creating new document "[live-smoke] #14 explicit font color 2026-08-30T13-05-23-619-26eb"
Markdown insert completed in 801ms
  Parse: 1ms
  Requests: 4 total (2 insertText, 1 updateTextStyle, 1 updateParagraphStyle)
  API calls: 2 batchUpdate calls in 540ms
    Insert phase: 2 requests, 1 calls, 371ms
    Format phase: 2 requests, 1 calls, 168ms
Reading Google Doc: 1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4, Format: markdown
Fetched doc: 1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4
Generated markdown: 32 characters
Saved to C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int\live-smoke-results\workspace\2026-08-30T13-05-23-619-26eb\1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4.md
Replacing doc 1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4 with markdown (211 chars)
Deleting content from index 1 to 34
Delete complete.
Cleaned surviving paragraph (bullets + text style) at range 1-2
Inserting markdown starting at index 1 (after delete, document should be empty)
Markdown insert completed in 452ms
  Parse: 1ms
  Requests: 13 total (8 insertText, 1 updateTextStyle, 3 updateParagraphStyle, 1 createParagraphBullets)
  API calls: 2 batchUpdate calls in 348ms
    Insert phase: 8 requests, 1 calls, 171ms
    Format phase: 5 requests, 1 calls, 176ms
Saved working copy to C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int\live-smoke-results\workspace\2026-08-30T13-05-23-619-26eb\1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4.md
Reading Google Doc: 1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4, Format: json
Fetched doc: 1P6RUOVvxLmy-5yYNP4Z9j0ZFhNS-fAoIsgO-vQ7t0H4

 succeeded in 1630ms:
dist/markdown-transformer/markdownToDocs.js-100-            if (!allowRunFormatting) {
dist/markdown-transformer/markdownToDocs.js-101-                unhandled.push({ property: name, value, reason: 'not-applicable-here' });
dist/markdown-transformer/markdownToDocs.js-102-                continue;
dist/markdown-transformer/markdownToDocs.js-103-            }
dist/markdown-transformer/markdownToDocs.js-104-            if (isColor && /^#[0-9a-f]{6}$/i.test(value)) {
dist/markdown-transformer/markdownToDocs.js:105:                formatting.foregroundColor = value;
dist/markdown-transformer/markdownToDocs.js-106-                continue;
dist/markdown-transformer/markdownToDocs.js-107-            }
dist/markdown-transformer/markdownToDocs.js-108-            if (isBackground && /^#[0-9a-f]{6}$/i.test(value)) {
dist/markdown-transformer/markdownToDocs.js-109-                formatting.backgroundColor = value;
dist/markdown-transformer/markdownToDocs.js-110-                continue;
--
dist/markdown-transformer/markdownToDocs.js-255-        htmlSpanPushStack: [],
dist/markdown-transformer/markdownToDocs.js-256-        warningCounts: new Map(),
dist/markdown-transformer/markdownToDocs.js-257-        tabId,
dist/markdown-transformer/markdownToDocs.js-258-        titleConsumed: false,
dist/markdown-transformer/markdownToDocs.js-259-        firstHeadingAsTitle: options?.firstHeadingAsTitle ?? false,
dist/markdown-transformer/markdownToDocs.js:260:        defaultForegroundColor: options?.defaultForegroundColor ?? null,
dist/markdown-transformer/markdownToDocs.js-261-    };
dist/markdown-transformer/markdownToDocs.js-262-    try {
dist/markdown-transformer/markdownToDocs.js-263-        for (const token of tokens) {
dist/markdown-transformer/markdownToDocs.js-264-            processToken(token, context);
dist/markdown-transformer/markdownToDocs.js-265-        }
--
dist/markdown-transformer/markdownToDocs.js-888-                if (range.formatting.bold ||
dist/markdown-transformer/markdownToDocs.js-889-                    range.formatting.italic ||
dist/markdown-transformer/markdownToDocs.js-890-                    range.formatting.strikethrough ||
dist/markdown-transformer/markdownToDocs.js-891-                    range.formatting.code ||
dist/markdown-transformer/markdownToDocs.js-892-                    range.formatting.underline ||
dist/markdown-transformer/markdownToDocs.js:893:                    range.formatting.foregroundColor ||
dist/markdown-transformer/markdownToDocs.js-894-                    range.formatting.backgroundColor ||
dist/markdown-transformer/markdownToDocs.js-895-                    range.formatting.fontSize ||
dist/markdown-transformer/markdownToDocs.js-896-                    range.formatting.fontFamily) {
dist/markdown-transformer/markdownToDocs.js-897-                    const styleReq = buildUpdateTextStyleRequest(absStart, absEnd, formattingToTextStyle(range.formatting), context.tabId);
dist/markdown-transformer/markdownToDocs.js-898-                    if (styleReq)
--
dist/markdown-transformer/markdownToDocs.js-949-            merged.code = state.code;
dist/markdown-transformer/markdownToDocs.js-950-        if (state.link !== undefined)
dist/markdown-transformer/markdownToDocs.js-951-            merged.link = state.link;
dist/markdown-transformer/markdownToDocs.js-952-        if (state.underline !== undefined)
dist/markdown-transformer/markdownToDocs.js-953-            merged.underline = state.underline;
dist/markdown-transformer/markdownToDocs.js:954:        if (state.foregroundColor !== undefined)
dist/markdown-transformer/markdownToDocs.js:955:            merged.foregroundColor = state.foregroundColor;
dist/markdown-transformer/markdownToDocs.js-956-        if (state.backgroundColor !== undefined)
dist/markdown-transformer/markdownToDocs.js-957-            merged.backgroundColor = state.backgroundColor;
dist/markdown-transformer/markdownToDocs.js-958-        if (state.fontSize !== undefined)
dist/markdown-transformer/markdownToDocs.js-959-            merged.fontSize = state.fontSize;
dist/markdown-transformer/markdownToDocs.js-960-        if (state.fontFamily !== undefined)
--
dist/markdown-transformer/markdownToDocs.js-969-        formatting.italic === true ||
dist/markdown-transformer/markdownToDocs.js-970-        formatting.strikethrough === true ||
dist/markdown-transformer/markdownToDocs.js-971-        formatting.code === true ||
dist/markdown-transformer/markdownToDocs.js-972-        formatting.link !== undefined ||
dist/markdown-transformer/markdownToDocs.js-973-        formatting.underline === true ||
dist/markdown-transformer/markdownToDocs.js:974:        formatting.foregroundColor !== undefined ||
dist/markdown-transformer/markdownToDocs.js-975-        formatting.backgroundColor !== undefined ||
dist/markdown-transformer/markdownToDocs.js-976-        formatting.fontSize !== undefined ||
dist/markdown-transformer/markdownToDocs.js-977-        formatting.fontFamily !== undefined);
dist/markdown-transformer/markdownToDocs.js-978-}
dist/markdown-transformer/markdownToDocs.js-979-function formattingToTextStyle(formatting) {
--
dist/markdown-transformer/markdownToDocs.js-982-        italic: formatting.italic,
dist/markdown-transformer/markdownToDocs.js-983-        underline: formatting.underline,
dist/markdown-transformer/markdownToDocs.js-984-        strikethrough: formatting.strikethrough,
dist/markdown-transformer/markdownToDocs.js-985-        fontFamily: formatting.code ? CODE_FONT_FAMILY : formatting.fontFamily,
dist/markdown-transformer/markdownToDocs.js-986-        fontSize: formatting.fontSize,
dist/markdown-transformer/markdownToDocs.js:987:        foregroundColor: formatting.code ? CODE_TEXT_HEX : formatting.foregroundColor,
dist/markdown-transformer/markdownToDocs.js-988-        backgroundColor: formatting.code ? CODE_BACKGROUND_HEX : formatting.backgroundColor,
dist/markdown-transformer/markdownToDocs.js-989-    };
dist/markdown-transformer/markdownToDocs.js-990-}
dist/markdown-transformer/markdownToDocs.js-991-function mergeParagraphFormattingStack(stack) {
dist/markdown-transformer/markdownToDocs.js-992-    const merged = {};
--
dist/markdown-transformer/markdownToDocs.js-1016-// --- Finalization ---
dist/markdown-transformer/markdownToDocs.js-1017-function finalizeFormatting(context) {
dist/markdown-transformer/markdownToDocs.js-1018-    // Apply the document's default foreground color to the entire inserted range
dist/markdown-transformer/markdownToDocs.js-1019-    // so text has an explicit color value in Google Docs (fixes issue #14).
dist/markdown-transformer/markdownToDocs.js-1020-    // This goes first so intentional colors (code blocks, links) override it.
dist/markdown-transformer/markdownToDocs.js:1021:    if (context.defaultForegroundColor && context.currentIndex > context.startIndex) {
dist/markdown-transformer/markdownToDocs.js-1022-        const baseRange = {
dist/markdown-transformer/markdownToDocs.js-1023-            startIndex: context.startIndex,
dist/markdown-transformer/markdownToDocs.js-1024-            endIndex: context.currentIndex,
dist/markdown-transformer/markdownToDocs.js-1025-        };
dist/markdown-transformer/markdownToDocs.js-1026-        if (context.tabId) {
--
dist/markdown-transformer/markdownToDocs.js-1028-        }
dist/markdown-transformer/markdownToDocs.js-1029-        context.formatRequests.push({
dist/markdown-transformer/markdownToDocs.js-1030-            updateTextStyle: {
dist/markdown-transformer/markdownToDocs.js-1031-                range: baseRange,
dist/markdown-transformer/markdownToDocs.js-1032-                textStyle: {
dist/markdown-transformer/markdownToDocs.js:1033:                    foregroundColor: {
dist/markdown-transformer/markdownToDocs.js:1034:                        color: { rgbColor: context.defaultForegroundColor },
dist/markdown-transformer/markdownToDocs.js-1035-                    },
dist/markdown-transformer/markdownToDocs.js-1036-                },
dist/markdown-transformer/markdownToDocs.js:1037:                fields: 'foregroundColor',
dist/markdown-transformer/markdownToDocs.js-1038-            },
dist/markdown-transformer/markdownToDocs.js-1039-        });
dist/markdown-transformer/markdownToDocs.js-1040-    }
dist/markdown-transformer/markdownToDocs.js-1041-    // Character-level formatting (bold, italic, strikethrough, code, links)
dist/markdown-transformer/markdownToDocs.js-1042-    for (const range of context.textRanges) {
--
dist/markdown-transformer/markdownToDocs.js-1050-        if (range.formatting.bold ||
dist/markdown-transformer/markdownToDocs.js-1051-            range.formatting.italic ||
dist/markdown-transformer/markdownToDocs.js-1052-            range.formatting.strikethrough ||
dist/markdown-transformer/markdownToDocs.js-1053-            range.formatting.code ||
dist/markdown-transformer/markdownToDocs.js-1054-            range.formatting.underline ||
dist/markdown-transformer/markdownToDocs.js:1055:            range.formatting.foregroundColor ||
dist/markdown-transformer/markdownToDocs.js-1056-            range.formatting.backgroundColor ||
dist/markdown-transformer/markdownToDocs.js-1057-            range.formatting.fontSize ||
dist/markdown-transformer/markdownToDocs.js-1058-            range.formatting.fontFamily) {
dist/markdown-transformer/markdownToDocs.js-1059-            const styleRequest = buildUpdateTextStyleRequest(range.startIndex, range.endIndex, formattingToTextStyle(range.formatting), context.tabId);
dist/markdown-transformer/markdownToDocs.js-1060-            if (styleRequest) {
--
tests/markdownTransformer.test.js-231-                                {
tests/markdownTransformer.test.js-232-                                    textRun: {
tests/markdownTransformer.test.js-233-                                        content: 'Styled',
tests/markdownTransformer.test.js-234-                                        textStyle: {
tests/markdownTransformer.test.js-235-                                            underline: true,
tests/markdownTransformer.test.js:236:                                            foregroundColor: { color: { rgbColor: { red: 1, green: 0, blue: 0 } } },
tests/markdownTransformer.test.js-237-                                            backgroundColor: { color: { rgbColor: { red: 1, green: 1, blue: 0 } } },
tests/markdownTransformer.test.js-238-                                            fontSize: { magnitude: 14, unit: 'PT' },
tests/markdownTransformer.test.js-239-                                            weightedFontFamily: { fontFamily: 'Arial' },
tests/markdownTransformer.test.js-240-                                        },
tests/markdownTransformer.test.js-241-                                    },
--
tests/markdownTransformer.test.js-267-                                {
tests/markdownTransformer.test.js-268-                                    textRun: {
tests/markdownTransformer.test.js-269-                                        content: 'Styled\n',
tests/markdownTransformer.test.js-270-                                        textStyle: {
tests/markdownTransformer.test.js-271-                                            underline: true,
tests/markdownTransformer.test.js:272:                                            foregroundColor: { color: { rgbColor: { red: 1, green: 0, blue: 0 } } },
tests/markdownTransformer.test.js-273-                                        },
tests/markdownTransformer.test.js-274-                                    },
tests/markdownTransformer.test.js-275-                                },
tests/markdownTransformer.test.js-276-                            ],
tests/markdownTransformer.test.js-277-                        },
--
tests/markdownTransformer.test.js-578-
tests/markdownTransformer.test.js-579-    it('parses rich inline HTML formatting into text style requests', () => {
tests/markdownTransformer.test.js-580-        const { requests, warnings } = convertMarkdownToRequests('<u><span style="color:#ff0000; background-color:#ffff00; font-size:14pt; font-family:Arial">Styled</span></u>', 1);
tests/markdownTransformer.test.js-581-        const richRequest = requests.find(r =>
tests/markdownTransformer.test.js-582-            r.updateTextStyle?.textStyle?.underline === true &&
tests/markdownTransformer.test.js:583:            r.updateTextStyle?.textStyle?.foregroundColor?.color?.rgbColor?.red === 1 &&
tests/markdownTransformer.test.js-584-            r.updateTextStyle?.textStyle?.backgroundColor?.color?.rgbColor?.red === 1 &&
tests/markdownTransformer.test.js-585-            r.updateTextStyle?.textStyle?.fontSize?.magnitude === 14 &&
tests/markdownTransformer.test.js-586-            r.updateTextStyle?.textStyle?.weightedFontFamily?.fontFamily === 'Arial'
tests/markdownTransformer.test.js-587-        );
tests/markdownTransformer.test.js-588-        expect(richRequest).toBeDefined();
--
tests/markdownTransformer.test.js-614-        );
tests/markdownTransformer.test.js-615-        expect(alignmentRequest).toBeDefined();
tests/markdownTransformer.test.js-616-    });
tests/markdownTransformer.test.js-617-
tests/markdownTransformer.test.js-618-    // --- Issue #14: default foreground color ---
tests/markdownTransformer.test.js:619:    it('adds base foreground color when defaultForegroundColor option is provided', () => {
tests/markdownTransformer.test.js-620-        const { requests } = convertMarkdownToRequests('Hello world', 1, undefined, {
tests/markdownTransformer.test.js:621:            defaultForegroundColor: { red: 0, green: 0, blue: 0 },
tests/markdownTransformer.test.js-622-        });
tests/markdownTransformer.test.js-623-        const colorRequests = requests.filter(r =>
tests/markdownTransformer.test.js:624:            r.updateTextStyle?.fields === 'foregroundColor'
tests/markdownTransformer.test.js-625-        );
tests/markdownTransformer.test.js-626-        expect(colorRequests.length).toBe(1);
tests/markdownTransformer.test.js:627:        expect(colorRequests[0].updateTextStyle.textStyle.foregroundColor.color.rgbColor).toEqual({
tests/markdownTransformer.test.js-628-            red: 0, green: 0, blue: 0,
tests/markdownTransformer.test.js-629-        });
tests/markdownTransformer.test.js-630-    });
tests/markdownTransformer.test.js-631-
tests/markdownTransformer.test.js-632-    it('base foreground color covers the full inserted range', () => {
tests/markdownTransformer.test.js-633-        const { requests } = convertMarkdownToRequests('Hello world', 5, undefined, {
tests/markdownTransformer.test.js:634:            defaultForegroundColor: { red: 0, green: 0, blue: 0 },
tests/markdownTransformer.test.js-635-        });
tests/markdownTransformer.test.js-636-        const colorReq = requests.find(r =>
tests/markdownTransformer.test.js:637:            r.updateTextStyle?.fields === 'foregroundColor'
tests/markdownTransformer.test.js-638-        );
tests/markdownTransformer.test.js-639-        expect(colorReq).toBeDefined();
tests/markdownTransformer.test.js-640-        expect(colorReq.updateTextStyle.range.startIndex).toBe(5);
tests/markdownTransformer.test.js-641-        // endIndex should be > startIndex (covers the inserted text)
tests/markdownTransformer.test.js-642-        expect(colorReq.updateTextStyle.range.endIndex).toBeGreaterThan(5);
tests/markdownTransformer.test.js-643-    });
tests/markdownTransformer.test.js-644-
tests/markdownTransformer.test.js-645-    it('does not add foreground color when option is not provided', () => {
tests/markdownTransformer.test.js-646-        const { requests } = convertMarkdownToRequests('Hello world', 1);
tests/markdownTransformer.test.js-647-        const colorRequests = requests.filter(r =>
tests/markdownTransformer.test.js:648:            r.updateTextStyle?.fields === 'foregroundColor'
tests/markdownTransformer.test.js-649-        );
tests/markdownTransformer.test.js-650-        expect(colorRequests.length).toBe(0);
tests/markdownTransformer.test.js-651-    });
tests/markdownTransformer.test.js-652-
tests/markdownTransformer.test.js-653-    it('includes tabId in foreground color request when tabId is provided', () => {
tests/markdownTransformer.test.js-654-        const { requests } = convertMarkdownToRequests('Hello', 1, 'tab-42', {
tests/markdownTransformer.test.js:655:            defaultForegroundColor: { red: 0, green: 0, blue: 0 },
tests/markdownTransformer.test.js-656-        });
tests/markdownTransformer.test.js-657-        const colorReq = requests.find(r =>
tests/markdownTransformer.test.js:658:            r.updateTextStyle?.fields === 'foregroundColor'
tests/markdownTransformer.test.js-659-        );
tests/markdownTransformer.test.js-660-        expect(colorReq).toBeDefined();
tests/markdownTransformer.test.js-661-        expect(colorReq.updateTextStyle.range.tabId).toBe('tab-42');
tests/markdownTransformer.test.js-662-    });
tests/markdownTransformer.test.js-663-
tests/markdownTransformer.test.js-664-    it('supports non-black default colors (e.g. document with dark theme)', () => {
tests/markdownTransformer.test.js-665-        const { requests } = convertMarkdownToRequests('Hello', 1, undefined, {
tests/markdownTransformer.test.js:666:            defaultForegroundColor: { red: 1, green: 1, blue: 1 },
tests/markdownTransformer.test.js-667-        });
tests/markdownTransformer.test.js-668-        const colorReq = requests.find(r =>
tests/markdownTransformer.test.js:669:            r.updateTextStyle?.fields === 'foregroundColor'
tests/markdownTransformer.test.js-670-        );
tests/markdownTransformer.test.js:671:        expect(colorReq.updateTextStyle.textStyle.foregroundColor.color.rgbColor).toEqual({
tests/markdownTransformer.test.js-672-            red: 1, green: 1, blue: 1,
tests/markdownTransformer.test.js-673-        });
tests/markdownTransformer.test.js-674-    });
tests/markdownTransformer.test.js-675-
tests/markdownTransformer.test.js-676-    it('warns when a markdown image is dropped', () => {
--
tests/markdownTransformer.test.js-754-        const { requests } = convertMarkdownToRequests(
tests/markdownTransformer.test.js-755-            '<span style="color:#ff0000">before <span style="font-weight:bold">inner</span> after</span>',
tests/markdownTransformer.test.js-756-            1
tests/markdownTransformer.test.js-757-        );
tests/markdownTransformer.test.js-758-        const redRanges = requests
tests/markdownTransformer.test.js:759:            .filter(r => r.updateTextStyle?.textStyle?.foregroundColor?.color?.rgbColor?.red === 1)
tests/markdownTransformer.test.js-760-            .map(r => r.updateTextStyle.range);
tests/markdownTransformer.test.js-761-        expect(redRanges).toEqual([
tests/markdownTransformer.test.js-762-            { startIndex: 1, endIndex: 8 },
tests/markdownTransformer.test.js-763-            { startIndex: 8, endIndex: 13 },
tests/markdownTransformer.test.js-764-            { startIndex: 13, endIndex: 19 },
--
tests/markdownTransformer.test.js-769-        const { requests } = convertMarkdownToRequests(
tests/markdownTransformer.test.js-770-            '<span style="color:#ff0000">before <span style="color:#00ff00">inner</span> after</span>',
tests/markdownTransformer.test.js-771-            1
tests/markdownTransformer.test.js-772-        );
tests/markdownTransformer.test.js-773-        const colorRanges = requests
tests/markdownTransformer.test.js:774:            .filter(r => r.updateTextStyle?.textStyle?.foregroundColor)
tests/markdownTransformer.test.js-775-            .map(r => ({
tests/markdownTransformer.test.js-776-                range: r.updateTextStyle.range,
tests/markdownTransformer.test.js:777:                color: r.updateTextStyle.textStyle.foregroundColor.color.rgbColor,
tests/markdownTransformer.test.js-778-            }));
tests/markdownTransformer.test.js-779-        expect(colorRanges).toEqual([
tests/markdownTransformer.test.js-780-            { range: { startIndex: 1, endIndex: 8 }, color: { red: 1, green: 0, blue: 0 } },
tests/markdownTransformer.test.js-781-            { range: { startIndex: 8, endIndex: 13 }, color: { red: 0, green: 1, blue: 0 } },
tests/markdownTransformer.test.js-782-            { range: { startIndex: 13, endIndex: 19 }, color: { red: 1, green: 0, blue: 0 } },
--
tests/markdownTransformer.test.js-796-    it('warns for a recognized CSS property expressed in an unsupported format inside <span>', () => {
tests/markdownTransformer.test.js-797-        const { requests, warnings } = convertMarkdownToRequests('<span style="color:red">important</span>', 1);
tests/markdownTransformer.test.js-798-        expect(warnings).toHaveLength(1);
tests/markdownTransformer.test.js-799-        expect(warnings[0]).toContain('color: red');
tests/markdownTransformer.test.js-800-        expect(warnings[0]).toContain('expected a 6-digit hex value');
tests/markdownTransformer.test.js:801:        expect(requests.some(r => r.updateTextStyle?.textStyle?.foregroundColor)).toBe(false);
tests/markdownTransformer.test.js-802-    });
tests/markdownTransformer.test.js-803-
tests/markdownTransformer.test.js-804-    it('warns for font-size expressed in an unsupported unit inside <span>', () => {
tests/markdownTransformer.test.js-805-        const { requests, warnings } = convertMarkdownToRequests('<span style="font-size:12px">important</span>', 1);
tests/markdownTransformer.test.js-806-        expect(warnings).toHaveLength(1);
--
tests/markdownTransformer.test.js-833-        // this must still warn instead of being treated as "handled".
tests/markdownTransformer.test.js-834-        const { requests, warnings } = convertMarkdownToRequests('<p style="color:#ff0000">Colored paragraph</p>', 1);
tests/markdownTransformer.test.js-835-        expect(warnings).toHaveLength(1);
tests/markdownTransformer.test.js-836-        expect(warnings[0]).toContain('color: #ff0000');
tests/markdownTransformer.test.js-837-        expect(warnings[0]).toContain('only applied on inline elements like <span>');
tests/markdownTransformer.test.js:838:        expect(requests.some(r => r.updateTextStyle?.textStyle?.foregroundColor)).toBe(false);
tests/markdownTransformer.test.js-839-    });
tests/markdownTransformer.test.js-840-
tests/markdownTransformer.test.js-841-    it('warns when text-align is used on an inline <span> where it cannot be applied', () => {
tests/markdownTransformer.test.js-842-        const { warnings } = convertMarkdownToRequests('<span style="text-align:center">x</span>', 1);
tests/markdownTransformer.test.js-843-        expect(warnings).toHaveLength(1);
--
tests/defaultTextColor.test.js-40-// A NORMAL_TEXT named style with an explicit RGB default color — the stock
tests/defaultTextColor.test.js-41-// Google Docs template shape.
tests/defaultTextColor.test.js-42-const DEFAULT_RGB = { red: 0.1, green: 0.2, blue: 0.3 };
tests/defaultTextColor.test.js-43-function namedStylesResponse(rgb = DEFAULT_RGB) {
tests/defaultTextColor.test.js-44-    const textStyle = rgb === 'theme'
tests/defaultTextColor.test.js:45:        ? { foregroundColor: { color: { themeColor: 'TEXT1' } } }
tests/defaultTextColor.test.js:46:        : (rgb ? { foregroundColor: { color: { rgbColor: rgb } } } : {});
tests/defaultTextColor.test.js-47-    return {
tests/defaultTextColor.test.js-48-        data: {
tests/defaultTextColor.test.js-49-            namedStyles: {
tests/defaultTextColor.test.js-50-                styles: [
tests/defaultTextColor.test.js-51-                    { namedStyleType: 'NORMAL_TEXT', textStyle },
--
tests/defaultTextColor.test.js-54-        },
tests/defaultTextColor.test.js-55-    };
tests/defaultTextColor.test.js-56-}
tests/defaultTextColor.test.js-57-
tests/defaultTextColor.test.js-58-function colorRequestsIn(requests) {
tests/defaultTextColor.test.js:59:    return requests.filter((r) => r.updateTextStyle?.fields === 'foregroundColor');
tests/defaultTextColor.test.js-60-}
tests/defaultTextColor.test.js-61-
tests/defaultTextColor.test.js-62-beforeEach(() => {
tests/defaultTextColor.test.js-63-    fakeDrive = { files: { get: async () => ({ data: { modifiedTime: null } }) } };
tests/defaultTextColor.test.js-64-});
--
tests/defaultTextColor.test.js-72-        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl, requests: requestBody.requests } }));
tests/defaultTextColor.test.js-73-        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
tests/defaultTextColor.test.js-74-        return { documentsGet, batchUpdate };
tests/defaultTextColor.test.js-75-    }
tests/defaultTextColor.test.js-76-
tests/defaultTextColor.test.js:77:    it('insert: emits a foregroundColor request over the newly inserted range, sourced from NORMAL_TEXT', async () => {
tests/defaultTextColor.test.js-78-        const documentId = `modify-insert-${Date.now()}`;
tests/defaultTextColor.test.js-79-        const { batchUpdate } = setUpDocsMock();
tests/defaultTextColor.test.js-80-        trackRead(documentId, null, null, 'rev-read');
tests/defaultTextColor.test.js-81-
tests/defaultTextColor.test.js-82-        const server = createMockServer();
--
tests/defaultTextColor.test.js-88-
tests/defaultTextColor.test.js-89-        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
tests/defaultTextColor.test.js-90-        const colorRequests = colorRequestsIn(requests);
tests/defaultTextColor.test.js-91-        expect(colorRequests).toHaveLength(1);
tests/defaultTextColor.test.js-92-        expect(colorRequests[0].updateTextStyle.range).toEqual({ startIndex: 5, endIndex: 10 });
tests/defaultTextColor.test.js:93:        expect(colorRequests[0].updateTextStyle.textStyle.foregroundColor.color.rgbColor).toEqual(DEFAULT_RGB);
tests/defaultTextColor.test.js-94-    });
tests/defaultTextColor.test.js-95-
tests/defaultTextColor.test.js-96-    it('replace: colors the newly inserted replacement range, not the deleted one', async () => {
tests/defaultTextColor.test.js-97-        const documentId = `modify-replace-${Date.now()}`;
tests/defaultTextColor.test.js-98-        const { batchUpdate } = setUpDocsMock();
--
tests/defaultTextColor.test.js-109-        const colorRequests = colorRequestsIn(requests);
tests/defaultTextColor.test.js-110-        expect(colorRequests).toHaveLength(1);
tests/defaultTextColor.test.js-111-        expect(colorRequests[0].updateTextStyle.range).toEqual({ startIndex: 5, endIndex: 5 + 'longer replacement'.length });
tests/defaultTextColor.test.js-112-    });
tests/defaultTextColor.test.js-113-
tests/defaultTextColor.test.js:114:    it('caller-supplied style.foregroundColor still wins over the default paint', async () => {
tests/defaultTextColor.test.js-115-        const documentId = `modify-caller-color-${Date.now()}`;
tests/defaultTextColor.test.js-116-        const { batchUpdate } = setUpDocsMock();
tests/defaultTextColor.test.js-117-        trackRead(documentId, null, null, 'rev-read');
tests/defaultTextColor.test.js-118-
tests/defaultTextColor.test.js-119-        const server = createMockServer();
tests/defaultTextColor.test.js-120-        registerModifyText(server);
tests/defaultTextColor.test.js-121-        await server.getTool('modifyText').execute(
tests/defaultTextColor.test.js:122:            { documentId, target: { insertionIndex: 5 }, text: 'hi', style: { foregroundColor: '#ff0000' } },
tests/defaultTextColor.test.js-123-            { log: noopLog }
tests/defaultTextColor.test.js-124-        );
tests/defaultTextColor.test.js-125-
tests/defaultTextColor.test.js-126-        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
tests/defaultTextColor.test.js-127-        const colorRequests = colorRequestsIn(requests);
tests/defaultTextColor.test.js-128-        // Both the default-color paint and the caller's explicit style produce a
tests/defaultTextColor.test.js:129:        // foregroundColor request; the caller's must be the LAST one applied.
tests/defaultTextColor.test.js-130-        expect(colorRequests.length).toBeGreaterThanOrEqual(1);
tests/defaultTextColor.test.js-131-        const last = colorRequests[colorRequests.length - 1];
tests/defaultTextColor.test.js:132:        expect(last.updateTextStyle.textStyle.foregroundColor.color.rgbColor).toEqual({ red: 1, green: 0, blue: 0 });
tests/defaultTextColor.test.js-133-    });
tests/defaultTextColor.test.js-134-
tests/defaultTextColor.test.js-135-    it('theme-color-based NORMAL_TEXT (no rgbColor): inserts inherit-only, no error', async () => {
tests/defaultTextColor.test.js-136-        const documentId = `modify-theme-${Date.now()}`;
tests/defaultTextColor.test.js-137-        const documentsGet = jest.fn(async ({ fields } = {}) => {
tests/defaultTextColor.test.js-138-            if (fields === 'namedStyles') {
tests/defaultTextColor.test.js-139-                return { data: { namedStyles: { styles: [{
tests/defaultTextColor.test.js-140-                    namedStyleType: 'NORMAL_TEXT',
tests/defaultTextColor.test.js:141:                    textStyle: { foregroundColor: { color: { themeColor: 'TEXT1' } } },
tests/defaultTextColor.test.js-142-                }] } } };
tests/defaultTextColor.test.js-143-            }
tests/defaultTextColor.test.js-144-            return { data: {} };
tests/defaultTextColor.test.js-145-        });
tests/defaultTextColor.test.js-146-        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl, requests: requestBody.requests } }));
--
tests/defaultTextColor.test.js-199-        expect(colorRequestsIn(requests)).toHaveLength(0);
tests/defaultTextColor.test.js-200-    });
tests/defaultTextColor.test.js-201-});
tests/defaultTextColor.test.js-202-
tests/defaultTextColor.test.js-203-describe('markdown insertion — implicit black default text color (issue #14)', () => {
tests/defaultTextColor.test.js:204:    it('paints stock-document markdown text explicitly when NORMAL_TEXT omits foregroundColor', async () => {
tests/defaultTextColor.test.js-205-        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
tests/defaultTextColor.test.js-206-        const docs = {
tests/defaultTextColor.test.js-207-            documents: {
tests/defaultTextColor.test.js-208-                get: jest.fn(async ({ fields } = {}) => {
tests/defaultTextColor.test.js-209-                    if (fields === 'namedStyles') {
--
tests/defaultTextColor.test.js-221-        await insertMarkdown(docs, 'markdown-default-black', '# Title\n\nParagraph\n\n- Bullet');
tests/defaultTextColor.test.js-222-
tests/defaultTextColor.test.js-223-        const requests = batchUpdate.mock.calls.flatMap((call) => call[0].requestBody.requests);
tests/defaultTextColor.test.js-224-        const colorRequests = colorRequestsIn(requests);
tests/defaultTextColor.test.js-225-        expect(colorRequests).toHaveLength(1);
tests/defaultTextColor.test.js:226:        expect(colorRequests[0].updateTextStyle.textStyle.foregroundColor.color.rgbColor)
tests/defaultTextColor.test.js-227-            .toEqual({ red: 0, green: 0, blue: 0 });
tests/defaultTextColor.test.js-228-    });
tests/defaultTextColor.test.js-229-
tests/defaultTextColor.test.js-230-    it('treats Googles empty RGB payload as implicit black, not an empty direct paint', async () => {
tests/defaultTextColor.test.js-231-        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
--
tests/defaultTextColor.test.js-236-                        // This is the live Docs payload for its stock black
tests/defaultTextColor.test.js-237-                        // NORMAL_TEXT value: proto JSON omits every zero
tests/defaultTextColor.test.js-238-                        // channel but retains the surrounding rgbColor object.
tests/defaultTextColor.test.js-239-                        return { data: { namedStyles: { styles: [{
tests/defaultTextColor.test.js-240-                            namedStyleType: 'NORMAL_TEXT',
tests/defaultTextColor.test.js:241:                            textStyle: { foregroundColor: { color: { rgbColor: {} } } },
tests/defaultTextColor.test.js-242-                        }] } } };
tests/defaultTextColor.test.js-243-                    }
tests/defaultTextColor.test.js-244-                    return { data: {} };
tests/defaultTextColor.test.js-245-                }),
tests/defaultTextColor.test.js-246-                batchUpdate,
--
tests/defaultTextColor.test.js-249-
tests/defaultTextColor.test.js-250-        await insertMarkdown(docs, 'markdown-empty-rgb', 'Font Color Probe');
tests/defaultTextColor.test.js-251-
tests/defaultTextColor.test.js-252-        const requests = batchUpdate.mock.calls.flatMap((call) => call[0].requestBody.requests);
tests/defaultTextColor.test.js-253-        const [colorRequest] = colorRequestsIn(requests);
tests/defaultTextColor.test.js:254:        expect(colorRequest.updateTextStyle.textStyle.foregroundColor.color.rgbColor)
tests/defaultTextColor.test.js-255-            .toEqual({ red: 0, green: 0, blue: 0 });
tests/defaultTextColor.test.js-256-    });
tests/defaultTextColor.test.js-257-});
tests/defaultTextColor.test.js-258-
tests/defaultTextColor.test.js-259-describe('appendText — explicit default text color (issue #14)', () => {

 succeeded in 2003ms:
// Issue #14 -- text inserted by the editing tools has no explicit font color,
// so Google Docs shows no color selected in the picker.
//
// ACCEPTANCE CHECK, not a repro. The report is a UI observation (select the
// text, open the font colour picker, no swatch is highlighted) that no tool
// call can see. What IS checkable, and is exactly the report's suggested fix --
// "When inserting text, explicitly set the foreground color to the document's
// default text color so that Google Docs recognizes it as having a defined
// color value" -- is that the document structure carries a foregroundColor on
// the runs the tool wrote.
export const name = 'issue-14-explicit-font-color';
export const issue = 14;
export const description = 'Acceptance: text written by replaceDocumentWithMarkdown must carry an explicit foreground color.';
export const expectedOnBase = 'fail';

export async function run(ctx) {
    const doc = await ctx.createDoc(ctx.title('#14 explicit font color'), 'Placeholder body replaced below.');
    await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });

    await ctx.call('replaceDocumentWithMarkdown', {
        documentId: doc.id,
        markdown: ctx.fixture('issue-14-font-color.md'),
    });

    const structure = JSON.parse(await ctx.call('readDocument', { documentId: doc.id, format: 'json' }));
    const runs = [];
    for (const element of structure.body?.content || []) {
        for (const run of element.paragraph?.elements || []) {
            const content = run.textRun?.content;
            if (!content || !content.trim()) continue;
            runs.push({ text: content.trim().slice(0, 40), hasColor: Boolean(run.textRun.textStyle?.foregroundColor) });
        }
    }

    ctx.assert(runs.length > 0, 'Setup failed: the document has no text runs after the push.');
    const uncolored = runs.filter((run) => !run.hasColor);
    ctx.assert(
        uncolored.length === 0,
        uncolored.length + ' of ' + runs.length + ' text run(s) written by replaceDocumentWithMarkdown carry no explicit '
        + 'foregroundColor (e.g. "' + uncolored[0].text + '"), so Google Docs treats them as "no color set" (#14).',
    );
}

import { z } from 'zod';
import { getDriveClient, getDocsClient } from '../../clients.js';
import { insertMarkdown, formatInsertResult, docsJsonToMarkdown } from '../../markdown-transformer/index.js';
import { getDefaultTextColor, buildDefaultColorStyleRequest, getBatchUpdateProgress } from '../../googleDocsApiHelpers.js';
import { trackRead } from '../../readTracker.js';
import { mintDocsReadHandle } from '../../docsHandles.js';
export function register(server) {
    server.addTool({
        name: 'createDocument',
        description: 'Creates a new empty Google Document. Optionally places it in a specific folder and adds initial text content.',
        parameters: z.object({
            title: z.string().min(1).describe('Title for the new document.'),
            parentFolderId: z
                .string()
                .optional()
                .describe('ID of folder where document should be created. If not provided, creates in Drive root.'),
            initialContent: z
                .string()
                .optional()
                .describe('Initial content to add to the document. By default, markdown syntax is converted to formatted Google Docs content (headings, bold, italic, links, tables, lists, and rich markdown HTML extensions).'),
            contentFormat: z
                .enum(['markdown', 'raw'])
                .optional()
                .default('markdown')
                .describe("How to interpret initialContent. 'markdown' (default) converts markdown to formatted Google Docs content. 'raw' inserts the text as-is without any conversion."),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Creating new document "${args.title}"`);
            try {
                const documentMetadata = {
                    name: args.title,
                    mimeType: 'application/vnd.google-apps.document',
                };
                if (args.parentFolderId) {
                    documentMetadata.parents = [args.parentFolderId];
                }
                const response = await drive.files.create({
                    requestBody: documentMetadata,
                    fields: 'id,name,webViewLink',
                    supportsAllDrives: true,
                });
                const document = response.data;
                // The Docs client is acquired lazily, inside each branch that
                // actually needs it, rather than hoisted here: the Drive file
                // above is already created by this point, so a Docs-client
                // failure (auth misconfig, transient outage, whatever) must
                // not fail the whole tool and orphan that file â€” it degrades
                // to a warning naming the created document instead. `docs` is
                // cached once obtained so the seeding step below reuses the
                // same client rather than re-acquiring it.
                let docs;
                const ensureDocsClient = async () => {
                    if (!docs) docs = await getDocsClient();
                    return docs;
                };
                // Add initial content if provided
                let contentWarnings;
                let contentWarningNote;
                if (args.initialContent) {
                    try {
                        const docsClient = await ensureDocsClient();
                        if (args.contentFormat === 'raw') {
                            await docsClient.documents.batchUpdate({
                                documentId: document.id,
                                requestBody: {
                                    requests: [
                                        {
                                            insertText: {
                                                location: { index: 1 },
                                                text: args.initialContent,
                                            },
                                        },
                                    ],
                                },
                            });
                            // Explicitly paint the freshly-inserted raw text with
                            // the document's default foreground color (issue #14)
                            // â€” raw insertText carries no style at all otherwise.
                            // A failed color lookup/update doesn't undo the insert;
                            // it's surfaced as a warning instead of silently
                            // succeeding with unset color.
                            try {
                                const { color, error } = await getDefaultTextColor(docsClient, document.id);
                                if (error) {
                                    contentWarnings = [
                                        ...(contentWarnings ?? []),
                                        `Could not determine document default text color: ${error.message}`,
                                    ];
                                }
                                const colorRequest = buildDefaultColorStyleRequest(1, 1 + args.initialContent.length, color, undefined);
                                if (colorRequest) {
                                    await docsClient.documents.batchUpdate({
                                        documentId: document.id,
                                        requestBody: { requests: [colorRequest] },
                                    });
                                }
                            }
                            catch (colorError) {
                                log.warn(`Document created but failed to set default text color: ${colorError.message}`);
                                contentWarnings = [
                                    ...(contentWarnings ?? []),
                                    `Could not apply default text color to initial content: ${colorError.message}`,
                                ];
                            }
                        }
                        else {
                            const result = await insertMarkdown(docsClient, document.id, args.initialContent, {
                                startIndex: 1,
                                firstHeadingAsTitle: true,
                            });
                            log.info(formatInsertResult(result));
                            // Surface dropped-content warnings in the tool response itself â€”
                            // logging alone leaves the caller believing the initial content
                            // rendered faithfully (the same failure mode this warnings
                            // feature exists to close for appendMarkdown/replaceDocumentWithMarkdown).
                            if (result.warnings?.length) {
                                contentWarnings = result.warnings;
                            }
                        }
                    }
                    catch (contentError) {
                        // The Drive file above already exists at this point â€”
                        // an error here (including a failed getDocsClient()
                        // inside ensureDocsClient()) must not fail the whole
                        // tool and leave that document unreported (#87-style
                        // orphan). Degrade to a named warning instead.
                        log.warn(`Document ${document.id} created but failed to add initial content: ${contentError.message}`);
                        // The document itself exists, so preserve that success while
                        // making the partial result explicit without exposing an
                        // arbitrary caught API error to the caller.
                        //
                        // insertMarkdown's markdown path is NOT atomic: it sends
                        // delete/insert/format requests across separate
                        // documents.batchUpdate calls (and splits each phase into
                        // batches of 50), and every batch that succeeds before a
                        // later one fails is already committed to the document with
                        // no rollback. Claiming initial content "could not be added"
                        // would be false whenever an earlier batch already landed â€”
                        // a caller trusting that message and resending initialContent
                        // would duplicate whatever is already there. When progress
                        // info is available, say so explicitly and point at the
                        // document instead (PR #113 review finding 3).
                        const progress = getBatchUpdateProgress(contentError);
                        if (progress && progress.completedRequests > 0) {
                            contentWarnings = [
                                ...(contentWarnings ?? []),
                                'Document created but initial content was only partially applied before a later operation failed.',
                            ];
                            contentWarningNote = `The document was created and ${progress.completedRequests} of ${progress.totalRequests} content operation(s) (${progress.phase} phase) were already applied to it before the failure. Do not blindly resend initialContent â€” inspect the document with readDocument first to see what already landed, then reconcile or retry only what's missing.`;
                        }
                        else {
                            contentWarnings = [
                                ...(contentWarnings ?? []),
                                'Document created but initial content failed.',
                            ];
                            contentWarningNote = 'The document was created, but its initial content could not be added.';
                        }
                    }
                }
                // Seed post-create read state so an immediate follow-up mutation
                // doesn't fail as "unread" (#87 gap 2). The content is knowable for
                // every createDocument flow (raw, markdown, or empty) because we
                // control every write that produced it â€” but we fetch the document
                // back rather than trust our own inputs, so the seeded snapshot
                // matches exactly what a real readDocument call would return
                // (actual indices/structure, and whatever partial state resulted if
                // the initial-content step above warned or failed).
                let readHandle;
                try {
                    const docsClient = await ensureDocsClient();
                    const seedRes = await docsClient.documents.get({ documentId: document.id, fields: '*' });
                    const contentSource = seedRes.data;
                    const markdownContent = docsJsonToMarkdown(contentSource);
                    let modifiedTime = null;
                    try {
                        const modInfo = await drive.files.get({
                            fileId: document.id,
                            fields: 'modifiedTime',
                            supportsAllDrives: true,
                        });
                        modifiedTime = modInfo.data.modifiedTime || null;
                    }
                    catch { /* best effort; legacy guard tolerates a null modifiedTime */ }
                    trackRead(document.id, modifiedTime, markdownContent, seedRes.data.revisionId);
                    const minted = await mintDocsReadHandle({
                        documentId: document.id,
                        tabId: null,
                        revisionId: seedRes.data.revisionId ?? null,
                        contentSource,
                        content: markdownContent,
                    });
                    readHandle = minted?.readHandle;
                }
                catch (seedError) {
                    // The document itself was created successfully (including,
                    // when initialContent was provided, the content step
                    // above â€” this only covers the separate post-create
                    // fetch-and-mint-handle step). A Docs-client failure here
                    // (including inside ensureDocsClient()) must not fail the
                    // whole tool and hide that the document exists: it is
                    // reported as a named warning, and the next mutation must
                    // call readDocument first (fail closed) rather than this
                    // call throwing.
                    log.warn(`Document ${document.id} created but read state could not be seeded: ${seedError.message}`);
                    contentWarnings = [
                        ...(contentWarnings ?? []),
                        `Document ${document.id} was created, but its read state could not be seeded (${seedError.message}). ` +
                            'Call readDocument before the next mutation on this document.',
                    ];
                }
                return JSON.stringify({
                    id: document.id,
                    name: document.name,
                    url: document.webViewLink,
                    ...(contentWarnings && {
                        warnings: contentWarnings,
                        warningNote: contentWarningNote ?? `${contentWarnings.length} item${contentWarnings.length === 1 ? '' : 's'} of initialContent could not be converted and ${contentWarnings.length === 1 ? 'was' : 'were'} dropped â€” see warnings.`,
                    }),
                    ...(readHandle && {
                        readHandleNote: 'This document has been seeded as read. You can mutate it immediately without calling readDocument first.',
                    }),
                }, null, 2);
            }
            catch (error) {
                if (isPublicError(error)) throw error;
                log.error(`Error creating document: ${error.message || error}`);
                if (error.code === 404)
                    throw publicError('Parent folder not found. Check the folder ID.');
                if (error.code === 403)
                    throw publicError('Permission denied. Make sure you have write access to the destination folder.');
throw wrapOperationError('create document', error, { status: error?.code });
            }
        },
    });
}

 succeeded in 4307ms:
 * @param options - Optional: startIndex (default 1), tabId
 * @returns Debug metadata about the operation (request counts, timing, API calls)
 */
export async function insertMarkdown(docs, documentId, markdown, options) {
    const overallStart = performance.now();
    const startIndex = options?.startIndex ?? 1;
    const tabId = options?.tabId;
    const writeControl = options?.writeControl;
    // Fetch the document's default text style so we can explicitly set
    // foreground color on inserted text (fixes issue #14 â€” text without
    // explicit color shows "no color selected" in the Docs color picker).
    // Shared with every other insertion path via getDefaultTextColor so the
    // lookup and its "no rgb / fetch failed" semantics live in one place.
    const { color: defaultForegroundColor, error: defaultColorError } = await getDefaultTextColor(docs, documentId);
    if (defaultColorError) {
        // Operational problem (previously swallowed silently) â€” proceed
        // without an explicit color rather than failing the insertion.
        logger.warn(`insertMarkdown: could not fetch document default text color for ${documentId}: ${defaultColorError.message}`);
    }
    const parseStart = performance.now();
    const conversionOptions = {
        ...(options?.firstHeadingAsTitle && { firstHeadingAsTitle: true }),
        ...(defaultForegroundColor && { defaultForegroundColor }),
    };
    const { requests, warnings } = convertMarkdownToRequests(markdown, startIndex, tabId, conversionOptions);
    const parseElapsedMs = Math.round(performance.now() - parseStart);
    // Count requests by type
    const requestsByType = {};
    for (const r of requests) {
        const type = Object.keys(r)[0];
        requestsByType[type] = (requestsByType[type] || 0) + 1;
    }
    if (requests.length === 0) {
        return {
            warnings,
            totalRequests: 0,
            requestsByType,
            parseElapsedMs,
            batchUpdate: {
                totalRequests: 0,
                phases: {
                    delete: { requests: 0, apiCalls: 0, elapsedMs: 0 },
                    insert: { requests: 0, apiCalls: 0, elapsedMs: 0 },
                    format: { requests: 0, apiCalls: 0, elapsedMs: 0 },
                },
                totalApiCalls: 0,
                totalElapsedMs: 0,
            },
            totalElapsedMs: Math.round(performance.now() - overallStart),
        };
    }
    const batchUpdate = await executeBatchUpdateWithSplitting(docs, documentId, requests, undefined, writeControl);
    return {
        warnings,
        totalRequests: requests.length,
        requestsByType,
        parseElapsedMs,
        batchUpdate,
        totalElapsedMs: Math.round(performance.now() - overallStart),
    };
}
    if (!markdown || markdown.trim().length === 0) {
        return { requests: [], warnings: [] };
    }
    const parser = createParser();
    const tokens = parser.parse(markdown, {});
    const context = {
        startIndex,
        currentIndex: startIndex,
        insertRequests: [],
        formatRequests: [],
        textRanges: [],
        formattingStack: [],
        listStack: [],
        paragraphRanges: [],
        normalParagraphRanges: [],
        listSpacingRanges: [],
        pendingListItems: [],
        openListItemStack: [],
        hrRanges: [],
        codeBlockRanges: [],
        tableState: undefined,
        inTableCell: false,
        paragraphFormattingStack: [],
        htmlParagraphPushStack: [],
        htmlSpanPushStack: [],
        warningCounts: new Map(),
        tabId,
        titleConsumed: false,
        firstHeadingAsTitle: options?.firstHeadingAsTitle ?? false,
        defaultForegroundColor: options?.defaultForegroundColor ?? null,
    };
    try {
        for (const token of tokens) {
            processToken(token, context);
        }
        finalizeFormatting(context);
        return {
            requests: [...context.insertRequests, ...context.formatRequests],
            warnings: collectWarnings(context),
        };
    }
    catch (error) {
        if (error instanceof MarkdownConversionError) {
            throw error;
        }
        throw new MarkdownConversionError(`Failed to convert markdown: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
// --- Token Processing ---
function processToken(token, context) {
    switch (token.type) {
        // Headings
        case 'heading_open':
            handleHeadingOpen(token, context);
            break;
        case 'heading_close':
            handleHeadingClose(context);
            break;
        // Paragraphs
        case 'paragraph_open':
            handleParagraphOpen(context);
            break;
        case 'paragraph_close':
            handleParagraphClose(context);
            break;
        // Text content
        case 'text':
            handleTextToken(token, context);
            break;
        case 'code_inline':
            handleCodeInlineToken(token, context);
            break;
        case 'image': {
            const alt = token.content || getAttr(token, 'alt') || 'image';
            const src = getAttr(token, 'src') || 'unknown URL';
            addWarning(context, `Dropped image "${alt}" (${src}) â€” the Docs API path does not support inline images from markdown; use the insertImage tool instead.`);
            break;
        }
        // Inline formatting
        case 'strong_open':
            context.formattingStack.push({ bold: true });
            break;
        case 'strong_close':
            popFormatting(context, 'bold');
            break;
        case 'em_open':
            context.formattingStack.push({ italic: true });
            break;
        case 'em_close':
            popFormatting(context, 'italic');
            break;
        case 's_open':
            context.formattingStack.push({ strikethrough: true });
            break;
        case 's_close':
            popFormatting(context, 'strikethrough');
            break;
        // Links
        case 'link_open': {
            const href = getLinkHref(token);
            if (href) {
                context.formattingStack.push({ link: href });
            }
            break;
        }
        case 'link_close':
            popFormatting(context, 'link');
            break;
        // Lists
        case 'bullet_list_open':
            context.listStack.push({ type: 'bullet', level: context.listStack.length });
            break;
        case 'bullet_list_close':
            handleListClose(context);
            break;
        case 'ordered_list_open':
            context.listStack.push({ type: 'ordered', level: context.listStack.length });
            break;
        case 'ordered_list_close':
            handleListClose(context);
            break;
        case 'list_item_open':
            handleListItemOpen(context);
            break;
        case 'list_item_close':
            handleListItemClose(context);
            break;
        // Breaks
        case 'softbreak':
            if (context.inTableCell && context.tableState?.currentCell) {
                context.tableState.currentCell.text += ' ';
            }
            else {
                insertText(' ', context);
            }
            break;
        case 'hardbreak':
            if (context.inTableCell && context.tableState?.currentCell) {
                context.tableState.currentCell.text += '\n';
            }
            else {
                insertText('\n', context);
            }
            break;
        // Inline container
        case 'inline':
            if (token.children) {
                for (const child of token.children) {
                    processToken(child, context);
                }
            }
            break;
        // Tables
        case 'table_open':
            context.tableState = { rows: [], currentRow: [], inHeader: false, currentCell: null };
            break;
        case 'thead_open':
            if (context.tableState)
                context.tableState.inHeader = true;
            break;
        case 'thead_close':
            if (context.tableState)
                context.tableState.inHeader = false;
            break;
        case 'tbody_open':
        case 'tbody_close':
            break;
        case 'tr_open':
            if (context.tableState)
                context.tableState.currentRow = [];
            break;
        case 'tr_close':
            if (context.tableState && context.tableState.currentRow.length > 0) {
                context.tableState.rows.push([...context.tableState.currentRow]);
                context.tableState.currentRow = [];
            }
            break;
        case 'th_open':
        case 'td_open': {
            if (context.tableState) {
                const cellStyle = getAttr(token, 'style');
                const alignment = parseAlignmentFromStyle(cellStyle);
                const { unhandled } = parseStyleDeclarations(cellStyle, { allowAlignment: true, allowRunFormatting: false });
                addUnhandledStyleWarnings(context, token.type === 'th_open' ? 'th' : 'td', unhandled);
                context.tableState.currentCell = {
                    text: '',
                    isHeader: context.tableState.inHeader || token.type === 'th_open',
                    textRanges: [],
                    alignment,
                };
                context.inTableCell = true;
            }
            break;
        }
        case 'th_close':
        case 'td_close':
            if (context.tableState?.currentCell) {
                context.tableState.currentRow.push(context.tableState.currentCell);
                context.tableState.currentCell = null;
            }
            context.inTableCell = false;
            break;
        case 'table_close':
            if (context.tableState) {
                handleTableClose(context.tableState, context);
                context.tableState = undefined;
                context.inTableCell = false;
            }
            break;
        // Code blocks
        case 'fence':
        case 'code_block':
            handleCodeBlockToken(token, context);
            break;
        // Horizontal rules
        case 'hr':
            handleHorizontalRule(context);
            break;
        case 'blockquote_open':
            context.paragraphFormattingStack.push({
                indentStart: 36,
                borderLeft: true,
            });
            break;
        case 'blockquote_close':
            context.paragraphFormattingStack.pop();
            break;
        case 'html_inline':
            handleHtmlInlineToken(token, context);
            break;
        case 'html_block':
            handleHtmlBlockToken(token, context);
            break;
        default:
            if (token.content?.trim()) {
                addWarning(context, `Dropped unsupported markdown token "${token.type}" containing "${summarizeContent(token.content)}".`);
            }
            break;
    }
}
// --- Heading Handlers ---
function handleHeadingOpen(token, context) {
    const level = getHeadingLevel(token);
    if (level) {
        context.currentHeadingLevel = level;
        context.currentParagraphStart = context.currentIndex;
    }
}
function handleHeadingClose(context) {
    if (context.currentHeadingLevel && context.currentParagraphStart !== undefined) {
        // When firstHeadingAsTitle is enabled, the very first H1 becomes a TITLE.
        const useTitle = context.firstHeadingAsTitle && !context.titleConsumed && context.currentHeadingLevel === 1;
        if (useTitle) {
            context.titleConsumed = true;
        }
        context.paragraphRanges.push({
            startIndex: context.currentParagraphStart,
            endIndex: context.currentIndex,
            namedStyleType: useTitle ? 'TITLE' : `HEADING_${context.currentHeadingLevel}`,
        });
        insertText('\n', context);
        context.currentHeadingLevel = undefined;
        context.currentParagraphStart = undefined;
    }
}
// --- Horizontal Rule ---
function handleHorizontalRule(context) {
    if (!lastInsertEndsWithNewline(context)) {
        insertText('\n', context);
    }
    const start = context.currentIndex;
    insertText('\n', context);
    context.hrRanges.push({ startIndex: start, endIndex: context.currentIndex });
}
function handleHtmlInlineToken(token, context) {
    const parsed = parseRichHtmlTag(token.content);
    if (!parsed) {
        addWarning(context, `Dropped unsupported inline HTML "${summarizeContent(token.content)}".`);
        return;
    }
    const attrs = parseAttrs(parsed.attrs);
    if (parsed.selfClosing && parsed.tag !== 'br') {
        addWarning(context, `Dropped unsupported inline HTML <${parsed.tag}>.`);
        return;
    }
    if (parsed.closing) {
        switch (parsed.tag) {
            case 'u':
                popFormatting(context, 'underline');
                break;
            case 'mark':
                popFormatting(context, 'backgroundColor');
                break;
            case 'span': {
                const pushed = context.htmlSpanPushStack.pop();
                if (pushed)
                    popFormatting(context, 'richSpan');
                break;
            }
            case 'p':
            case 'div': {
                const pushed = context.htmlParagraphPushStack.pop();
                if (pushed)
                    context.paragraphFormattingStack.pop();
                break;
            }
            case 'blockquote':
                context.paragraphFormattingStack.pop();
                break;
            default:
                addWarning(context, `Ignored unsupported inline HTML tag </${parsed.tag}>; its text content was preserved where possible.`);
        }
        return;
    }
    switch (parsed.tag) {
        case 'u':
            context.formattingStack.push({ underline: true });
            break;
        case 'mark':
            context.formattingStack.push({ backgroundColor: '#FFF2CC' });
            break;
        case 'span': {
            const { formatting, unhandled } = parseStyleDeclarations(attrs.style);
            addUnhandledStyleWarnings(context, 'span', unhandled);
            if (hasFormatting(formatting)) {
                formatting.richSpan = true;
                context.formattingStack.push(formatting);
                context.htmlSpanPushStack.push(true);
            }
            else {
                context.htmlSpanPushStack.push(false);
            }
            break;
        }
        case 'p':
        case 'div': {
            const alignment = alignmentToDocs(attrs.align ?? '') ?? parseAlignmentFromStyle(attrs.style);
            const { unhandled } = parseStyleDeclarations(attrs.style, { allowAlignment: true, allowRunFormatting: false });
            addUnhandledStyleWarnings(context, parsed.tag, unhandled);
            if (alignment) {
                context.paragraphFormattingStack.push({ alignment });
                context.htmlParagraphPushStack.push(true);
            }
            else {
                context.htmlParagraphPushStack.push(false);
            }
            break;
        }
        case 'blockquote':
            context.paragraphFormattingStack.push({
                indentStart: 36,
                borderLeft: true,
            });
            break;
        case 'br':
            insertText('\n', context);
            break;
        default:
            addWarning(context, `Ignored unsupported inline HTML tag <${parsed.tag}>; its text content was preserved where possible.`);
    }
}
function handleHtmlBlockToken(token, context) {
    const content = token.content.trim();
    const match = content.match(/^<\s*(p|div|blockquote)\b([^>]*)>([\s\S]*)<\/\s*\1\s*>$/i);
    if (!match) {
        const tag = content.match(/^<\s*([a-z0-9]+)/i)?.[1]?.toLowerCase();
        addWarning(context, `Dropped unsupported HTML block${tag ? ` <${tag}>` : ''} containing "${summarizeContent(content)}".`);
        return;
    }
    const tag = match[1].toLowerCase();
    const attrs = parseAttrs(match[2]);
    const inner = match[3];
    let pushedParagraphFormatting = false;
    if (tag === 'blockquote') {
        context.paragraphFormattingStack.push({
            indentStart: 36,
            borderLeft: true,
        });
        pushedParagraphFormatting = true;
    }
    else {
        const alignment = alignmentToDocs(attrs.align ?? '') ?? parseAlignmentFromStyle(attrs.style);
        const { unhandled } = parseStyleDeclarations(attrs.style, { allowAlignment: true, allowRunFormatting: false });
        addUnhandledStyleWarnings(context, tag, unhandled);
        if (alignment) {
            context.paragraphFormattingStack.push({ alignment });
            pushedParagraphFormatting = true;
        }
    }
    const parser = createParser();
    for (const child of parser.parse(inner, {})) {

exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'rg -n -C 8 "defaultForegroundColor" dist/markdown-transformer/markdownToDocs.js; rg -n -C 6 "getDefaultTextColor" tests/defaultTextColor.test.js; Get-Content tests/defaultTextColor.test.js | Select-Object -First 270' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'rg -n -C 12 "async function getDefault|export async function getDefault|normalTextStyle" tests/defaultTextColor.test.js dist/googleDocsApiHelpers.js; $f='"'dist/googleDocsApiHelpers.js'; "'$l=Get-Content $f; $l[845..895]' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
 succeeded in 0ms:
252-        inTableCell: false,
253-        paragraphFormattingStack: [],
254-        htmlParagraphPushStack: [],
255-        htmlSpanPushStack: [],
256-        warningCounts: new Map(),
257-        tabId,
258-        titleConsumed: false,
259-        firstHeadingAsTitle: options?.firstHeadingAsTitle ?? false,
260:        defaultForegroundColor: options?.defaultForegroundColor ?? null,
261-    };
262-    try {
263-        for (const token of tokens) {
264-            processToken(token, context);
265-        }
266-        finalizeFormatting(context);
267-        return {
268-            requests: [...context.insertRequests, ...context.formatRequests],
--
1013-        }
1014-    }
1015-}
1016-// --- Finalization ---
1017-function finalizeFormatting(context) {
1018-    // Apply the document's default foreground color to the entire inserted range
1019-    // so text has an explicit color value in Google Docs (fixes issue #14).
1020-    // This goes first so intentional colors (code blocks, links) override it.
1021:    if (context.defaultForegroundColor && context.currentIndex > context.startIndex) {
1022-        const baseRange = {
1023-            startIndex: context.startIndex,
1024-            endIndex: context.currentIndex,
1025-        };
1026-        if (context.tabId) {
1027-            baseRange.tabId = context.tabId;
1028-        }
1029-        context.formatRequests.push({
1030-            updateTextStyle: {
1031-                range: baseRange,
1032-                textStyle: {
1033-                    foregroundColor: {
1034:                        color: { rgbColor: context.defaultForegroundColor },
1035-                    },
1036-                },
1037-                fields: 'foregroundColor',
1038-            },
1039-        });
1040-    }
1041-    // Character-level formatting (bold, italic, strikethrough, code, links)
1042-    for (const range of context.textRanges) {
// End-to-end coverage for issue #14 (explicit default text color on inserted
// text) across every insertion path that emits its own batchUpdate requests,
// per docs/plans/issue-14-explicit-font-color.md.
//
// The plan's original acceptance criteria could pass while modifyText (the
// path the issue actually reported) stayed broken, because they only
// exercised the pure markdown converter. These tests drive the REAL tool
// modules end-to-end with a mocked googleapis client (clients.js is the only
// mocked dependency â€” readTracker, docsHandles, and googleDocsApiHelpers run
// for real) and assert the emitted batchUpdate requests, mirroring
// tests/mutatingDocsToolsWriteControl.test.js and tests/extraDocsToolsWriteControl.test.js.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

let fakeDocs;
let fakeDrive;
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => fakeDocs,
    getDriveClient: async () => fakeDrive,
    getSheetsClient: async () => { throw new Error('not used'); },
    getCalendarClient: async () => { throw new Error('not used'); },
    getScriptClient: async () => { throw new Error('not used'); },
}));

const { trackRead } = await import('../dist/readTracker.js');
const { register: registerModifyText } = await import('../dist/tools/docs/modifyText.js');
const { register: registerAppendText } = await import('../dist/tools/docs/appendToGoogleDoc.js');
const { register: registerFindAndReplace } = await import('../dist/tools/docs/findAndReplace.js');
const { register: registerInsertTableWithData } = await import('../dist/tools/docs/insertTableWithData.js');
const { register: registerCreateDocument } = await import('../dist/tools/drive/createDocument.js');
const { register: registerCreateFromTemplate } = await import('../dist/tools/drive/createFromTemplate.js');
const { insertMarkdown } = await import('../dist/markdown-transformer/index.js');

function createMockServer() {
    const tools = new Map();
    return { addTool(def) { tools.set(def.name, def); }, getTool(name) { return tools.get(name); } };
}

const noopLog = { info() {}, error() {}, warn() {}, debug() {} };

// A NORMAL_TEXT named style with an explicit RGB default color â€” the stock
// Google Docs template shape.
const DEFAULT_RGB = { red: 0.1, green: 0.2, blue: 0.3 };
function namedStylesResponse(rgb = DEFAULT_RGB) {
    const textStyle = rgb === 'theme'
        ? { foregroundColor: { color: { themeColor: 'TEXT1' } } }
        : (rgb ? { foregroundColor: { color: { rgbColor: rgb } } } : {});
    return {
        data: {
            namedStyles: {
                styles: [
                    { namedStyleType: 'NORMAL_TEXT', textStyle },
                ],
            },
        },
    };
}

function colorRequestsIn(requests) {
    return requests.filter((r) => r.updateTextStyle?.fields === 'foregroundColor');
}

beforeEach(() => {
    fakeDrive = { files: { get: async () => ({ data: { modifiedTime: null } }) } };
});

describe('modifyText â€” explicit default text color (issue #14)', () => {
    function setUpDocsMock({ rgb = DEFAULT_RGB } = {}) {
        const documentsGet = jest.fn(async ({ fields } = {}) => {
            if (fields === 'namedStyles') return namedStylesResponse(rgb);
            return { data: {} };
        });
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl, requests: requestBody.requests } }));
        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
        return { documentsGet, batchUpdate };
    }

    it('insert: emits a foregroundColor request over the newly inserted range, sourced from NORMAL_TEXT', async () => {
        const documentId = `modify-insert-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock();
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerModifyText(server);
        await server.getTool('modifyText').execute(
            { documentId, target: { insertionIndex: 5 }, text: 'hello' },
            { log: noopLog }
        );

        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        const colorRequests = colorRequestsIn(requests);
        expect(colorRequests).toHaveLength(1);
        expect(colorRequests[0].updateTextStyle.range).toEqual({ startIndex: 5, endIndex: 10 });
        expect(colorRequests[0].updateTextStyle.textStyle.foregroundColor.color.rgbColor).toEqual(DEFAULT_RGB);
    });

    it('replace: colors the newly inserted replacement range, not the deleted one', async () => {
        const documentId = `modify-replace-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock();
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerModifyText(server);
        await server.getTool('modifyText').execute(
            { documentId, target: { startIndex: 5, endIndex: 8 }, text: 'longer replacement' },
            { log: noopLog }
        );

        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        const colorRequests = colorRequestsIn(requests);
        expect(colorRequests).toHaveLength(1);
        expect(colorRequests[0].updateTextStyle.range).toEqual({ startIndex: 5, endIndex: 5 + 'longer replacement'.length });
    });

    it('caller-supplied style.foregroundColor still wins over the default paint', async () => {
        const documentId = `modify-caller-color-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock();
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerModifyText(server);
        await server.getTool('modifyText').execute(
            { documentId, target: { insertionIndex: 5 }, text: 'hi', style: { foregroundColor: '#ff0000' } },
            { log: noopLog }
        );

        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        const colorRequests = colorRequestsIn(requests);
        // Both the default-color paint and the caller's explicit style produce a
        // foregroundColor request; the caller's must be the LAST one applied.
        expect(colorRequests.length).toBeGreaterThanOrEqual(1);
        const last = colorRequests[colorRequests.length - 1];
        expect(last.updateTextStyle.textStyle.foregroundColor.color.rgbColor).toEqual({ red: 1, green: 0, blue: 0 });
    });

    it('theme-color-based NORMAL_TEXT (no rgbColor): inserts inherit-only, no error', async () => {
        const documentId = `modify-theme-${Date.now()}`;
        const documentsGet = jest.fn(async ({ fields } = {}) => {
            if (fields === 'namedStyles') {
                return { data: { namedStyles: { styles: [{
                    namedStyleType: 'NORMAL_TEXT',
                    textStyle: { foregroundColor: { color: { themeColor: 'TEXT1' } } },
                }] } } };
            }
            return { data: {} };
        });
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl, requests: requestBody.requests } }));
        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerModifyText(server);
        const result = await server.getTool('modifyText').execute(
            { documentId, target: { insertionIndex: 5 }, text: 'hi' },
            { log: noopLog }
        );

        expect(result).toMatch(/Successfully/);
        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        expect(colorRequestsIn(requests)).toHaveLength(0);
    });

    it('style-only calls (no new text) never touch color, even with a resolvable default', async () => {
        const documentId = `modify-style-only-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock();
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerModifyText(server);
        await server.getTool('modifyText').execute(
            { documentId, target: { startIndex: 1, endIndex: 10 }, style: { bold: true } },
            { log: noopLog }
        );

        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        expect(colorRequestsIn(requests)).toHaveLength(0);
    });

    it('does not fail the insertion when the named-styles fetch fails â€” logs a warning instead', async () => {
        const documentId = `modify-fetch-fail-${Date.now()}`;
        const warn = jest.fn();
        const documentsGet = jest.fn(async ({ fields } = {}) => {
            if (fields === 'namedStyles') throw new Error('boom');
            return { data: {} };
        });
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl, requests: requestBody.requests } }));
        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerModifyText(server);
        const result = await server.getTool('modifyText').execute(
            { documentId, target: { insertionIndex: 1 }, text: 'hi' },
            { log: { ...noopLog, warn } }
        );

        expect(result).toMatch(/Successfully/);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not fetch document default text color/i));
        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        expect(colorRequestsIn(requests)).toHaveLength(0);
    });
});

describe('markdown insertion â€” implicit black default text color (issue #14)', () => {
    it('paints stock-document markdown text explicitly when NORMAL_TEXT omits foregroundColor', async () => {
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
        const docs = {
            documents: {
                get: jest.fn(async ({ fields } = {}) => {
                    if (fields === 'namedStyles') {
                        // Real stock Docs omit the implicit black default rather
                        // than echoing rgbColor, which hid this gap in the
                        // old mocked-RGB-only tests.
                        return { data: { namedStyles: { styles: [{ namedStyleType: 'NORMAL_TEXT', textStyle: {} }] } } };
                    }
                    return { data: {} };
                }),
                batchUpdate,
            },
        };

        await insertMarkdown(docs, 'markdown-default-black', '# Title\n\nParagraph\n\n- Bullet');

        const requests = batchUpdate.mock.calls.flatMap((call) => call[0].requestBody.requests);
        const colorRequests = colorRequestsIn(requests);
        expect(colorRequests).toHaveLength(1);
        expect(colorRequests[0].updateTextStyle.textStyle.foregroundColor.color.rgbColor)
            .toEqual({ red: 0, green: 0, blue: 0 });
    });

    it('treats Googles empty RGB payload as implicit black, not an empty direct paint', async () => {
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
        const docs = {
            documents: {
                get: jest.fn(async ({ fields } = {}) => {
                    if (fields === 'namedStyles') {
                        // This is the live Docs payload for its stock black
                        // NORMAL_TEXT value: proto JSON omits every zero
                        // channel but retains the surrounding rgbColor object.
                        return { data: { namedStyles: { styles: [{
                            namedStyleType: 'NORMAL_TEXT',
                            textStyle: { foregroundColor: { color: { rgbColor: {} } } },
                        }] } } };
                    }
                    return { data: {} };
                }),
                batchUpdate,
            },
        };

        await insertMarkdown(docs, 'markdown-empty-rgb', 'Font Color Probe');

        const requests = batchUpdate.mock.calls.flatMap((call) => call[0].requestBody.requests);
        const [colorRequest] = colorRequestsIn(requests);
        expect(colorRequest.updateTextStyle.textStyle.foregroundColor.color.rgbColor)
            .toEqual({ red: 0, green: 0, blue: 0 });
    });
});

describe('appendText â€” explicit default text color (issue #14)', () => {
    function setUpDocsMock({ rgb = DEFAULT_RGB } = {}) {
        const documentsGet = jest.fn(async ({ fields } = {}) => {
            if (fields === 'namedStyles') return namedStylesResponse(rgb);
            return { data: { body: { content: [{ endIndex: 10 }] } } };
        });
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl, requests: requestBody.requests } }));
        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
        return { documentsGet, batchUpdate };
    }

    it('colors the freshly appended range', async () => {

 succeeded in 6ms:
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'rg -n -C 6 "namedStyles" dist tests | Select-Object -First 180' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '$f='"'dist/markdown-transformer/markdownToDocs.js'; "'$l=Get-Content $f; $l[650..735]; $l[1540..1605]' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
 exited 1 in 371ms:
dist\docsIndex.js-33-
dist\docsIndex.js-34-/** Default cap on the serialized index payload. Mirrors helpers.js's budget. */
dist\docsIndex.js-35-export const DEFAULT_INDEX_MAX_RESPONSE_CHARS = 100000;
dist\docsIndex.js-36-
dist\docsIndex.js-37-// The body subtree both masks share. Everything the classifier reads and
dist\docsIndex.js-38-// nothing else: no textStyle, no paragraphStyle beyond namedStyleType, no
dist\docsIndex.js:39:// suggested* maps, no namedStyles, no inlineObjects/positionedObjects blobs.
dist\docsIndex.js-40-const INDEX_BODY_SUBTREE =
dist\docsIndex.js-41-    'content(startIndex,endIndex,' +
dist\docsIndex.js-42-    'paragraph(paragraphStyle(namedStyleType),bullet(listId,nestingLevel),' +
dist\docsIndex.js-43-    'elements(startIndex,endIndex,textRun(content),inlineObjectElement(inlineObjectId),horizontalRule,pageBreak,' +
dist\docsIndex.js-44-    'footnoteReference,columnBreak,equation,richLink,person,autoText)),' +
dist\docsIndex.js-45-    'table(rows,columns,tableRows(startIndex,endIndex,' +
--
dist\googleDocsApiHelpers.js-863- * @returns {Promise<{color: {red?:number,green?:number,blue?:number}|null, error: Error|null}>}
dist\googleDocsApiHelpers.js-864- */
dist\googleDocsApiHelpers.js-865-export async function getDefaultTextColor(docs, documentId) {
dist\googleDocsApiHelpers.js-866-    try {
dist\googleDocsApiHelpers.js-867-        const styleRes = await docs.documents.get({
dist\googleDocsApiHelpers.js-868-            documentId,
dist\googleDocsApiHelpers.js:869:            fields: 'namedStyles',
dist\googleDocsApiHelpers.js-870-        });
dist\googleDocsApiHelpers.js:871:        const normalTextStyle = styleRes.data.namedStyles?.styles?.find((s) => s.namedStyleType === 'NORMAL_TEXT');
dist\googleDocsApiHelpers.js-872-        const foregroundColor = normalTextStyle?.textStyle?.foregroundColor;
dist\googleDocsApiHelpers.js-873-        const rgbColor = foregroundColor?.color?.rgbColor;
dist\googleDocsApiHelpers.js-874-        // Google serializes an all-zero RGB value as `{}`. That is its
dist\googleDocsApiHelpers.js-875-        // inherit/default representation, not a usable direct paint: sending
dist\googleDocsApiHelpers.js-876-        // the empty object back in updateTextStyle leaves the run without an
dist\googleDocsApiHelpers.js-877-        // explicit foregroundColor. A color with at least one numeric channel
--
tests\batchModifyText.test.js-64-    return { startIndex: start + offset, endIndex: start + offset + needle.length };
tests\batchModifyText.test.js-65-}
tests\batchModifyText.test.js-66-
tests\batchModifyText.test.js-67-function makeGoogle(body, { revisionId = 'rev-read', tabId = null, color = null } = {}) {
tests\batchModifyText.test.js-68-    const batches = [];
tests\batchModifyText.test.js-69-    const documentsGet = jest.fn(async ({ fields, includeTabsContent }) => {
tests\batchModifyText.test.js:70:        if (fields === 'namedStyles') {
tests\batchModifyText.test.js-71-            return {
tests\batchModifyText.test.js-72-                data: {
tests\batchModifyText.test.js:73:                    namedStyles: {
tests\batchModifyText.test.js-74-                        styles: color
tests\batchModifyText.test.js-75-                            ? [{ namedStyleType: 'NORMAL_TEXT', textStyle: { foregroundColor: { color: { rgbColor: color } } } }]
tests\batchModifyText.test.js-76-                            : [],
tests\batchModifyText.test.js-77-                    },
tests\batchModifyText.test.js-78-                },
tests\batchModifyText.test.js-79-            };
--
tests\batchModifyText.test.js-321-        // The default body holds DIFFERENT text at different indices. A resolver
tests\batchModifyText.test.js-322-        // that ignored tabId would either miss or hit the wrong index.
tests\batchModifyText.test.js-323-        const defaultBody = buildBody(['padding padding padding padding', 'Only in the tab']);
tests\batchModifyText.test.js-324-        fakeDocs = {
tests\batchModifyText.test.js-325-            documents: {
tests\batchModifyText.test.js-326-                get: jest.fn(async ({ fields, includeTabsContent }) => {
tests\batchModifyText.test.js:327:                    if (fields === 'namedStyles') return { data: { namedStyles: { styles: [] } } };
tests\batchModifyText.test.js-328-                    if (includeTabsContent) {
tests\batchModifyText.test.js-329-                        return { data: { revisionId: 'rev-read', tabs: [{ tabProperties: { tabId }, documentTab: { body } }] } };
tests\batchModifyText.test.js-330-                    }
tests\batchModifyText.test.js-331-                    return { data: { revisionId: 'rev-read', body: defaultBody } };
tests\batchModifyText.test.js-332-                }),
tests\batchModifyText.test.js-333-                batchUpdate: jest.fn(async ({ requestBody }) => {
--
tests\batchModifyTextHandleIntegration.test.js-66-        }
tests\batchModifyTextHandleIntegration.test.js-67-        return elements;
tests\batchModifyTextHandleIntegration.test.js-68-    };
tests\batchModifyTextHandleIntegration.test.js-69-    fakeDocs = {
tests\batchModifyTextHandleIntegration.test.js-70-        documents: {
tests\batchModifyTextHandleIntegration.test.js-71-            get: jest.fn(async ({ fields }) => {
tests\batchModifyTextHandleIntegration.test.js:72:                if (fields === 'namedStyles') return { data: { namedStyles: { styles: [] } } };
tests\batchModifyTextHandleIntegration.test.js-73-                return { data: { revisionId: REVISION, body: { content: content() }, lists: {} } };
tests\batchModifyTextHandleIntegration.test.js-74-            }),
tests\batchModifyTextHandleIntegration.test.js-75-            batchUpdate: jest.fn(async () => ({ data: { writeControl: { requiredRevisionId: 'rev-after-write' } } })),
tests\batchModifyTextHandleIntegration.test.js-76-        },
tests\batchModifyTextHandleIntegration.test.js-77-    };
tests\batchModifyTextHandleIntegration.test.js-78-    batchUpdate = fakeDocs.documents.batchUpdate;
--
tests\defaultTextColor.test.js-37-
tests\defaultTextColor.test.js-38-const noopLog = { info() {}, error() {}, warn() {}, debug() {} };
tests\defaultTextColor.test.js-39-
tests\defaultTextColor.test.js-40-// A NORMAL_TEXT named style with an explicit RGB default color — the stock
tests\defaultTextColor.test.js-41-// Google Docs template shape.
tests\defaultTextColor.test.js-42-const DEFAULT_RGB = { red: 0.1, green: 0.2, blue: 0.3 };
tests\defaultTextColor.test.js:43:function namedStylesResponse(rgb = DEFAULT_RGB) {
tests\defaultTextColor.test.js-44-    const textStyle = rgb === 'theme'
tests\defaultTextColor.test.js-45-        ? { foregroundColor: { color: { themeColor: 'TEXT1' } } }
tests\defaultTextColor.test.js-46-        : (rgb ? { foregroundColor: { color: { rgbColor: rgb } } } : {});
tests\defaultTextColor.test.js-47-    return {
tests\defaultTextColor.test.js-48-        data: {
tests\defaultTextColor.test.js:49:            namedStyles: {
tests\defaultTextColor.test.js-50-                styles: [
tests\defaultTextColor.test.js-51-                    { namedStyleType: 'NORMAL_TEXT', textStyle },
tests\defaultTextColor.test.js-52-                ],
tests\defaultTextColor.test.js-53-            },
tests\defaultTextColor.test.js-54-        },
tests\defaultTextColor.test.js-55-    };
--
tests\defaultTextColor.test.js-63-    fakeDrive = { files: { get: async () => ({ data: { modifiedTime: null } }) } };
tests\defaultTextColor.test.js-64-});
tests\defaultTextColor.test.js-65-
tests\defaultTextColor.test.js-66-describe('modifyText — explicit default text color (issue #14)', () => {
tests\defaultTextColor.test.js-67-    function setUpDocsMock({ rgb = DEFAULT_RGB } = {}) {
tests\defaultTextColor.test.js-68-        const documentsGet = jest.fn(async ({ fields } = {}) => {
tests\defaultTextColor.test.js:69:            if (fields === 'namedStyles') return namedStylesResponse(rgb);
tests\defaultTextColor.test.js-70-            return { data: {} };
tests\defaultTextColor.test.js-71-        });
tests\defaultTextColor.test.js-72-        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl, requests: requestBody.requests } }));
tests\defaultTextColor.test.js-73-        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
tests\defaultTextColor.test.js-74-        return { documentsGet, batchUpdate };
tests\defaultTextColor.test.js-75-    }
--
tests\defaultTextColor.test.js-132-        expect(last.updateTextStyle.textStyle.foregroundColor.color.rgbColor).toEqual({ red: 1, green: 0, blue: 0 });
tests\defaultTextColor.test.js-133-    });
tests\defaultTextColor.test.js-134-
tests\defaultTextColor.test.js-135-    it('theme-color-based NORMAL_TEXT (no rgbColor): inserts inherit-only, no error', async () => {
tests\defaultTextColor.test.js-136-        const documentId = `modify-theme-${Date.now()}`;
tests\defaultTextColor.test.js-137-        const documentsGet = jest.fn(async ({ fields } = {}) => {
tests\defaultTextColor.test.js:138:            if (fields === 'namedStyles') {
tests\defaultTextColor.test.js:139:                return { data: { namedStyles: { styles: [{
tests\defaultTextColor.test.js-140-                    namedStyleType: 'NORMAL_TEXT',
tests\defaultTextColor.test.js-141-                    textStyle: { foregroundColor: { color: { themeColor: 'TEXT1' } } },
tests\defaultTextColor.test.js-142-                }] } } };
tests\defaultTextColor.test.js-143-            }
tests\defaultTextColor.test.js-144-            return { data: {} };
tests\defaultTextColor.test.js-145-        });
--
tests\defaultTextColor.test.js-176-    });
tests\defaultTextColor.test.js-177-
tests\defaultTextColor.test.js-178-    it('does not fail the insertion when the named-styles fetch fails — logs a warning instead', async () => {
tests\defaultTextColor.test.js-179-        const documentId = `modify-fetch-fail-${Date.now()}`;
tests\defaultTextColor.test.js-180-        const warn = jest.fn();
tests\defaultTextColor.test.js-181-        const documentsGet = jest.fn(async ({ fields } = {}) => {
tests\defaultTextColor.test.js:182:            if (fields === 'namedStyles') throw new Error('boom');
tests\defaultTextColor.test.js-183-            return { data: {} };
tests\defaultTextColor.test.js-184-        });
tests\defaultTextColor.test.js-185-        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl, requests: requestBody.requests } }));
tests\defaultTextColor.test.js-186-        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
tests\defaultTextColor.test.js-187-        trackRead(documentId, null, null, 'rev-read');
tests\defaultTextColor.test.js-188-
--
tests\defaultTextColor.test.js-203-describe('markdown insertion — implicit black default text color (issue #14)', () => {
tests\defaultTextColor.test.js-204-    it('paints stock-document markdown text explicitly when NORMAL_TEXT omits foregroundColor', async () => {
tests\defaultTextColor.test.js-205-        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
tests\defaultTextColor.test.js-206-        const docs = {
tests\defaultTextColor.test.js-207-            documents: {
tests\defaultTextColor.test.js-208-                get: jest.fn(async ({ fields } = {}) => {
tests\defaultTextColor.test.js:209:                    if (fields === 'namedStyles') {
tests\defaultTextColor.test.js-210-                        // Real stock Docs omit the implicit black default rather
tests\defaultTextColor.test.js-211-                        // than echoing rgbColor, which hid this gap in the
tests\defaultTextColor.test.js-212-                        // old mocked-RGB-only tests.
tests\defaultTextColor.test.js:213:                        return { data: { namedStyles: { styles: [{ namedStyleType: 'NORMAL_TEXT', textStyle: {} }] } } };
tests\defaultTextColor.test.js-214-                    }
tests\defaultTextColor.test.js-215-                    return { data: {} };
tests\defaultTextColor.test.js-216-                }),
tests\defaultTextColor.test.js-217-                batchUpdate,
tests\defaultTextColor.test.js-218-            },
tests\defaultTextColor.test.js-219-        };
--
tests\defaultTextColor.test.js-229-
tests\defaultTextColor.test.js-230-    it('treats Googles empty RGB payload as implicit black, not an empty direct paint', async () => {
tests\defaultTextColor.test.js-231-        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
tests\defaultTextColor.test.js-232-        const docs = {
tests\defaultTextColor.test.js-233-            documents: {
tests\defaultTextColor.test.js-234-                get: jest.fn(async ({ fields } = {}) => {
tests\defaultTextColor.test.js:235:                    if (fields === 'namedStyles') {
tests\defaultTextColor.test.js-236-                        // This is the live Docs payload for its stock black
tests\defaultTextColor.test.js-237-                        // NORMAL_TEXT value: proto JSON omits every zero
tests\defaultTextColor.test.js-238-                        // channel but retains the surrounding rgbColor object.
tests\defaultTextColor.test.js:239:                        return { data: { namedStyles: { styles: [{
tests\defaultTextColor.test.js-240-                            namedStyleType: 'NORMAL_TEXT',
tests\defaultTextColor.test.js-241-                            textStyle: { foregroundColor: { color: { rgbColor: {} } } },
tests\defaultTextColor.test.js-242-                        }] } } };
tests\defaultTextColor.test.js-243-                    }
tests\defaultTextColor.test.js-244-                    return { data: {} };
tests\defaultTextColor.test.js-245-                }),
--
tests\defaultTextColor.test.js-256-    });
tests\defaultTextColor.test.js-257-});
tests\defaultTextColor.test.js-258-
tests\defaultTextColor.test.js-259-describe('appendText — explicit default text color (issue #14)', () => {
tests\defaultTextColor.test.js-260-    function setUpDocsMock({ rgb = DEFAULT_RGB } = {}) {
tests\defaultTextColor.test.js-261-        const documentsGet = jest.fn(async ({ fields } = {}) => {

 succeeded in 114ms:
    // Track normal (non-list) paragraph ranges for spacing
    const paragraphStart = context.currentParagraphStart;
    if (!lastInsertEndsWithNewline(context)) {
        insertText('\n', context);
    }
    const currentListItem = getCurrentOpenListItem(context);
    if (currentListItem) {
        const paragraphEndIndex = lastInsertEndsWithNewline(context)
            ? context.currentIndex - 1
            : context.currentIndex;
        if (paragraphEndIndex > currentListItem.startIndex) {
            currentListItem.endIndex = paragraphEndIndex;
        }
    }
    // Record the range for normal paragraphs (not list items) so we can apply spacing later
    if (paragraphStart !== undefined && context.listStack.length === 0) {
        const paragraphRange = {
            startIndex: paragraphStart,
            endIndex: context.currentIndex,
        };
        const paragraphFormatting = mergeParagraphFormattingStack(context.paragraphFormattingStack);
        if (hasParagraphFormatting(paragraphFormatting)) {
            paragraphRange.formatting = paragraphFormatting;
        }
        context.normalParagraphRanges.push(paragraphRange);
    }
    context.currentParagraphStart = undefined;
}
// --- List Handlers ---
function handleListItemOpen(context) {
    if (context.listStack.length === 0) {
        throw new MarkdownConversionError('List item found outside of list context');
    }
    const currentList = context.listStack[context.listStack.length - 1];
    const itemStart = context.currentIndex;
    if (currentList.level > 0) {
        insertText('\t'.repeat(currentList.level), context);
    }
    const listItem = {
        startIndex: itemStart,
        nestingLevel: currentList.level,
        bulletPreset: currentList.type === 'ordered' ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE',
        taskPrefixProcessed: false,
    };
    context.pendingListItems.push(listItem);
    context.openListItemStack.push(context.pendingListItems.length - 1);
}
function handleListItemClose(context) {
    const openIndex = context.openListItemStack.pop();
    if (openIndex === undefined)
        return;
    const listItem = context.pendingListItems[openIndex];
    if (listItem.endIndex === undefined) {
        const computedEndIndex = lastInsertEndsWithNewline(context)
            ? context.currentIndex - 1
            : context.currentIndex;
        if (computedEndIndex > listItem.startIndex) {
            listItem.endIndex = computedEndIndex;
        }
    }
    if (!lastInsertEndsWithNewline(context)) {
        insertText('\n', context);
    }
}
function handleListClose(context) {
    context.listStack.pop();
    // When a top-level list closes (stack becomes empty), record the range of the
    // last list item's paragraph so we can apply spaceBelow to it. This creates a
    // visible gap between the end of a list and the following content.
    if (context.listStack.length === 0) {
        // Find the last pending list item that has a valid endIndex
        for (let i = context.pendingListItems.length - 1; i >= 0; i--) {
            const item = context.pendingListItems[i];
            if (item.endIndex !== undefined && item.endIndex > item.startIndex) {
                context.listSpacingRanges.push({
                    startIndex: item.startIndex,
                    endIndex: item.endIndex,
                });
                break;
            }
        }
    }
}
// --- Text Handling ---
function handleTextToken(token, context) {
    let text = token.content;

codex
The live trace shows `insertMarkdown` never generated its base color request: the Docs style lookup returned “no default style,” not an empty RGB value. I’ll make that response shape use the stock explicit black fallback, while retaining the existing no-paint behavior for a positively identified theme color.
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "@'
*** Begin Patch
*** Update File: dist/googleDocsApiHelpers.js
@@
-        if (normalTextStyle && "'!foregroundColor?.color?.themeColor) {
+        // A default Docs document can omit NORMAL_TEXT altogether from this
+        // partial response. That is the same stock black default as a present
+        // NORMAL_TEXT entry with no foregroundColor; leaving it null skips the
+        // color request entirely. Only a positively reported theme color must
+        // remain inherit-only, because converting that slot to RGB would pin
+        // it to the current theme.
+        if (!foregroundColor?.color?.themeColor) {
             return { color: { red: 0, green: 0, blue: 0 }, error: null };
         }
*** Update File: tests/defaultTextColor.test.js
@@
     it('"'treats Googles empty RGB payload as implicit black, not an empty direct paint', async () => {
@@
         expect(colorRequest.updateTextStyle.textStyle.foregroundColor.color.rgbColor)
             .toEqual({ red: 0, green: 0, blue: 0 });
     });
+
+    it('uses explicit black when Google omits NORMAL_TEXT from the partial style response', async () => {
+        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
+        const docs = {
+            documents: {
+                get: jest.fn(async () => ({ data: { namedStyles: { styles: [] } } })),
+                batchUpdate,
+            },
+        };
+
+        await insertMarkdown(docs, 'markdown-no-normal-text', 'Font Color Probe');
+
+        const requests = batchUpdate.mock.calls.flatMap((call) => call[0].requestBody.requests);
+        const [colorRequest] = colorRequestsIn(requests);
+        expect(colorRequest.updateTextStyle.textStyle.foregroundColor.color.rgbColor)
+            .toEqual({ red: 0, green: 0, blue: 0 });
+    });
 });
*** End Patch
'@ | apply_patch" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
 exited 1 in 1179ms:
Error: --codex-run-as-apply-patch requires a UTF-8 PATCH argument.

exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '$patch = @'"'
*** Begin Patch
*** Update File: dist/googleDocsApiHelpers.js
@@
-        if (normalTextStyle && "'!foregroundColor?.color?.themeColor) {
+        // A default Docs document can omit NORMAL_TEXT altogether from this
+        // partial response. That is the same stock black default as a present
+        // NORMAL_TEXT entry with no foregroundColor; leaving it null skips the
+        // color request entirely. Only a positively reported theme color must
+        // remain inherit-only, because converting that slot to RGB would pin
+        // it to the current theme.
+        if (!foregroundColor?.color?.themeColor) {
             return { color: { red: 0, green: 0, blue: 0 }, error: null };
         }
*** Update File: tests/defaultTextColor.test.js
@@
     it('"'treats Googles empty RGB payload as implicit black, not an empty direct paint', async () => {
@@
         expect(colorRequest.updateTextStyle.textStyle.foregroundColor.color.rgbColor)
             .toEqual({ red: 0, green: 0, blue: 0 });
     });
+
+    it('uses explicit black when Google omits NORMAL_TEXT from the partial style response', async () => {
+        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
+        const docs = {
+            documents: {
+                get: jest.fn(async () => ({ data: { namedStyles: { styles: [] } } })),
+                batchUpdate,
+            },
+        };
+
+        await insertMarkdown(docs, 'markdown-no-normal-text', 'Font Color Probe');
+
+        const requests = batchUpdate.mock.calls.flatMap((call) => call[0].requestBody.requests);
+        const [colorRequest] = colorRequestsIn(requests);
+        expect(colorRequest.updateTextStyle.textStyle.foregroundColor.color.rgbColor)
+            .toEqual({ red: 0, green: 0, blue: 0 });
+    });
 });
*** End Patch
'@
apply_patch "'$patch' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
 exited 1 in 103ms:
Invalid patch: The last line of the patch must be '*** End Patch'

exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '$patch = @'"'
*** Begin Patch
*** Update File: dist/googleDocsApiHelpers.js
@@
-        if (normalTextStyle && "'!foregroundColor?.color?.themeColor) {
+        // A default Docs document can omit NORMAL_TEXT altogether from this
+        // partial response. That is the same stock black default as a present
+        // NORMAL_TEXT entry with no foregroundColor; leaving it null skips the
+        // color request entirely. Only a positively reported theme color must
+        // remain inherit-only, because converting that slot to RGB would pin
+        // it to the current theme.
+        if (!foregroundColor?.color?.themeColor) {
             return { color: { red: 0, green: 0, blue: 0 }, error: null };
         }
*** Update File: tests/defaultTextColor.test.js
@@
     it('"'treats Googles empty RGB payload as implicit black, not an empty direct paint', async () => {
@@
         expect(colorRequest.updateTextStyle.textStyle.foregroundColor.color.rgbColor)
             .toEqual({ red: 0, green: 0, blue: 0 });
     });
+
+    it('uses explicit black when Google omits NORMAL_TEXT from the partial style response', async () => {
+        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
+        const docs = {
+            documents: {
+                get: jest.fn(async () => ({ data: { namedStyles: { styles: [] } } })),
+                batchUpdate,
+            },
+        };
+
+        await insertMarkdown(docs, 'markdown-no-normal-text', 'Font Color Probe');
+
+        const requests = batchUpdate.mock.calls.flatMap((call) => call[0].requestBody.requests);
+        const [colorRequest] = colorRequestsIn(requests);
+        expect(colorRequest.updateTextStyle.textStyle.foregroundColor.color.rgbColor)
+            .toEqual({ red: 0, green: 0, blue: 0 });
+    });
 });
*** End Patch
'@
"'$patch = $patch.Trim()
apply_patch $patch' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
 exited 1 in 1318ms:
Invalid patch: The last line of the patch must be '*** End Patch'

exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Get-Command apply_patch | Format-List *; Get-Command git | Format-List Source,CommandType,Definition' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
 succeeded in 167ms:


HelpUri            : 
FileVersionInfo    : File:             C:\Users\2supe\.codex\tmp\arg0\codex-arg0oRiQFJ\apply_patch.bat
                     InternalName:     
                     OriginalFilename: 
                     FileVersion:      
                     FileDescription:  
                     Product:          
                     ProductVersion:   
                     Debug:            False
                     Patched:          False
                     PreRelease:       False
                     PrivateBuild:     False
                     SpecialBuild:     False
                     Language:         
                     
Path               : C:\Users\2supe\.codex\tmp\arg0\codex-arg0oRiQFJ\apply_patch.bat
Extension          : .bat
Definition         : C:\Users\2supe\.codex\tmp\arg0\codex-arg0oRiQFJ\apply_patch.bat
Source             : C:\Users\2supe\.codex\tmp\arg0\codex-arg0oRiQFJ\apply_patch.bat
Version            : 0.0.0.0
Visibility         : Public
OutputType         : {System.String}
Name               : apply_patch.bat
CommandType        : Application
ModuleName         : 
Module             : 
RemotingCapability : PowerShell
Parameters         : 
ParameterSets      : 





Source      : C:\Program Files\Git\mingw64\bin\git.exe
CommandType : Application
Definition  : C:\Program Files\Git\mingw64\bin\git.exe




exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -Raw 'C:\\Users\\2supe\\.codex\\tmp\\arg0\\codex-arg0oRiQFJ\\apply_patch.bat'" in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
 succeeded in 68ms:
@echo off
"%~dp0..\..\..\..\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe" --codex-run-as-apply-patch %*


exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '$patch = @'"'
*** Begin Patch
*** Update File: dist/googleDocsApiHelpers.js
@@
-        if (normalTextStyle && "'!foregroundColor?.color?.themeColor) {
+        // A default Docs document can omit NORMAL_TEXT altogether from this
+        // partial response. That is the same stock black default as a present
+        // NORMAL_TEXT entry with no foregroundColor; leaving it null skips the
+        // color request entirely. Only a positively reported theme color must
+        // remain inherit-only, because converting that slot to RGB would pin
+        // it to the current theme.
+        if (!foregroundColor?.color?.themeColor) {
             return { color: { red: 0, green: 0, blue: 0 }, error: null };
         }
*** Update File: tests/defaultTextColor.test.js
@@
     it('"'treats Googles empty RGB payload as implicit black, not an empty direct paint', async () => {
@@
         expect(colorRequest.updateTextStyle.textStyle.foregroundColor.color.rgbColor)
             .toEqual({ red: 0, green: 0, blue: 0 });
     });
+
+    it('uses explicit black when Google omits NORMAL_TEXT from the partial style response', async () => {
+        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
+        const docs = {
+            documents: {
+                get: jest.fn(async () => ({ data: { namedStyles: { styles: [] } } })),
+                batchUpdate,
+            },
+        };
+
+        await insertMarkdown(docs, 'markdown-no-normal-text', 'Font Color Probe');
+
+        const requests = batchUpdate.mock.calls.flatMap((call) => call[0].requestBody.requests);
+        const [colorRequest] = colorRequestsIn(requests);
+        expect(colorRequest.updateTextStyle.textStyle.foregroundColor.color.rgbColor)
+            .toEqual({ red: 0, green: 0, blue: 0 });
+    });
 });
*** End Patch
'@
& 'C:\\Users\\2supe\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe' --codex-run-as-apply-patch "'$patch' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
 succeeded in 657ms:
Success. Updated the following files:
M dist/googleDocsApiHelpers.js
M tests/defaultTextColor.test.js

exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'npm.cmd test -- --runInBand tests/defaultTextColor.test.js tests/markdownRoundTrip.test.js' in C:\Users\2supe\All Coding\Google-Tools-MCP\google-tools-mcp-int
 succeeded in 11460ms:

> google-tools-mcp@2.0.0 test
> node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand tests/defaultTextColor.test.js tests/markdownRoundTrip.test.js

WARNING: Unable to read config file C:\Users\2supe\.config\google-tools-mcp\.env (EPERM).
(node:47264) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
(node:47264) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
WARNING: Unable to read config file C:\Users\2supe\.config\google-tools-mcp\.env (EPERM).

Test Suites: 2 passed, 2 total
Tests:       24 passed, 24 total
Snapshots:   0 total
Time:        3.087 s
Ran all test suites matching tests/defaultTextColor.test.js|tests/markdownRoundTrip.test.js.

