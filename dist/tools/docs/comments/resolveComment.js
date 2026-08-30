import { publicError, isPublicError, wrapOperationError, getApiErrorDetail } from '../../../errors.js';
import { z } from 'zod';
import { getDriveClient } from '../../../clients.js';
import { DocumentIdParameter } from '../../../types.js';
export function register(server) {
    server.addTool({
        name: 'resolveComment',
        description: 'Marks a comment as resolved by posting a reply with the resolve action (the only Drive API mechanism that actually flips resolved status — `comments.update` cannot write it). Verifies the result and throws if the comment is still unresolved afterward.',
        parameters: DocumentIdParameter.extend({
            commentId: z.string().describe('The ID of the comment to resolve'),
            note: z.string().optional().describe('Optional text for the resolution reply (e.g. explaining how the comment was addressed).'),
        }),
        execute: async (args, { log }) => {
            log.info(`Resolving comment ${args.commentId} in doc ${args.documentId}`);
            try {
                const drive = await getDriveClient();
                // The only supported resolution mechanism: a reply carrying
                // action: 'resolve'. `comments.resolved` is output-only and
                // silently ignores writes through comments.update.
                await drive.replies.create({
                    fileId: args.documentId,
                    commentId: args.commentId,
                    fields: 'id,action',
                    requestBody: {
                        action: 'resolve',
                        content: args.note ?? '',
                    },
                });
                // Verify the resolved status was actually set.
                const verifyComment = await drive.comments.get({
                    fileId: args.documentId,
                    commentId: args.commentId,
                    fields: 'resolved',
                });
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                if (verifyComment.data.resolved) {
                    return `${docUrl}\nComment ${args.commentId} has been marked as resolved.`;
                }
                throw publicError(`Resolving comment ${args.commentId} did not persist: the comment still reports unresolved after the resolve reply was created.`);
            }
            catch (error) {
                if (isPublicError(error)) throw error;
                log.error(`Error resolving comment: ${error.message || error}`);
                // The Drive comments API's own description plus its structured
                // numeric code. Both are validated upstream fields; the thrown
                // object's own message and `code` are not consulted.
                const detail = getApiErrorDetail(error);
                if (!detail) throw wrapOperationError('resolve document comment', error, { status: error?.code });
                throw publicError(
                    `Failed to resolve comment: ${detail.description}${detail.code ? ` (Code: ${detail.code})` : ''}`
                );
            }
        },
    });
}
