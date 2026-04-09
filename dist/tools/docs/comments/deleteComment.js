import { UserError } from 'fastmcp';
import { z } from 'zod';
import { google } from 'googleapis';
import { getAuthClient } from '../../../clients.js';
import { DocumentIdParameter } from '../../../types.js';
export function register(server) {
    server.addTool({
        name: 'deleteComment',
        description: 'Permanently deletes a comment and all its replies from the document.',
        parameters: DocumentIdParameter.extend({
            commentId: z.string().describe('The ID of the comment to delete'),
        }),
        execute: async (args, { log }) => {
            log.info(`Deleting comment ${args.commentId} from doc ${args.documentId}`);
            try {
                const authClient = await getAuthClient();
                const drive = google.drive({ version: 'v3', auth: authClient });
                await drive.comments.delete({
                    fileId: args.documentId,
                    commentId: args.commentId,
                });
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                return `${docUrl}\nComment ${args.commentId} has been deleted.`;
            }
            catch (error) {
                log.error(`Error deleting comment: ${error.message || error}`);
                throw new UserError(`Failed to delete comment: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
