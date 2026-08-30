import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient, getDocsClient } from '../../clients.js';
import { insertMarkdown, formatInsertResult, docsJsonToMarkdown } from '../../markdown-transformer/index.js';
import { getDefaultTextColor, buildDefaultColorStyleRequest, getBatchUpdateProgress } from '../../googleDocsApiHelpers.js';
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
                // The Docs client is acquired lazily, inside each branch that
                // actually needs it, rather than hoisted here: the Drive file
                // above is already created by this point, so a Docs-client
                // failure (auth misconfig, transient outage, whatever) must
                // not fail the whole tool and orphan that file — it degrades
                // to a warning naming the created document instead. `docs` is
                // cached once obtained so the seeding step below reuses the
                // same client rather than re-acquiring it.
                let docs;
                const ensureDocsClient = async () => {
                    if (!docs) docs = await getDocsClient();
                    return docs;
                };
                // Add initial content if provided
                let contentWarnings;
                let contentWarningNote;
                if (args.initialContent) {
                    try {
                        const docsClient = await ensureDocsClient();
                        if (args.contentFormat === 'raw') {
                            await docsClient.documents.batchUpdate({
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
                                const { color, error } = await getDefaultTextColor(docsClient, document.id);
                                if (error) {
                                    contentWarnings = [
                                        ...(contentWarnings ?? []),
                                        `Could not determine document default text color: ${error.message}`,
                                    ];
                                }
                                const colorRequest = buildDefaultColorStyleRequest(1, 1 + args.initialContent.length, color, undefined);
                                if (colorRequest) {
                                    await docsClient.documents.batchUpdate({
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
                            const result = await insertMarkdown(docsClient, document.id, args.initialContent, {
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
                        // The Drive file above already exists at this point —
                        // an error here (including a failed getDocsClient()
                        // inside ensureDocsClient()) must not fail the whole
                        // tool and leave that document unreported (#87-style
                        // orphan). Degrade to a named warning instead.
                        log.warn(`Document ${document.id} created but failed to add initial content: ${contentError.message}`);
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
                            contentWarnings = [
                                ...(contentWarnings ?? []),
                                'Document created but initial content was only partially applied before a later operation failed.',
                            ];
                            contentWarningNote = `The document was created and ${progress.completedRequests} of ${progress.totalRequests} content operation(s) (${progress.phase} phase) were already applied to it before the failure. Do not blindly resend initialContent — inspect the document with readDocument first to see what already landed, then reconcile or retry only what's missing.`;
                        }
                        else {
                            contentWarnings = [
                                ...(contentWarnings ?? []),
                                'Document created but initial content failed.',
                            ];
                            contentWarningNote = 'The document was created, but its initial content could not be added.';
                        }
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
                    const docsClient = await ensureDocsClient();
                    const seedRes = await docsClient.documents.get({ documentId: document.id, fields: '*' });
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
                    // The document itself was created successfully (including,
                    // when initialContent was provided, the content step
                    // above — this only covers the separate post-create
                    // fetch-and-mint-handle step). A Docs-client failure here
                    // (including inside ensureDocsClient()) must not fail the
                    // whole tool and hide that the document exists: it is
                    // reported as a named warning, and the next mutation must
                    // call readDocument first (fail closed) rather than this
                    // call throwing.
                    log.warn(`Document ${document.id} created but read state could not be seeded: ${seedError.message}`);
                    contentWarnings = [
                        ...(contentWarnings ?? []),
                        `Document ${document.id} was created, but its read state could not be seeded (${seedError.message}). ` +
                            'Call readDocument before the next mutation on this document.',
                    ];
                }
                return JSON.stringify({
                    id: document.id,
                    name: document.name,
                    url: document.webViewLink,
                    ...(contentWarnings && {
                        warnings: contentWarnings,
                        warningNote: contentWarningNote ?? `${contentWarnings.length} item${contentWarnings.length === 1 ? '' : 's'} of initialContent could not be converted and ${contentWarnings.length === 1 ? 'was' : 'were'} dropped — see warnings.`,
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
