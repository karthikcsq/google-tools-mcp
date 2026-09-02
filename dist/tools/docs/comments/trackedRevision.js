import { getDocsClient } from '../../../clients.js';
import { hasBeenRead, refreshRevision } from '../../../readTracker.js';

/**
 * Re-arm the read tracker's WriteControl revision after a comment operation
 * on a document this session has already read.
 *
 * Every Drive comment write (create, update, delete, reply, resolve) advances
 * the Docs `revisionId` but leaves Drive's `modifiedTime` untouched, so the
 * next guarded body write (appendText, replaceDocumentWithMarkdown, ...) would
 * pass the external-change check and then be refused by Google as a revision
 * conflict, reported to the caller as "changed since you last read it". The
 * body did not change; only the revision the guard is pinned to went stale.
 *
 * Only runs when the document is tracked in this session: an untracked
 * document has no revision to refresh, and on the stateless HTTP transport the
 * per-request log never holds one. A failed fetch is logged and left alone so
 * the next write still fails closed (conflict, then re-read) rather than open.
 *
 * @param {string} documentId
 * @param {{ warn?: (msg: string) => void }} [log]
 */
export async function refreshTrackedRevisionAfterComment(documentId, log) {
    if (!hasBeenRead(documentId)) return;
    try {
        const docs = await getDocsClient();
        const res = await docs.documents.get({ documentId, fields: 'revisionId' });
        refreshRevision(documentId, res?.data?.revisionId);
    } catch (error) {
        log?.warn?.(`Could not refresh the tracked revision of ${documentId} after the comment change: `
            + `${error?.message || error}. The next edit may report a revision conflict; read the document again if it does.`);
    }
}
