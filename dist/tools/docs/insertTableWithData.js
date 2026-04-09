import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDocsClient } from '../../clients.js';
import { DocumentIdParameter } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
// --- Table Index Math ---
// Google Docs API table index layout for an R×C table inserted at T:
//   cellContentIndex(T, r, c, C) = T + 4 + r * (1 + 2*C) + 2*c
// (Verified empirically; see markdownToDocs.ts lines 640-658)
/**
 * Builds the Google Docs API requests to insert a table and populate its cells.
 * Exported for testability (same pattern as convertMarkdownToRequests).
 */
export function buildInsertTableWithDataRequests(data, index, hasHeaderRow, tabId) {
    const numRows = data.length;
    const numCols = data.reduce((max, row) => Math.max(max, row.length), 0);
    if (numRows === 0 || numCols === 0) {
        throw new UserError('Table data must contain at least one non-empty row with at least one cell.');
    }
    // Pad ragged rows to uniform column count
    const normalizedData = data.map((row) => {
        const padded = [...row];
        while (padded.length < numCols)
            padded.push('');
        return padded;
    });
    const insertRequests = [];
    const formatRequests = [];
    // 1. Insert the empty table structure
    const location = { index };
    if (tabId)
        location.tabId = tabId;
    insertRequests.push({
        insertTable: {
            location: location,
            rows: numRows,
            columns: numCols,
        },
    });
    // 2. Insert text into each cell, tracking cumulative offset
    let cumulativeTextLength = 0;
    for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < numCols; c++) {
            const cellText = normalizedData[r][c];
            if (!cellText)
                continue;
            const baseCellIndex = index + 4 + r * (1 + 2 * numCols) + 2 * c;
            const adjustedIndex = baseCellIndex + cumulativeTextLength;
            const cellLocation = { index: adjustedIndex };
            if (tabId)
                cellLocation.tabId = tabId;
            insertRequests.push({
                insertText: {
                    location: cellLocation,
                    text: cellText,
                },
            });
            // 3. Bold header row cells
            if (hasHeaderRow && r === 0) {
                const styleReq = GDocsHelpers.buildUpdateTextStyleRequest(adjustedIndex, adjustedIndex + cellText.length, { bold: true }, tabId);
                if (styleReq)
                    formatRequests.push(styleReq.request);
            }
            cumulativeTextLength += cellText.length;
        }
    }
    return [...insertRequests, ...formatRequests];
}
export function register(server) {
    server.addTool({
        name: 'insertTableWithData',
        description: 'Inserts a table pre-populated with data at a specific index in the document. ' +
            'All cell content is inserted in a single operation. ' +
            'Optionally bolds the first row as a header. ' +
            'Ragged rows are padded with empty cells to match the widest row.',
        parameters: DocumentIdParameter.extend({
            data: z
                .array(z.array(z.string()))
                .min(1)
                .describe('A 2D array of strings representing the table contents. Each inner array is one row. ' +
                'Example: [["Name", "Age"], ["Alice", "30"], ["Bob", "25"]]'),
            index: z
                .number()
                .int()
                .min(1)
                .describe('1-based character index within the document body where the table should be inserted. ' +
                "Use readDocument with format='json' to inspect indices."),
            hasHeaderRow: z
                .boolean()
                .optional()
                .default(false)
                .describe('If true, the first row is treated as a header and its text will be bolded.'),
            tabId: z
                .string()
                .optional()
                .describe('The ID of the specific tab to insert into. Use listDocumentTabs to get tab IDs. ' +
                'If not specified, inserts into the first tab.'),
        }),
        execute: async (args, { log }) => {
            const docs = await getDocsClient();
            const numRows = args.data.length;
            const numCols = args.data.reduce((max, row) => Math.max(max, row.length), 0);
            log.info(`Inserting ${numRows}x${numCols} table with data in doc ${args.documentId} at index ${args.index}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);
            try {
                // Validate tab if specified (same pattern as insertTable.ts)
                if (args.tabId) {
                    const docInfo = await docs.documents.get({
                        documentId: args.documentId,
                        includeTabsContent: true,
                        fields: 'tabs(tabProperties,documentTab)',
                    });
                    const targetTab = GDocsHelpers.findTabById(docInfo.data, args.tabId);
                    if (!targetTab) {
                        throw new UserError(`Tab with ID "${args.tabId}" not found in document.`);
                    }
                    if (!targetTab.documentTab) {
                        throw new UserError(`Tab "${args.tabId}" does not have content (may not be a document tab).`);
                    }
                }
                const requests = buildInsertTableWithDataRequests(args.data, args.index, args.hasHeaderRow ?? false, args.tabId);
                const metadata = await GDocsHelpers.executeBatchUpdateWithSplitting(docs, args.documentId, requests, log);
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                return (`${docUrl}\nSuccessfully inserted a ${numRows}x${numCols} table with data at index ${args.index}` +
                    `${args.tabId ? ` in tab ${args.tabId}` : ''}. ` +
                    `${args.hasHeaderRow ? 'Header row bolded. ' : ''}` +
                    `(${metadata.totalRequests} requests in ${metadata.totalApiCalls} API calls, ${metadata.totalElapsedMs}ms)`);
            }
            catch (error) {
                log.error(`Error inserting table with data in doc ${args.documentId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to insert table with data: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
