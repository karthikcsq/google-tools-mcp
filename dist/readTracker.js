// In-memory tracker for read-before-edit guards (issue #18) and diff-aware
// reading/editing (issue #21).
// Tracks which files have been read in the current scope, when, and optionally the
// content snapshot at the time of the last read so blocked mutations can return
// a unified diff instead of a bare "modified externally" error.
import { UserError } from './errors.js';
import { createPatch } from 'diff';
import { getDriveClient } from './clients.js';
import { logger } from './logger.js';
import { getRequestContext } from './requestContext.js';

// Read logs keyed by the request context object itself.
//
// The runtime has no MCP sessions. Putting every stateless HTTP request into
// ONE shared namespace would mean request A's read of document X sits in the
// same map guardMutation consults for request B, and B could mutate X off A's
// snapshot and revision without ever having read it - exactly the cross-client
// isolation failure this scoping exists to stop.
//
// Minting a synthetic per-request key is not a fix either: 2026-07-28 HTTP is
// stateless, so a later mutation request could never find its own earlier read
// anyway. The correct model is that an HTTP request's tracker state is scoped
// to that one request and dies with it, and cross-request authorization comes
// exclusively from an explicit, validated readHandle (dist/docsHandles.js).
// Guarded surfaces with no handle wiring therefore fail closed on HTTP rather
// than silently borrowing another request's read.
//
// A stdio context is per-connection rather than per-request, so a read and a
// later mutation on the same pinned connection still see each other, matching
// the connection-pinned implicit handle state.
//
// WeakMap: an HTTP context is unreachable once its request finishes, so its log
// is collected with it and nothing accumulates.
const requestContextLogs = new WeakMap();

// The no-context namespace. Only callers running outside any transport land
// here: direct unit tests and internal startup code.
//
// The session era kept a Map of these namespaces keyed by MCP session id,
// because one FastMCP process multiplexed many HTTP sessions through this one
// module-global tracker and cleared a namespace on disconnect. Nothing does
// that any more - HTTP requests are context-scoped above and stdio is one
// pinned connection per process - so the map of namespaces collapses to this
// single Map and there is no session state left to clear.
//
// Each entry is fileId -> { readAt, modifiedTime, content, revisionId }.
// content is only populated for file types that opt in (currently Google Docs);
// Sheets and raw Drive files track read/modifiedTime only.
const defaultLog = new Map();

/**
 * True when Drive now reports an modifiedTime strictly EARLIER than the one
 * already recorded for this file. Both values come from the same source
 * (drive.files.get), so they are comparable to each other — unlike `readAt`,
 * which is this process's local clock and must never be compared against a
 * Google timestamp. Unparseable values answer false, which keeps the existing
 * "different string means changed" behavior for anything non-RFC3339.
 */
function modifiedTimeWentBackwards(recorded, current) {
    const before = Date.parse(recorded);
    const after = Date.parse(current);
    if (Number.isNaN(before) || Number.isNaN(after)) return false;
    return after < before;
}

function logForCurrentSession() {
    const context = getRequestContext();
    if (!context) return defaultLog;
    let contextLog = requestContextLogs.get(context);
    if (!contextLog) {
        contextLog = new Map();
        requestContextLogs.set(context, contextLog);
    }
    return contextLog;
}

/**
 * Record that a file was read. Call from all read tools.
 * @param fileId
 * @param modifiedTime Drive API modifiedTime (ISO string) at read time, or null
 * @param content Optional content snapshot (e.g. markdown for docs) used for diffs
 * @param revisionId Optional Google Docs revision ID used for optimistic concurrency
 */
export function trackRead(fileId, modifiedTime, content, revisionId) {
    logForCurrentSession().set(fileId, {
        readAt: new Date(),
        modifiedTime: modifiedTime || null,
        content: typeof content === 'string' ? content : null,
        revisionId: typeof revisionId === 'string' ? revisionId : null,
    });
}

