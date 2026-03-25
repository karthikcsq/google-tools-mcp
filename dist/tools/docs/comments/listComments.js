import { UserError } from 'fastmcp';
import { google } from 'googleapis';
import { getDocsClient, getDriveClient, getAuthClient } from '../../../clients.js';
import { DocumentIdParameter } from '../../../types.js';
export function register(server) {
    server.addTool({
        name: 'listComments',
        description: 'Lists all comments in a document with their IDs, authors, status, and quoted text. Returns data needed to call getComment, replyToComment, resolveComment, or deleteComment.',
        parameters: DocumentIdParameter,
        execute: async (args, { log }) => {
            log.info(`Listing comments for document ${args.documentId}`);
            const docsClient = await getDocsClient();
            const driveClient = await getDriveClient();
            try {
                // First get the document to have context
                const doc = await docsClient.documents.get({ documentId: args.documentId });
                // Use Drive API v3 with proper fields to get quoted content
                const authClient = await getAuthClient();
                const drive = google.drive({ version: 'v3', auth: authClient });
                const response = await drive.comments.list({
                    fileId: args.documentId,
                    fields: 'comments(id,content,quotedFileContent,author,createdTime,resolved)',
                    pageSize: 100,
                });
                const comments = (response.data.comments || []).map((comment) => ({
                    id: comment.id,
                    author: comment.author?.displayName || null,
                    content: comment.content,
                    quotedText: comment.quotedFileContent?.value || null,
                    resolved: comment.resolved || false,
                    createdTime: comment.createdTime,
                    modifiedTime: comment.modifiedTime,
                    replyCount: comment.replies?.length || 0,
                }));
                return JSON.stringify({ comments }, null, 2);
            }
            catch (error) {
                log.error(`Error listing comments: ${error.message || error}`);
                throw new UserError(`Failed to list comments: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
