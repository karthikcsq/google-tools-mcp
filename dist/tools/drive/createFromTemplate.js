import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient, getDocsClient } from '../../clients.js';
import { docsJsonToMarkdown } from '../../markdown-transformer/index.js';
import { trackRead } from '../../readTracker.js';
import { mintDocsReadHandle } from '../../docsHandles.js';
export function register(server) {
    server.addTool({
        name: 'createDocumentFromTemplate',
        description: 'Creates a new document by copying an existing template and optionally replacing placeholder text. Provide key-value pairs in the replacements parameter to substitute template variables.',
        parameters: z.object({
            templateId: z.string().describe('ID of the template document to copy from.'),
            newTitle: z.string().min(1).describe('Title for the new document.'),
            parentFolderId: z
                .string()
                .optional()
                .describe('ID of folder where document should be created. If not provided, creates in Drive root.'),
            replacements: z
                .record(z.string())
                .optional()
                .describe('Key-value pairs for text replacements in the template (e.g., {"{{NAME}}": "John Doe", "{{DATE}}": "2024-01-01"}).'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Creating document from template ${args.templateId} with title "${args.newTitle}"`);
            try {
                // First copy the template
                const copyMetadata = {
                    name: args.newTitle,
                };
                if (args.parentFolderId) {
                    copyMetadata.parents = [args.parentFolderId];
                }
                const response = await drive.files.copy({
                    fileId: args.templateId,
                    requestBody: copyMetadata,
                    fields: 'id,name,webViewLink',
                    supportsAllDrives: true,
                });
                const document = response.data;
                let result = `Successfully created document "${document.name}" from template (ID: ${document.id})\nView Link: ${document.webViewLink}`;
                // Whether the flow reached a fully-known content state. Only true
                // when there were no replacements to apply, or they applied
                // successfully — never on a partial/failed replacement, even though
                // batchUpdate's atomicity means the document itself still holds
                // exactly its pre-replacement template content. Per the #87 plan
                // ("successful createFromTemplate" vs "failed template creation"),
                // a replacement failure stays unseeded and explicit rather than
                // silently seeding a state the caller didn't ask for.
                let contentKnown = true;
                // Apply text replacements if provided
                if (args.replacements && Object.keys(args.replacements).length > 0) {
                    try {
                        const docs = await getDocsClient();
                        const requests = [];
                        // No explicit default-color styling here (issue #14
                        // audit): like findAndReplace, replaceAllText
                        // inherits the style of the placeholder text it
                        // replaces rather than producing style-less text, so
                        // there is nothing to explicitly re-color.
                        // Create replace requests for each replacement
                        for (const [searchText, replaceText] of Object.entries(args.replacements)) {
                            requests.push({
                                replaceAllText: {
                                    containsText: {
                                        text: searchText,
                                        matchCase: false,
                                    },
                                    replaceText: replaceText,
                                },
                            });
                        }
                        if (requests.length > 0) {
                            await docs.documents.batchUpdate({
                                documentId: document.id,
                                requestBody: { requests },
                            });
                            const replacementCount = Object.keys(args.replacements).length;
                            result += `\n\nApplied ${replacementCount} text replacement${replacementCount !== 1 ? 's' : ''} to the document.`;
                        }
                    }
                    catch (replacementError) {
                        contentKnown = false;
                        log.warn(`Document created but failed to apply replacements: ${replacementError.message}`);
                        result += `\n\nDocument created but failed to apply text replacements. You can make changes manually. ` +
                            `This document was NOT seeded as read — call readDocument for it before making any edits.`;
                    }
                }
                // Seed post-create read state only for a flow that reached a fully
                // known content state (#87 gap 2). copyFile (a different tool) and a
                // failed/partial replacement stay unseeded and explicit so the next
                // mutation fails closed with a clear "read it first" message rather
                // than silently authorizing a write the caller never actually saw.
                if (contentKnown) {
                    try {
                        const docs = await getDocsClient();
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
                        if (minted?.readHandle) {
                            result += `\n\nThis document has been seeded as read. You can mutate it immediately without calling readDocument first.`;
                        }
                    }
                    catch (seedError) {
                        // The document itself was created successfully; failing to
                        // seed read state only means the next mutation must call
                        // readDocument first (fail closed), not that this call failed.
                        log.warn(`Document ${document.id} created but read state could not be seeded: ${seedError.message}`);
                    }
                }
                return result;
            }
            catch (error) {
                if (isPublicError(error)) throw error;
                log.error(`Error creating document from template: ${error.message || error}`);
                if (error.code === 404)
                    throw publicError('Template document or parent folder not found. Check the IDs.');
                if (error.code === 403)
                    throw publicError('Permission denied. Make sure you have read access to the template and write access to the destination folder.');
throw wrapOperationError('create document from template', error, { status: error?.code });
            }
        },
    });
}
