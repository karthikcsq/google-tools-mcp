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
 */
export function trackRead(fileId, modifiedTime, content) {
    readLog.set(fileId, {
        readAt: new Date(),
        modifiedTime: modifiedTime || null,
        content: typeof content === 'string' ? content : null,
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
 */
export function trackMutation(fileId) {
    const entry = readLog.get(fileId);
    if (entry) {
        entry.readAt = new Date();
        // Clear modifiedTime — it will be stale after our mutation.
        // The next guardMutation call will fetch fresh modifiedTime.
        entry.modifiedTime = null;
        // Content is also stale after our mutation; clear so a future diff
        // doesn't show our own edits as "external" changes.
        entry.content = null;
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
