import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDocsClient } from '../../clients.js';
import { DocumentIdParameter } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import { ReadHandleParameter, beginDocsMutation } from '../../docsHandles.js';
export function register(server) {
    server.addTool({
        name: 'renameTab',
        description: 'Renames a tab in a Google Docs document. Use listDocumentTabs to get tab IDs first.',
        parameters: DocumentIdParameter.extend({
            tabId: z
                .string()
                .describe('The ID of the tab to rename. Use listDocumentTabs to get tab IDs.'),
            newTitle: z.string().min(1).describe('The new title for the tab.'),
            readHandle: ReadHandleParameter,
        }),
        execute: async (args, { log }) => {
            const docs = await getDocsClient();
            log.info(`Renaming tab ${args.tabId} to "${args.newTitle}" in doc ${args.documentId}`);
            try {
                // Verify the tab exists
                const docInfo = await docs.documents.get({
                    documentId: args.documentId,
                    includeTabsContent: true,
                    fields: 'tabs(tabProperties,documentTab)',
                });
                const targetTab = GDocsHelpers.findTabById(docInfo.data, args.tabId);
                if (!targetTab) {
                    throw publicError(`Tab with ID "${args.tabId}" not found in document.`);
                }
                const oldTitle = targetTab.tabProperties?.title || '(untitled)';
                // Document-scoped: renaming a tab edits the document's tab
                // properties, not that tab's content, so the authorizing read is
                // a whole-document read rather than a read of this tab.
                const lease = await beginDocsMutation(args.documentId, {
                    tabId: null,
                    readHandle: args.readHandle,
                });
                const response = await lease.write(
                    (writeControl) => GDocsHelpers.executeBatchUpdate(docs, args.documentId, [
                        {
                            updateDocumentTabProperties: {
                                tabProperties: {
                                    tabId: args.tabId,
                                    title: args.newTitle,
                                },
                                fields: 'title',
                            },
                        },
                    ], writeControl),
                    (result) => result?.writeControl?.requiredRevisionId,
                );
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                return `${docUrl}\nSuccessfully renamed tab from "${oldTitle}" to "${args.newTitle}".`;
            }
            catch (error) {
                log.error(`Error renaming tab ${args.tabId} in doc ${args.documentId}: ${error.message || error}`);
                if (isPublicError(error))
                    throw error;
                if (error.code === 404)
                    throw publicError(`Document not found (ID: ${args.documentId}).`);
                if (error.code === 403)
                    throw publicError(`Permission denied for document (ID: ${args.documentId}).`);
throw wrapOperationError('rename document tab', error, { status: error?.code });
            }
        },
    });
}
