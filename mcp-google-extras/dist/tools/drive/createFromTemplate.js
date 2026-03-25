import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient, getDocsClient } from '../../clients.js';
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
                // Apply text replacements if provided
                if (args.replacements && Object.keys(args.replacements).length > 0) {
                    try {
                        const docs = await getDocsClient();
                        const requests = [];
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
                        log.warn(`Document created but failed to apply replacements: ${replacementError.message}`);
                        result += `\n\nDocument created but failed to apply text replacements. You can make changes manually.`;
                    }
                }
                return result;
            }
            catch (error) {
                log.error(`Error creating document from template: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError('Template document or parent folder not found. Check the IDs.');
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have read access to the template and write access to the destination folder.');
                throw new UserError(`Failed to create document from template: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
