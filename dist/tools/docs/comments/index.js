import { register as listComments } from './listComments.js';
import { register as getComment } from './getComment.js';
import { register as addComment } from './addComment.js';
import { register as replyToComment } from './replyToComment.js';
import { register as resolveComment } from './resolveComment.js';
import { register as deleteComment } from './deleteComment.js';
export function registerCommentTools(server) {
    listComments(server);
    getComment(server);
    addComment(server);
    replyToComment(server);
    resolveComment(server);
    deleteComment(server);
}
