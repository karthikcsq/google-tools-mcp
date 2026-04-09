import { UserError } from 'fastmcp';
import { z } from 'zod';
import { google } from 'googleapis';
import { getAuthClient } from '../../../clients.js';
import { DocumentIdParameter } from '../../../types.js';
export function register(server) {
    server.addTool({
        name: 'replyToComment',
        description: 'Adds a reply to an existing comment thread. Use listComments or getComment to find the comment ID.',
        parameters: DocumentIdParameter.extend({
            commentId: z.string().describe('The ID of the comment to reply to'),
            content: z.string().min(1).describe('The text content of the reply.'),
        }),
        execute: async (args, { log }) => {
            log.info(`Adding reply to comment ${args.commentId} in doc ${args.documentId}`);
            try {
                const authClient = await getAuthClient();
                const drive = google.drive({ version: 'v3', auth: authClient });
                const response = await drive.replies.create({
                    fileId: args.documentId,
                    commentId: args.commentId,
                    fields: 'id,content,author,createdTime',
                    requestBody: {
                        content: args.content,
                    },
                });
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                return `${docUrl}\nReply added successfully. Reply ID: ${response.data.id}`;
            }
            catch (error) {
                log.error(`Error adding reply: ${error.message || error}`);
                throw new UserError(`Failed to add reply: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
