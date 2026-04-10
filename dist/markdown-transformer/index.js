// src/markdown-transformer/index.ts
//
// Public API for bidirectional markdown <-> Google Docs conversion.
//
// Main methods:
//   extractMarkdown() - Fetch a Google Doc and return its content as markdown
//   insertMarkdown()  - Convert markdown and insert it into a Google Doc
//
// Helper:
//   docsJsonToMarkdown() - Convert already-fetched Docs JSON to markdown
//
import { docsJsonToMarkdown } from './docsToMarkdown.js';
import { convertMarkdownToRequests } from './markdownToDocs.js';
import { executeBatchUpdateWithSplitting, findTabById } from '../googleDocsApiHelpers.js';
export { docsJsonToMarkdown } from './docsToMarkdown.js';
/** Formats InsertMarkdownResult into a concise human-readable debug summary. */
export function formatInsertResult(result) {
    const lines = [];
    lines.push(`Markdown insert completed in ${result.totalElapsedMs}ms`);
    lines.push(`  Parse: ${result.parseElapsedMs}ms`);
    lines.push(`  Requests: ${result.totalRequests} total (${Object.entries(result.requestsByType)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ')})`);
    lines.push(`  API calls: ${result.batchUpdate.totalApiCalls} batchUpdate calls in ${result.batchUpdate.totalElapsedMs}ms`);
    const { phases } = result.batchUpdate;
    if (phases.delete.requests > 0) {
        lines.push(`    Delete phase: ${phases.delete.requests} requests, ${phases.delete.apiCalls} calls, ${phases.delete.elapsedMs}ms`);
    }
    if (phases.insert.requests > 0) {
        lines.push(`    Insert phase: ${phases.insert.requests} requests, ${phases.insert.apiCalls} calls, ${phases.insert.elapsedMs}ms`);
    }
    if (phases.format.requests > 0) {
        lines.push(`    Format phase: ${phases.format.requests} requests, ${phases.format.apiCalls} calls, ${phases.format.elapsedMs}ms`);
    }
    return lines.join('\n');
}
// --- extractMarkdown ---
/**
 * Fetches a Google Document and returns its content as a markdown string.
 *
 * @param docs - An authenticated Google Docs API client
 * @param documentId - The document ID (from the URL)
 * @param options - Optional: tabId to target a specific tab
 * @returns The document content as markdown
 */
export async function extractMarkdown(docs, documentId, options) {
    const tabId = options?.tabId;
    const res = await docs.documents.get({
        documentId,
        includeTabsContent: !!tabId,
        fields: tabId ? '*' : '*',
    });
    if (tabId) {
        const targetTab = findTabById(res.data, tabId);
        if (!targetTab) {
            throw new Error(`Tab with ID "${tabId}" not found in document.`);
        }
        if (!targetTab.documentTab) {
            throw new Error(`Tab "${tabId}" does not have content (may not be a document tab).`);
        }
        return docsJsonToMarkdown({
            body: targetTab.documentTab.body,
            lists: targetTab.documentTab.lists,
        });
    }
    return docsJsonToMarkdown({
        body: res.data.body,
        lists: res.data.lists,
    });
}
// --- insertMarkdown ---
/**
 * Converts markdown to Google Docs formatting and inserts it into a document.
 *
 * Handles the full pipeline: markdown parsing, request generation, and batch
 * execution against the Docs API. Callers never see raw API requests.
 *
 * @param docs - An authenticated Google Docs API client
 * @param documentId - The document ID
 * @param markdown - The markdown content to insert
 * @param options - Optional: startIndex (default 1), tabId
 * @returns Debug metadata about the operation (request counts, timing, API calls)
 */
export async function insertMarkdown(docs, documentId, markdown, options) {
    const overallStart = performance.now();
    const startIndex = options?.startIndex ?? 1;
    const tabId = options?.tabId;
    // Fetch the document's default text style so we can explicitly set
    // foreground color on inserted text (fixes issue #14 — text without
    // explicit color shows "no color selected" in the Docs color picker).
    let defaultForegroundColor;
    try {
        const styleRes = await docs.documents.get({
            documentId,
            fields: 'namedStyles',
        });
        const normalTextStyle = styleRes.data.namedStyles?.styles?.find(
            (s) => s.namedStyleType === 'NORMAL_TEXT'
        );
        const fg = normalTextStyle?.textStyle?.foregroundColor?.color?.rgbColor;
        if (fg) {
            defaultForegroundColor = fg;
        }
    } catch {
        // Non-fatal — if we can't read styles, proceed without explicit color
    }
    const parseStart = performance.now();
    const conversionOptions = {
        ...(options?.firstHeadingAsTitle && { firstHeadingAsTitle: true }),
        ...(defaultForegroundColor && { defaultForegroundColor }),
    };
    const requests = convertMarkdownToRequests(markdown, startIndex, tabId, conversionOptions);
    const parseElapsedMs = Math.round(performance.now() - parseStart);
    // Count requests by type
    const requestsByType = {};
    for (const r of requests) {
        const type = Object.keys(r)[0];
        requestsByType[type] = (requestsByType[type] || 0) + 1;
    }
    if (requests.length === 0) {
        return {
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
    const batchUpdate = await executeBatchUpdateWithSplitting(docs, documentId, requests);
    return {
        totalRequests: requests.length,
        requestsByType,
        parseElapsedMs,
        batchUpdate,
        totalElapsedMs: Math.round(performance.now() - overallStart),
    };
}
