import { publicError, isPublicError, wrapOperationError } from '../../../errors.js';
import { z } from 'zod';
import { getDriveClient } from '../../../clients.js';
import { DocumentIdParameter } from '../../../types.js';
import { refreshTrackedRevisionAfterComment } from './trackedRevision.js';
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
                const drive = await getDriveClient();
                await drive.comments.delete({
                    fileId: args.documentId,
                    commentId: args.commentId,
                });
                await refreshTrackedRevisionAfterComment(args.documentId, log);
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                return `${docUrl}\nComment ${args.commentId} has been deleted.`;
            }
            catch (error) {
                if (isPublicError(error)) throw error;
                log.error(`Error deleting comment: ${error.message || error}`);
throw wrapOperationError('delete document comment', error, { status: error?.code });
            }
        },
    });
}