/**
 * Guard a mutation. Call from all mutating tools before making changes.
 * Throws UserError if the file hasn't been read, or if it was modified externally.
 *
 * @param fileId - The file/document/spreadsheet ID
 * @param opts.skipExternalCheck - If true, skip the Drive API modifiedTime check (for performance)
 * @param opts.contentFetcher - Optional async () => (string | { content: string, revisionId?: string|null }).
 *   If provided and an external-change conflict is detected, the fetcher is used to grab current
 *   content (and, for Google Docs, the revision that content came from) and the UserError message
 *   will include a unified diff plus rebase instructions rather than a plain error. When the fetcher
 *   returns an object with `revisionId`, that revision is stored as the new baseline atomically with
 *   the content/modifiedTime refresh below, so a subsequent rebased write is guarded against the
 *   version the diff was actually taken from rather than the pre-external-edit revision. When the
 *   fetcher returns a bare string (or omits revisionId), the revision can't be known to be current,
 *   so it is cleared instead of left stale — the next write then goes out unguarded rather than with
 *   a guaranteed-stale requiredRevisionId.
 */
export async function guardMutation(fileId, opts) {
    const readLog = logForCurrentSession();
    const entry = readLog.get(fileId);
    if (!entry) {
        if (getRequestContext()?.transport === 'http') {
            // Fail closed. There is deliberately no fallback to a shared
            // namespace here: on the stateless 2026-07-28 HTTP runtime read
            // state is never carried between requests, so authorization must
            // come from an explicit readHandle instead.
            throw new UserError(
                `This file (${fileId}) has not been read in this request. On the 2026-07-28 HTTP ` +
                "runtime read state is never shared between requests, so an earlier request's read " +
                'cannot authorize this write. Google Docs edits take an explicit readHandle returned ' +
                'by readDocument; guarded Sheets and Drive edits have no handle wiring yet and are ' +
                'unavailable over HTTP on this runtime - use the stdio transport for them.'
            );
        }
        throw new UserError(
            `This file (${fileId}) has not been read in this session. ` +
            'Read it first before making changes to ensure you have current content. ' +
            'Use readDocument, readSpreadsheet, readFile, or readDriveFile.'
        );
    }

    // A previous write left the document in a state we can't describe: no
    // revision to guard against and no content snapshot to diff. Refuse rather
    // than let this write go out against a stale baseline. The modifiedTime
    // check below cannot cover this, because it is skipped when modifiedTime
    // is null and would just re-baseline on the post-write value.
    if (entry.requiresReread) {
        throw new UserError(
            `This file (${fileId}) must be read again before it can be edited: ${entry.requiresReread} ` +
            'Read it again (readDocument, readSpreadsheet, readFile, or readDriveFile) and rebase your edit ' +
            'on the current content.'
        );
    }

    // Optionally check if file was modified externally since last read
    if (!opts?.skipExternalCheck) {
        try {
            const drive = await getDriveClient();
            const res = await drive.files.get({
                fileId,
                fields: 'modifiedTime',
                supportsAllDrives: true,
            });
            const currentModifiedTime = res.data.modifiedTime;
            if (entry.modifiedTime && currentModifiedTime !== entry.modifiedTime
                && modifiedTimeWentBackwards(entry.modifiedTime, currentModifiedTime)) {
                // Drive's modifiedTime is eventually consistent: a request served
                // by a lagging replica reports a timestamp OLDER than the one
                // this file's own last read recorded. That is not somebody
                // editing the document, it is the same document seen from
                // further back in time — the shape issue #119 reported, where
                // the "last modified" in the error was earlier than the "last
                // read" it was compared against. Keep the newer baseline so a
                // genuine later bump still trips, and let the write proceed: it
                // is still guarded by the WriteControl revision downstream.
                logger.warn(`Drive reported an older modifiedTime for ${fileId} ` +
                    `(${currentModifiedTime} is before the recorded ${entry.modifiedTime}); not treating it as an external edit.`);
                return;
            }
            if (entry.modifiedTime && currentModifiedTime !== entry.modifiedTime) {
                const readAt = entry.readAt.toISOString();
                // If we have a stored snapshot and the caller can fetch the
                // current content, return a diff instead of a bare error so the
                // model can rebase its edit on top of the new version.
                if (entry.content && typeof opts?.contentFetcher === 'function') {
                    let currentContent;
                    let currentRevisionId;
                    try {
                        const fetched = await opts.contentFetcher();
                        if (fetched && typeof fetched === 'object') {
                            currentContent = fetched.content;
                            currentRevisionId = typeof fetched.revisionId === 'string' ? fetched.revisionId : null;
                        } else {
                            currentContent = fetched;
                            // A bare-string fetcher can't tell us the revision the
                            // content came from. Clear rather than keep the
                            // pre-external-edit revisionId around: a cleared
                            // revision sends the next write out unguarded, which
                            // is safe; a stale one sends it out with a
                            // requiredRevisionId that is guaranteed to conflict.
                            currentRevisionId = null;
                        }
                    } catch (fetchError) {
                        logger.warn(`contentFetcher failed for ${fileId}: ${fetchError.message}`);
                    }
                    if (typeof currentContent === 'string' && currentContent === entry.content) {
                        // The timestamp moved but the content did not: an
                        // autosave tick, a formatting-only touch, or Drive
                        // re-stamping the file after our own preceding write.
                        // Raising here produced issue #119's phantom conflict —
                        // an error carrying an EMPTY diff, whose prescribed
                        // recovery (re-read, inspect, rebase, retry) is a wasted
                        // round trip on a large document, and whose byte-
                        // identical retry always succeeded. There is nothing to
                        // rebase onto when the content is unchanged, and letting
                        // it through costs no safety: the write still carries
                        // the refreshed WriteControl revision below, so a real
                        // concurrent edit is still refused by Google itself.
                        // Same atomic refresh as the diff path below, and for
                        // the same reason: the stored revision is definitively
                        // stale once the timestamp moved, so it is replaced with
                        // the one this content came from (or cleared when the
                        // fetcher could not name one, which sends the next write
                        // out unguarded rather than pinned to a revision that is
                        // guaranteed to conflict).
                        entry.modifiedTime = currentModifiedTime;
                        entry.revisionId = currentRevisionId;
                        logger.warn(`modifiedTime for ${fileId} changed but the content is byte-identical; ` +
                            'refreshing the baseline instead of reporting an external modification.');
                        return;
                    }
                    if (typeof currentContent === 'string') {
                        const patch = createPatch(
                            fileId,
                            entry.content,
                            currentContent,
                            'last read',
                            'current',
                            { context: 3 }
                        );
                        // Refresh content, modifiedTime, AND revisionId together
                        // (atomically, in the same tick) so a subsequent rebased
                        // write is guarded against the version this diff was
                        // actually taken from — not the pre-external-edit
                        // revision, which would otherwise cause a second,
                        // confusing conflict even when the caller correctly
                        // rebuilt its edit from the diff above.
                        entry.content = currentContent;
                        entry.modifiedTime = currentModifiedTime;
                        entry.revisionId = currentRevisionId;
                        throw new UserError(
                            `This file was modified externally since you last read it ` +
                            `(last read: ${readAt}, last modified: ${currentModifiedTime}).\n\n` +
                            'Do NOT re-apply your original edit blindly. Build your new edit on ' +
                            'top of the current version. Below is a unified diff from your last ' +
                            'read to the current document (old → current). If you need the full ' +
                            'current content, call readDocument again.\n\n' +
                            '--- DIFF (last read → current) ---\n' +
                            patch +
                            '--- END DIFF ---'
                        );
                    }
                }
                throw new UserError(
                    `This file was modified externally since you last read it ` +
                    `(last read: ${readAt}, last modified: ${currentModifiedTime}). ` +
                    'Read the file again before editing to ensure you have current content.'
                );
            }
            // Update modifiedTime on successful check
            entry.modifiedTime = currentModifiedTime;
        } catch (error) {
            if (error instanceof UserError) throw error;
            // If we can't check, log warning but allow the mutation
            logger.warn(`Could not verify modifiedTime for ${fileId}: ${error.message}`);
        }
    }
}

