import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDocsClient } from '../../clients.js';
import { DocumentIdParameter } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import { ReadHandleParameter, beginDocsMutation } from '../../docsHandles.js';
export function register(server) {
    server.addTool({
        name: 'addTab',
        description: "Adds a new tab to a Google Docs document. Optionally set the tab title, position, parent tab (for nesting), and icon emoji. Returns the new tab's ID and properties.",
        parameters: DocumentIdParameter.extend({
            title: z
                .string()
                .optional()
                .describe('The title for the new tab. If not specified, Google Docs assigns a default name.'),
            parentTabId: z
                .string()
                .optional()
                .describe('The ID of an existing tab to nest this new tab under as a child. Use listDocumentTabs to get tab IDs. If not specified, the tab is created at the root level.'),
            index: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe('The zero-based position among sibling tabs (within the same parent). If not specified, the tab is added at the end.'),
            iconEmoji: z
                .string()
                .optional()
                .describe('An emoji to display as the tab icon (e.g., "📋").'),
            readHandle: ReadHandleParameter,
        }),
        execute: async (args, { log }) => {
            const docs = await getDocsClient();
            log.info(`Adding new tab to doc ${args.documentId}`);
            try {
                // If parentTabId is provided, verify it exists
                if (args.parentTabId) {
                    const docInfo = await docs.documents.get({
                        documentId: args.documentId,
                        includeTabsContent: true,
                        fields: 'tabs(tabProperties,documentTab)',
                    });
                    const parentTab = GDocsHelpers.findTabById(docInfo.data, args.parentTabId);
                    if (!parentTab) {
                        throw publicError(`Parent tab with ID "${args.parentTabId}" not found in document.`);
                    }
                }
                const tabProperties = {};
                if (args.title !== undefined)
                    tabProperties.title = args.title;
                if (args.parentTabId !== undefined)
                    tabProperties.parentTabId = args.parentTabId;
                if (args.index !== undefined)
                    tabProperties.index = args.index;
                if (args.iconEmoji !== undefined)
                    tabProperties.iconEmoji = args.iconEmoji;
                // Document-scoped: adding a tab changes the document's tab
                // structure, so the authorizing read is a whole-document read.
                const lease = await beginDocsMutation(args.documentId, {
                    tabId: null,
                    readHandle: args.readHandle,
                });
                const response = await lease.write(
                    (writeControl) => GDocsHelpers.executeBatchUpdate(docs, args.documentId, [
                        {
                            addDocumentTab: {
                                tabProperties,
                            },
                        },
                    ], writeControl),
                    (result) => result?.writeControl?.requiredRevisionId,
                );
                const newTabProps = response.replies?.[0]?.addDocumentTab?.tabProperties;
                if (newTabProps) {
                    return JSON.stringify({
                        url: `https://docs.google.com/document/d/${args.documentId}/edit`,
                        message: `Successfully added new tab "${newTabProps.title || '(untitled)'}"`,
                        tabId: newTabProps.tabId,
                        title: newTabProps.title,
                        index: newTabProps.index,
                        parentTabId: newTabProps.parentTabId,
                        nestingLevel: newTabProps.nestingLevel,
                    }, null, 2);
                }
                return 'Tab created successfully, but could not retrieve the new tab details.';
            }
            catch (error) {
                log.error(`Error adding tab to doc ${args.documentId}: ${error.message || error}`);
                if (isPublicError(error))
                    throw error;
                if (error.code === 404)
                    throw publicError(`Document not found (ID: ${args.documentId}).`);
                if (error.code === 403)
                    throw publicError(`Permission denied for document (ID: ${args.documentId}).`);
throw wrapOperationError('add document tab', error, { status: error?.code });
            }
        },
    });
}
