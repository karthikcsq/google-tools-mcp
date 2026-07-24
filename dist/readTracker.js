// In-memory tracker for read-before-edit guards (issue #18) and diff-aware
// reading/editing (issue #21).
// Tracks which files have been read in this session, when, and optionally the
// content snapshot at the time of the last read so blocked mutations can return
// a unified diff instead of a bare "modified externally" error.
import { UserError } from 'fastmcp';
import { createPatch } from 'diff';
import { getDriveClient } from './clients.js';
import { logger } from './logger.js';

// Map of fileId → { readAt: Date, modifiedTime: string|null, content: string|null }
// content is only populated for file types that opt in (currently Google Docs).
// Sheets and raw Drive files still track read/modifiedTime only.
const readLog = new Map();

/**
 * Record that a file was read. Call from all read tools.
 * @param fileId
 * @param modifiedTime Drive API modifiedTime (ISO string) at read time, or null
 * @param content Optional content snapshot (e.g. markdown for docs) used for diffs
 * @param revisionId Optional Google Docs revision ID used for optimistic concurrency
 */
export function trackRead(fileId, modifiedTime, content, revisionId) {
    readLog.set(fileId, {
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
 * @param opts.contentFetcher - Optional async () => string. If provided and an
 *   external-change conflict is detected, the fetcher is used to grab current
 *   content and the UserError message will include a unified diff plus rebase
 *   instructions rather than a plain error.
 */
export async function guardMutation(fileId, opts) {
    const entry = readLog.get(fileId);
    if (!entry) {
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
            if (entry.modifiedTime && currentModifiedTime !== entry.modifiedTime) {
                const readAt = entry.readAt.toISOString();
                // If we have a stored snapshot and the caller can fetch the
                // current content, return a diff instead of a bare error so the
                // model can rebase its edit on top of the new version.
                if (entry.content && typeof opts?.contentFetcher === 'function') {
                    let currentContent;
                    try {
                        currentContent = await opts.contentFetcher();
                    } catch (fetchError) {
                        logger.warn(`contentFetcher failed for ${fileId}: ${fetchError.message}`);
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
                        // Refresh the snapshot so a subsequent read/mutation
                        // works against the new baseline.
                        entry.content = currentContent;
                        entry.modifiedTime = currentModifiedTime;
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
    const entry = readLog.get(fileId);
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
    const entry = readLog.get(fileId);
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
    return readLog.has(fileId);
}

/**
 * Return the content snapshot from the last read, or null if none stored.
 */
export function getLastReadContent(fileId) {
    const entry = readLog.get(fileId);
    return entry?.content ?? null;
}

/** Return the Google Docs revision ID from the last read, or null. */
export function getLastReadRevisionId(fileId) {
    return readLog.get(fileId)?.revisionId ?? null;
}
