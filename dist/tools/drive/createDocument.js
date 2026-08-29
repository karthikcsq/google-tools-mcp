import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient, getDocsClient } from '../../clients.js';
import { insertMarkdown, formatInsertResult } from '../../markdown-transformer/index.js';
import { getBatchUpdateProgress } from '../../googleDocsApiHelpers.js';
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
                // Add initial content if provided
                let contentWarnings;
                let contentWarningNote;
                if (args.initialContent) {
                    try {
                        const docs = await getDocsClient();
                        if (args.contentFormat === 'raw') {
                            await docs.documents.batchUpdate({
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
                        }
                        else {
                            const result = await insertMarkdown(docs, document.id, args.initialContent, {
                                startIndex: 1,
                                firstHeadingAsTitle: true,
                            });
                            log.info(formatInsertResult(result));
                            // Surface dropped-content warnings in the tool response itself —
                            // logging alone leaves the caller believing the initial content
                            // rendered faithfully (the same failure mode this warnings
                            // feature exists to close for appendMarkdown/replaceDocumentWithMarkdown).
                            if (result.warnings?.length) {
                                contentWarnings = result.warnings;
                            }
                        }
                    }
                    catch (contentError) {
                        log.warn(`Document created but failed to add initial content: ${contentError.message}`);
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
                        // would be false whenever an earlier batch already landed —
                        // a caller trusting that message and resending initialContent
                        // would duplicate whatever is already there. When progress
                        // info is available, say so explicitly and point at the
                        // document instead (PR #113 review finding 3).
                        const progress = getBatchUpdateProgress(contentError);
                        if (progress && progress.completedRequests > 0) {
                            contentWarnings = ['Document created but initial content was only partially applied before a later operation failed.'];
                            contentWarningNote = `The document was created and ${progress.completedRequests} of ${progress.totalRequests} content operation(s) (${progress.phase} phase) were already applied to it before the failure. Do not blindly resend initialContent — inspect the document with readDocument first to see what already landed, then reconcile or retry only what's missing.`;
                        }
                        else {
                            contentWarnings = ['Document created but initial content failed.'];
                            contentWarningNote = 'The document was created, but its initial content could not be added.';
                        }
                    }
                }
                return JSON.stringify({
                    id: document.id,
                    name: document.name,
                    url: document.webViewLink,
                    ...(contentWarnings && {
                        warnings: contentWarnings,
                        warningNote: contentWarningNote ?? `${contentWarnings.length} item${contentWarnings.length === 1 ? '' : 's'} of initialContent could not be converted and ${contentWarnings.length === 1 ? 'was' : 'were'} dropped — see warnings.`,
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
