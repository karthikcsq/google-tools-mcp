import * as fs from 'fs/promises';
import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDocsClient } from '../../clients.js';
import { DocumentIdParameter, NotImplementedError } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import { docsJsonToMarkdown } from '../../markdown-transformer/index.js';
import { guardMutation } from '../../readTracker.js';
import { ReadHandleParameter, beginDocsMutation } from '../../docsHandles.js';
export function register(server) {
    server.addTool({
        name: 'appendText',
        description: 'Appends plain text to the end of a document. For formatted content, use appendMarkdown instead. ' +
            'To edit existing content, use modifyText (single-location) or replaceDocumentWithMarkdown (section/full rewrite).',
        parameters: DocumentIdParameter.extend({
            text: z.string().optional().describe('The plain text to append to the end of the document. For content longer than ~2000 characters, prefer writing to a local file first and passing filePath instead.'),
            filePath: z.string().optional().describe('Path to a local text file to use as content. Takes precedence over the text parameter.'),
            addNewlineIfNeeded: z
                .boolean()
                .optional()
                .default(true)
                .describe("Automatically add a newline before the appended text if the doc doesn't end with one."),
            tabId: z
                .string()
                .optional()
                .describe('The ID of the specific tab to append to. If not specified, appends to the first tab (or legacy document.body for documents without tabs).'),
            readHandle: ReadHandleParameter,
        }),
        execute: async (args, { log }) => {
            const docs = await getDocsClient();
            const lease = await beginDocsMutation(args.documentId, {
                tabId: args.tabId ?? null,
                readHandle: args.readHandle,
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
            // Resolve text content from filePath or inline parameter
            let text = args.text;
            if (args.filePath) {
                try {
                    text = await fs.readFile(args.filePath, 'utf-8');
                    log.info(`Read ${text.length} chars from file: ${args.filePath}`);
                } catch (err) {
throw wrapOperationError('read local text file', err, { code: err?.code });
                }
            }
            if (!text || text.length === 0) {
                throw publicError('Either text or filePath must be provided with non-empty content.');
            }
            log.info(`Appending to Google Doc: ${args.documentId}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);
            try {
                // Determine if we need tabs content
                const needsTabsContent = !!args.tabId;
                // Get the current end index
                const docInfo = await docs.documents.get({
                    documentId: args.documentId,
                    includeTabsContent: needsTabsContent,
                    fields: needsTabsContent ? 'tabs' : 'body(content(endIndex)),documentStyle(pageSize)',
                });
                let endIndex = 1;
                let bodyContent;
                // If tabId is specified, find the specific tab
                if (args.tabId) {
                    const targetTab = GDocsHelpers.findTabById(docInfo.data, args.tabId);
                    if (!targetTab) {
                        throw publicError(`Tab with ID "${args.tabId}" not found in document.`);
                    }
                    if (!targetTab.documentTab) {
                        throw publicError(`Tab "${args.tabId}" does not have content (may not be a document tab).`);
                    }
                    bodyContent = targetTab.documentTab.body?.content;
                }
                else {
                    bodyContent = docInfo.data.body?.content;
                }
                if (bodyContent) {
                    const lastElement = bodyContent[bodyContent.length - 1];
                    if (lastElement?.endIndex) {
                        endIndex = lastElement.endIndex - 1; // Insert *before* the final newline of the doc typically
                    }
                }
                // Simpler approach: Always assume insertion is needed unless explicitly told not to add newline
                const textToInsert = (args.addNewlineIfNeeded && endIndex > 1 ? '\n' : '') + text;
                if (!textToInsert)
                    return 'Nothing to append.';
                const location = { index: endIndex };
                if (args.tabId) {
                    location.tabId = args.tabId;
                }
                const request = {
                    insertText: { location, text: textToInsert },
                };
                await lease.write(
                    (writeControl) => GDocsHelpers.executeBatchUpdate(docs, args.documentId, [request], writeControl),
                    (response) => response?.writeControl?.requiredRevisionId,
                );
                log.info(`Successfully appended to doc: ${args.documentId}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                return `${docUrl}\nSuccessfully appended text to ${args.tabId ? `tab ${args.tabId} in ` : ''}document ${args.documentId}.`;
            }
            catch (error) {
                log.error(`Error appending to doc ${args.documentId}: ${error.message || error}`);
                if (isPublicError(error))
                    throw error;
                if (error instanceof NotImplementedError)
                    throw error;
throw wrapOperationError('append to Google document', error, { status: error?.code });
            }
        },
    });
}