/**
 * Update the read tracker after a successful mutation (so subsequent mutations
 * don't fail the external-change check against our own changes).
 *
 * @param fileId
 * @param newRevisionId Optional Google Docs revision ID produced by the write
 *   that just succeeded (the API's batchUpdate response echoes this back as
 *   `writeControl.requiredRevisionId` — "the updated write control after
 *   applying the request"). When provided, the WriteControl guard is
 *   re-armed against this fresh revision instead of being disabled, so a
 *   second write to the same document later in the same session (with no
 *   re-read in between) is still guarded against a genuine concurrent edit —
 *   rather than either (a) silently going out unguarded, or (b) reusing the
 *   now-stale pre-mutation revision and spuriously conflicting with our own
 *   prior write. When omitted, the revision is cleared (legacy/unknown
 *   behavior, same as before).
 */
export function trackMutation(fileId, newRevisionId) {
    const entry = logForCurrentSession().get(fileId);
    if (entry) {
        entry.readAt = new Date();
        // Clear modifiedTime — it will be stale after our mutation.
        // The next guardMutation call will fetch fresh modifiedTime.
        entry.modifiedTime = null;
        // Content is also stale after our mutation; clear so a future diff
        // doesn't show our own edits as "external" changes.
        entry.content = null;
        entry.revisionId = typeof newRevisionId === 'string' ? newRevisionId : null;
    }
}

