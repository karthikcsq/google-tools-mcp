import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDocsClient } from '../../clients.js';
import { DocumentIdParameter } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'insertPageBreak',
        description: 'Inserts a page break at a character index in the document.',
        parameters: DocumentIdParameter.extend({
            index: z
                .number()
                .int()
                .min(1)
                .describe("1-based character index within the document body. Use readDocument with format='json' to inspect indices."),
            tabId: z
                .string()
                .optional()
                .describe('The ID of the specific tab to insert into. Use listDocumentTabs to get tab IDs. If not specified, inserts into the first tab.'),
        }),
        execute: async (args, { log }) => {
            const docs = await getDocsClient();
            log.info(`Inserting page break in doc ${args.documentId} at index ${args.index}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);
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
                        throw new UserError(`Tab with ID "${args.tabId}" not found in document.`);
                    }
                    if (!targetTab.documentTab) {
                        throw new UserError(`Tab "${args.tabId}" does not have content (may not be a document tab).`);
                    }
                }
                const location = { index: args.index };
                if (args.tabId) {
                    location.tabId = args.tabId;
                }
                const request = {
                    insertPageBreak: { location },
                };
                await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [request]);
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                return `${docUrl}\nSuccessfully inserted page break at index ${args.index}${args.tabId ? ` in tab ${args.tabId}` : ''}.`;
            }
            catch (error) {
                log.error(`Error inserting page break in doc ${args.documentId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to insert page break: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
