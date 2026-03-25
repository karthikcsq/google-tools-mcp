import { UserError } from 'fastmcp';
import { z } from 'zod';
import { google } from 'googleapis';
import { getAuthClient } from '../../../clients.js';
import { DocumentIdParameter } from '../../../types.js';
export function register(server) {
    server.addTool({
        name: 'getComment',
        description: 'Gets a specific comment and its full reply thread. Use listComments first to find the comment ID.',
        parameters: DocumentIdParameter.extend({
            commentId: z.string().describe('The ID of the comment to retrieve'),
        }),
        execute: async (args, { log }) => {
            log.info(`Getting comment ${args.commentId} from document ${args.documentId}`);
            try {
                const authClient = await getAuthClient();
                const drive = google.drive({ version: 'v3', auth: authClient });
                const response = await drive.comments.get({
                    fileId: args.documentId,
                    commentId: args.commentId,
                    fields: 'id,content,quotedFileContent,author,createdTime,resolved,replies(id,content,author,createdTime)',
                });
                const comment = response.data;
                return JSON.stringify({
                    id: comment.id,
                    author: comment.author?.displayName || null,
                    content: comment.content,
                    quotedText: comment.quotedFileContent?.value || null,
                    resolved: comment.resolved || false,
                    createdTime: comment.createdTime,
                    replies: (comment.replies || []).map((r) => ({
                        id: r.id,
                        author: r.author?.displayName || null,
                        content: r.content,
                        createdTime: r.createdTime,
                    })),
                }, null, 2);
            }
            catch (error) {
                log.error(`Error getting comment: ${error.message || error}`);
                throw new UserError(`Failed to get comment: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