/**
 * Re-arm the WriteControl revision after an operation of our own that
 * advanced the Docs revision WITHOUT touching the document body.
 *
 * Drive comment operations (comments.create/update/delete, replies.create,
 * including the resolve reply) are the known case: each one moves the Docs
 * `revisionId`, but Drive's `modifiedTime` stays exactly where it was, so
 * guardMutation's external-change check passes and the next write goes out
 * pinned to the pre-comment revision. Google then refuses it as a revision
 * conflict and the caller is told the document "changed since you last read
 * it" when the only thing that changed is the comment they just added.
 *
 * Unlike trackMutation this keeps `content` and `modifiedTime`: the body did
 * not change, so the snapshot is still the right thing to diff against and
 * the timestamp is still the right thing to compare. Only the revision moves.
 * A non-string revision is ignored rather than clearing the guard, so a failed
 * refresh leaves the next write failing closed (conflict, re-read) instead of
 * open (no writeControl at all).
 *
 * @param fileId
 * @param revisionId The Docs revisionId fetched AFTER the operation completed.
 */
export function refreshRevision(fileId, revisionId) {
    const entry = logForCurrentSession().get(fileId);
    if (!entry || entry.requiresReread) return;
    if (typeof revisionId === 'string' && revisionId.length > 0) {
        entry.revisionId = revisionId;
    }
}

/**
 * Mark a file as needing a fresh read before any further mutation.
 *
 * Use this instead of trackMutation after a write whose resulting revision we
 * cannot learn (an Apps Script call that edits the document outside our
 * batchUpdate visibility, for example). trackMutation on its own clears the
 * revision and the modifiedTime, which leaves the next write with nothing to
 * guard against: it sends no writeControl and the external-change check is
 * skipped because modifiedTime is null. That write would then be based on a
 * pre-mutation read without anyone noticing. Blocking it and asking for a
 * re-read is the only safe option when the post-write revision is unknown.
 *
 * @param fileId
 * @param reason Sentence fragment explaining what happened, shown to the caller.
 */
export function requireRereadBeforeMutation(fileId, reason) {
    const entry = logForCurrentSession().get(fileId);
    if (entry) {
        entry.readAt = new Date();
        entry.modifiedTime = null;
        entry.content = null;
        entry.revisionId = null;
        entry.requiresReread = reason || 'a previous write changed it in a way we could not track.';
    }
}

/**
 * Check if a file has been read (without throwing).
 */
export function hasBeenRead(fileId) {
    return logForCurrentSession().has(fileId);
}

/**
 * Return the content snapshot from the last read, or null if none stored.
 */
export function getLastReadContent(fileId) {
    const entry = logForCurrentSession().get(fileId);
    return entry?.content ?? null;
}

/** Return the Google Docs revision ID from the last read, or null. */
export function getLastReadRevisionId(fileId) {
    return logForCurrentSession().get(fileId)?.revisionId ?? null;
}
