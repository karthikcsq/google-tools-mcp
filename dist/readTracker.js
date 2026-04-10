// In-memory tracker for read-before-edit guards (issue #18).
// Tracks which files have been read in this session and when.
import { UserError } from 'fastmcp';
import { getDriveClient } from './clients.js';
import { logger } from './logger.js';

// Map of fileId → { readAt: Date, modifiedTime: string (ISO) }
const readLog = new Map();

/**
 * Record that a file was read. Call from all read tools.
 */
export function trackRead(fileId, modifiedTime) {
    readLog.set(fileId, {
        readAt: new Date(),
        modifiedTime: modifiedTime || null,
    });
}

/**
 * Guard a mutation. Call from all mutating tools before making changes.
 * Throws UserError if the file hasn't been read, or if it was modified externally.
 *
 * @param fileId - The file/document/spreadsheet ID
 * @param opts.skipExternalCheck - If true, skip the Drive API modifiedTime check (for performance)
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
    }
}

/**
 * Check if a file has been read (without throwing).
 */
export function hasBeenRead(fileId) {
    return readLog.has(fileId);
}
