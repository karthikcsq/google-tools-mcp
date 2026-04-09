import { UserError } from 'fastmcp';
import { z } from 'zod';
import { google } from 'googleapis';
import { getAuthClient } from '../../../clients.js';
import { DocumentIdParameter } from '../../../types.js';
export function register(server) {
    server.addTool({
        name: 'resolveComment',
        description: 'Marks a comment as resolved. Note: resolved status may not persist in the Google Docs UI due to a Drive API limitation.',
        parameters: DocumentIdParameter.extend({
            commentId: z.string().describe('The ID of the comment to resolve'),
        }),
        execute: async (args, { log }) => {
            log.info(`Resolving comment ${args.commentId} in doc ${args.documentId}`);
            try {
                const authClient = await getAuthClient();
                const drive = google.drive({ version: 'v3', auth: authClient });
                // First, get the current comment content (required by the API)
                const currentComment = await drive.comments.get({
                    fileId: args.documentId,
                    commentId: args.commentId,
                    fields: 'content',
                });
                // Update with both content and resolved status
                await drive.comments.update({
                    fileId: args.documentId,
                    commentId: args.commentId,
                    fields: 'id,resolved',
                    requestBody: {
                        content: currentComment.data.content,
                        resolved: true,
                    },
                });
                // Verify the resolved status was set
                const verifyComment = await drive.comments.get({
                    fileId: args.documentId,
                    commentId: args.commentId,
                    fields: 'resolved',
                });
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                if (verifyComment.data.resolved) {
                    return `${docUrl}\nComment ${args.commentId} has been marked as resolved.`;
                }
                else {
                    return `${docUrl}\nAttempted to resolve comment ${args.commentId}, but the resolved status may not persist in the Google Docs UI due to API limitations. The comment can be resolved manually in the Google Docs interface.`;
                }
            }
            catch (error) {
                log.error(`Error resolving comment: ${error.message || error}`);
                const errorDetails = error.response?.data?.error?.message || error.message || 'Unknown error';
                const errorCode = error.response?.data?.error?.code;
                throw new UserError(`Failed to resolve comment: ${errorDetails}${errorCode ? ` (Code: ${errorCode})` : ''}`);
            }
        },
    });
}
