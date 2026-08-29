import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDocsClient } from '../../clients.js';
import { DocumentIdParameter } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import { ReadHandleParameter, beginDocsMutation } from '../../docsHandles.js';
export function register(server) {
    server.addTool({
        name: 'insertTable',
        description: 'Inserts an empty table with the specified number of rows and columns at a character index in the document.',
        parameters: DocumentIdParameter.extend({
            rows: z.number().int().min(1).describe('Number of rows for the new table.'),
            columns: z.number().int().min(1).describe('Number of columns for the new table.'),
            index: z
                .number()
                .int()
                .min(1)
                .describe("1-based character index within the document body. Use readDocument with format='index' to inspect indices."),
            tabId: z
                .string()
                .optional()
                .describe('The ID of the specific tab to insert into. Use listDocumentTabs to get tab IDs. If not specified, inserts into the first tab.'),
            readHandle: ReadHandleParameter,
        }),
        execute: async (args, { log }) => {
            const docs = await getDocsClient();
            log.info(`Inserting ${args.rows}x${args.columns} table in doc ${args.documentId} at index ${args.index}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);
            try {
                // If tabId is specified, verify the tab exists
                if (args.tabId) {
                    const docInfo = await docs.documents.get({
                        documentId: args.documentId,
                        includeTabsContent: true,
                        fields: 'tabs(tabProperties,documentTab)',
                    });
                    const targetTab = GDocsHelpers.findTabById(docInfo.data, args.tabId);
                    if (!targetTab) {
                        throw publicError(`Tab with ID "${args.tabId}" not found in document.`);
                    }
                    if (!targetTab.documentTab) {
                        throw publicError(`Tab "${args.tabId}" does not have content (may not be a document tab).`);
                    }
                }
                const lease = await beginDocsMutation(args.documentId, {
                    tabId: args.tabId ?? null,
                    readHandle: args.readHandle,
                });
                await lease.write(
                    (writeControl) => GDocsHelpers.createTable(docs, args.documentId, args.rows, args.columns, args.index, args.tabId, writeControl),
                    (response) => response?.writeControl?.requiredRevisionId,
                );
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                return `${docUrl}\nSuccessfully inserted a ${args.rows}x${args.columns} table at index ${args.index}${args.tabId ? ` in tab ${args.tabId}` : ''}.`;
            }
            catch (error) {
                log.error(`Error inserting table in doc ${args.documentId}: ${error.message || error}`);
                if (isPublicError(error))
                    throw error;
throw wrapOperationError('insert document table', error, { status: error?.code });
            }
        },
    });
}
