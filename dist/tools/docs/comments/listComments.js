import { publicError, isPublicError, wrapOperationError } from '../../../errors.js';
import { z } from 'zod';
import { getDriveClient } from '../../../clients.js';
import { DocumentIdParameter } from '../../../types.js';

const CONTENT_TRUNCATE_LIMIT = 2000;
const TRUNCATION_MARKER = '…[truncated]';

function truncateText(text) {
    if (typeof text !== 'string' || text.length <= CONTENT_TRUNCATE_LIMIT) return text;
    return `${text.slice(0, CONTENT_TRUNCATE_LIMIT)}${TRUNCATION_MARKER}`;
}

function mapReply(reply) {
    return {
        id: reply.id,
        author: reply.author?.displayName || null,
        authorIsMe: reply.author?.me === true,
        content: truncateText(reply.content),
        action: reply.action || null,
        createdTime: reply.createdTime,
    };
}

// A comment is "unanswered" if it is unresolved and either has no replies, or
// its most recent reply was not written by the authenticated user. This is a
// heuristic, not a guarantee: it cannot tell whether a reply from someone
// else already fully addressed the comment, and treats any self-authored
// last reply as "handled" even if it was itself a question.
function isUnanswered(comment) {
    if (comment.resolved) return false;
    const replies = comment.replies || [];
    if (replies.length === 0) return true;
    const lastReply = replies[replies.length - 1];
    return lastReply.author?.me !== true;
}

export function register(server) {
    server.addTool({
        name: 'listComments',
        description: 'Lists comments in a document with accurate reply metadata, resolved status, and quoted text. Supports incremental polling (updatedAfter), pagination (maxResults/pageToken), and an unansweredOnly filter. Returns data needed to call getComment, replyToComment, resolveComment, updateComment, or deleteComment. Comment/reply/quoted text over 2,000 characters is truncated with a "…[truncated]" marker.',
        parameters: DocumentIdParameter.extend({
            maxResults: z
                .number()
                .int()
                .min(1)
                .max(100)
                .default(100)
                .describe('Maximum number of comments to return in this page (1-100, default 100).'),
            pageToken: z
                .string()
                .optional()
                .describe('Token from a previous listComments response to fetch the next page.'),
            updatedAfter: z
                .string()
                .datetime()
                .optional()
                .describe('ISO 8601 datetime. Only return comments/replies modified after this time (maps to the Drive API startModifiedTime filter). Use for incremental polling.'),
            includeDeleted: z
                .boolean()
                .default(false)
                .describe('Whether to include deleted comments (their content will be empty).'),
            includeQuotedText: z
                .boolean()
                .default(true)
                .describe('Whether to include the quoted document text each comment is anchored to. Set false to save tokens.'),
            unansweredOnly: z
                .boolean()
                .default(false)
                .describe('If true, only return unresolved comments whose latest reply (if any) was not written by the authenticated user. Heuristic: a comment with no replies counts as unanswered; a comment last replied to by the authenticated user counts as answered even if that reply did not resolve it. Filtering happens AFTER fetching this page: count and comments reflect the post-filter page, while nextPageToken is computed from the pre-filter page, so a page that filters down to zero comments can still carry a nextPageToken — follow it rather than reading an empty page as "no more results".'),
        }),
        execute: async (args, { log }) => {
            log.info(`Listing comments for document ${args.documentId}`);
            try {
                const drive = await getDriveClient();
                const response = await drive.comments.list({
                    fileId: args.documentId,
                    fields: 'nextPageToken,comments(id,content,quotedFileContent,author(displayName,me),createdTime,modifiedTime,resolved,replies(id,content,action,author(displayName,me),createdTime))',
                    pageSize: args.maxResults,
                    pageToken: args.pageToken,
                    includeDeleted: args.includeDeleted,
                    ...(args.updatedAfter ? { startModifiedTime: args.updatedAfter } : {}),
                });
                let rawComments = response.data.comments || [];
                const fetchedCount = rawComments.length;
                let filteredOutCount = 0;
                if (args.unansweredOnly) {
                    const filtered = rawComments.filter(isUnanswered);
                    filteredOutCount = rawComments.length - filtered.length;
                    rawComments = filtered;
                }
                const comments = rawComments.map((comment) => {
                    const replies = comment.replies || [];
                    const mapped = {
                        id: comment.id,
                        author: comment.author?.displayName || null,
                        authorIsMe: comment.author?.me === true,
                        content: truncateText(comment.content),
                        resolved: comment.resolved || false,
                        createdTime: comment.createdTime,
                        modifiedTime: comment.modifiedTime,
                        replyCount: replies.length,
                        replies: replies.map(mapReply),
                    };
                    if (args.includeQuotedText) {
                        mapped.quotedText = truncateText(comment.quotedFileContent?.value || null);
                    }
                    return mapped;
                });
                // count is post-filter, nextPageToken is pre-filter: a page
                // that unansweredOnly filters down to zero must not read as
                // "nothing left to see" when a token still says otherwise.
                const note = (args.unansweredOnly && fetchedCount > 0 && filteredOutCount > 0)
                    ? `${filteredOutCount} comment${filteredOutCount === 1 ? '' : 's'} on this page were filtered out by unansweredOnly` +
                      (response.data.nextPageToken ? '; more pages exist — follow nextPageToken.' : '.')
                    : undefined;
                return JSON.stringify({
                    comments,
                    count: comments.length,
                    nextPageToken: response.data.nextPageToken || undefined,
                    ...(note ? { note } : {}),
                }, null, 2);
            }
            catch (error) {
                if (isPublicError(error)) throw error;
                log.error(`Error listing comments: ${error.message || error}`);
                throw wrapOperationError('list document comments', error, { status: error?.code });
            }
        },
    });
}
