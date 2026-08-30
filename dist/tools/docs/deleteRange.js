import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDocsClient } from '../../clients.js';
import { DocumentIdParameter } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import { docsJsonToMarkdown } from '../../markdown-transformer/index.js';
import { guardMutation } from '../../readTracker.js';
import { ReadHandleParameter, beginDocsMutation, docsSnapshotFetchers } from '../../docsHandles.js';
export function register(server) {
    server.addTool({
        name: 'deleteRange',
        description: "Deletes content within a character range [startIndex, endIndex) from a document. Use readDocument with format='index' to determine index positions — it returns a compact structural map with the exact start/end of every element. " +
            'If the document changed after you read it, this call is refused unless the change landed strictly after the end of the range: explicit indices carry no anchor to re-resolve, so an edit before them silently moves the content they addressed. The refusal names what changed and where.',
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
            readHandle: ReadHandleParameter,
        }).refine((data) => data.endIndex > data.startIndex, {
            message: 'endIndex must be greater than startIndex',
            path: ['endIndex'],
        }),
        execute: async (args, { log }) => {
            const docs = await getDocsClient();
            // deleteRange is the one guarded writer whose target is fully known
            // before it fetches anything, so it uses beginDocsMutation's
            // built-in range check rather than calling lease.guardTargets by
            // hand. The target is ALWAYS explicit: a deletion addressed by
            // character indices has no semantic anchor to re-resolve, so the
            // only change that can be permitted is one landing strictly after
            // the end of the range (#108).
            const { fetchRevisionId, fetchSnapshot } = docsSnapshotFetchers(docs, args.documentId, args.tabId ?? null);
            const lease = await beginDocsMutation(args.documentId, {
                tabId: args.tabId ?? null,
                readHandle: args.readHandle,
                targetRange: {
                    kind: 'explicit',
                    startIndex: args.startIndex,
                    endIndex: args.endIndex,
                    describe: `range ${args.startIndex}-${args.endIndex} (deleteRange)`,
                },
                fetchRevisionId,
                fetchSnapshot,
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
            log.info(`Deleting range ${args.startIndex}-${args.endIndex} in doc ${args.documentId}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);
            if (args.endIndex <= args.startIndex) {
                throw publicError('End index must be greater than start index for deletion.');
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
                        throw publicError(`Tab with ID "${args.tabId}" not found in document.`);
                    }
                    if (!targetTab.documentTab) {
                        throw publicError(`Tab "${args.tabId}" does not have content (may not be a document tab).`);
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
                await lease.write(
                    (writeControl) => GDocsHelpers.executeBatchUpdate(docs, args.documentId, [request], writeControl),
                    (response) => response?.writeControl?.requiredRevisionId,
                );
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                return `${docUrl}\nSuccessfully deleted content in range ${args.startIndex}-${args.endIndex}${args.tabId ? ` in tab ${args.tabId}` : ''}.`;
            }
            catch (error) {
                log.error(`Error deleting range in doc ${args.documentId}: ${error.message || error}`);
                if (isPublicError(error))
                    throw error;
throw wrapOperationError('delete document range', error, { status: error?.code });
            }
        },
    });
}
