import { publicError, isPublicError, wrapOperationError } from '../../../errors.js';
import { z } from 'zod';
import { getDriveClient } from '../../../clients.js';
import { DocumentIdParameter } from '../../../types.js';
import { refreshTrackedRevisionAfterComment } from './trackedRevision.js';
export function register(server) {
    server.addTool({
        name: 'updateComment',
        description: 'Edits a top-level comment\'s text in place, preserving its ID and creation time (unlike delete + recreate). Note: comment.resolved is a read-only field and cannot be changed here — use resolveComment.',
        parameters: DocumentIdParameter.extend({
            commentId: z.string().describe('The ID of the comment to update'),
            content: z.string().min(1).describe('The new text content of the comment.'),
        }),
        execute: async (args, { log }) => {
            log.info(`Updating comment ${args.commentId} in doc ${args.documentId}`);
            try {
                const drive = await getDriveClient();
                const response = await drive.comments.update({
                    fileId: args.documentId,
                    commentId: args.commentId,
                    fields: 'id,content,modifiedTime',
                    requestBody: {
                        content: args.content,
                    },
                });
                await refreshTrackedRevisionAfterComment(args.documentId, log);
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                return `${docUrl}\nComment ${response.data.id} updated. New modifiedTime: ${response.data.modifiedTime}`;
            }
            catch (error) {
                if (isPublicError(error)) throw error;
                log.error(`Error updating comment: ${error.message || error}`);
                throw wrapOperationError('update document comment', error, { status: error?.code });
            }
        },
    });
}
