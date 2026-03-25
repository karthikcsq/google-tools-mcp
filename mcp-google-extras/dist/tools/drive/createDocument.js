import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient, getDocsClient } from '../../clients.js';
import { insertMarkdown, formatInsertResult } from '../../markdown-transformer/index.js';
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
                .describe('Initial content to add to the document. By default, markdown syntax is converted to formatted Google Docs content (headings, bold, italic, links, lists, etc.).'),
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
                        }
                    }
                    catch (contentError) {
                        log.warn(`Document created but failed to add initial content: ${contentError.message}`);
                    }
                }
                return JSON.stringify({
                    id: document.id,
                    name: document.name,
                    url: document.webViewLink,
                }, null, 2);
            }
            catch (error) {
                log.error(`Error creating document: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError('Parent folder not found. Check the folder ID.');
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have write access to the destination folder.');
                throw new UserError(`Failed to create document: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
