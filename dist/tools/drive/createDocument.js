import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient, getDocsClient } from '../../clients.js';
import { insertMarkdown, formatInsertResult, docsJsonToMarkdown } from '../../markdown-transformer/index.js';
import { getDefaultTextColor, buildDefaultColorStyleRequest } from '../../googleDocsApiHelpers.js';
import { trackRead } from '../../readTracker.js';
import { mintDocsReadHandle } from '../../docsHandles.js';
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
                const docs = await getDocsClient();
                // Add initial content if provided
                let contentWarnings;
                if (args.initialContent) {
                    try {
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
                            // Explicitly paint the freshly-inserted raw text with
                            // the document's default foreground color (issue #14)
                            // — raw insertText carries no style at all otherwise.
                            // A failed color lookup/update doesn't undo the insert;
                            // it's surfaced as a warning instead of silently
                            // succeeding with unset color.
                            try {
                                const { color, error } = await getDefaultTextColor(docs, document.id);
                                if (error) {
                                    contentWarnings = [
                                        ...(contentWarnings ?? []),
                                        `Could not determine document default text color: ${error.message}`,
                                    ];
                                }
                                const colorRequest = buildDefaultColorStyleRequest(1, 1 + args.initialContent.length, color, undefined);
                                if (colorRequest) {
                                    await docs.documents.batchUpdate({
                                        documentId: document.id,
                                        requestBody: { requests: [colorRequest] },
                                    });
                                }
                            }
                            catch (colorError) {
                                log.warn(`Document created but failed to set default text color: ${colorError.message}`);
                                contentWarnings = [
                                    ...(contentWarnings ?? []),
                                    `Could not apply default text color to initial content: ${colorError.message}`,
                                ];
                            }
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
                    }
                }
                // Seed post-create read state so an immediate follow-up mutation
                // doesn't fail as "unread" (#87 gap 2). The content is knowable for
                // every createDocument flow (raw, markdown, or empty) because we
                // control every write that produced it — but we fetch the document
                // back rather than trust our own inputs, so the seeded snapshot
                // matches exactly what a real readDocument call would return
                // (actual indices/structure, and whatever partial state resulted if
                // the initial-content step above warned or failed).
                let readHandle;
                try {
                    const seedRes = await docs.documents.get({ documentId: document.id, fields: '*' });
                    const contentSource = seedRes.data;
                    const markdownContent = docsJsonToMarkdown(contentSource);
                    let modifiedTime = null;
                    try {
                        const modInfo = await drive.files.get({
                            fileId: document.id,
                            fields: 'modifiedTime',
                            supportsAllDrives: true,
                        });
                        modifiedTime = modInfo.data.modifiedTime || null;
                    }
                    catch { /* best effort; legacy guard tolerates a null modifiedTime */ }
                    trackRead(document.id, modifiedTime, markdownContent, seedRes.data.revisionId);
                    const minted = await mintDocsReadHandle({
                        documentId: document.id,
                        tabId: null,
                        revisionId: seedRes.data.revisionId ?? null,
                        contentSource,
                        content: markdownContent,
                    });
                    readHandle = minted?.readHandle;
                }
                catch (seedError) {
                    // The document itself was created successfully; failing to seed
                    // read state only means the next mutation must call readDocument
                    // first (fail closed), not that this tool call failed.
                    log.warn(`Document ${document.id} created but read state could not be seeded: ${seedError.message}`);
                }
                return JSON.stringify({
                    id: document.id,
                    name: document.name,
                    url: document.webViewLink,
                    ...(contentWarnings && {
                        warnings: contentWarnings,
                        warningNote: `${contentWarnings.length} item${contentWarnings.length === 1 ? '' : 's'} of initialContent could not be converted and ${contentWarnings.length === 1 ? 'was' : 'were'} dropped — see warnings.`,
                    }),
                    ...(readHandle && {
                        readHandleNote: 'This document has been seeded as read. You can mutate it immediately without calling readDocument first.',
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
