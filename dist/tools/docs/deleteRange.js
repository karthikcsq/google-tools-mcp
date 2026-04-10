import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDocsClient } from '../../clients.js';
import { DocumentIdParameter } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import { guardMutation, trackMutation } from '../../readTracker.js';
export function register(server) {
    server.addTool({
        name: 'deleteRange',
        description: "Deletes content within a character range [startIndex, endIndex) from a document. Use readDocument with format='json' to determine index positions.",
        parameters: DocumentIdParameter.extend({
            startIndex: z
                .number()
                .int()
                .min(1)
                .describe('1-based character index within the document body. The start of the range to delete (inclusive).'),
            endIndex: z
                .number()
                .int()
                .min(1)
                .describe('1-based character index within the document body. The end of the range to delete (exclusive).'),
            tabId: z
                .string()
                .optional()
                .describe('The ID of the specific tab to delete from. If not specified, deletes from the first tab (or legacy document.body for documents without tabs).'),
        }).refine((data) => data.endIndex > data.startIndex, {
            message: 'endIndex must be greater than startIndex',
            path: ['endIndex'],
        }),
        execute: async (args, { log }) => {
            await guardMutation(args.documentId);
            const docs = await getDocsClient();
            log.info(`Deleting range ${args.startIndex}-${args.endIndex} in doc ${args.documentId}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);
            if (args.endIndex <= args.startIndex) {
                throw new UserError('End index must be greater than start index for deletion.');
            }
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
                const range = {
                    startIndex: args.startIndex,
                    endIndex: args.endIndex,
                };
                if (args.tabId) {
                    range.tabId = args.tabId;
                }
                const request = {
                    deleteContentRange: { range },
                };
                await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [request]);
                trackMutation(args.documentId);
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                return `${docUrl}\nSuccessfully deleted content in range ${args.startIndex}-${args.endIndex}${args.tabId ? ` in tab ${args.tabId}` : ''}.`;
            }
            catch (error) {
                log.error(`Error deleting range in doc ${args.documentId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to delete range: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
