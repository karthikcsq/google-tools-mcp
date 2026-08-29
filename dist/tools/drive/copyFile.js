import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'copyFile',
        description: "Creates a copy of a file or document in Google Drive. Returns the new copy's ID and URL.",
        parameters: z.object({
            fileId: z
                .string()
                .describe('The file or folder ID from a Google Drive URL or a previous tool result.'),
            name: z
                .string()
                .optional()
                .describe('Name for the copied file (matches the Drive API\'s own "name" field). If not provided, will use "Copy of [original name]".'),
            newName: z
                .string()
                .optional()
                .describe('Deprecated alias for "name", kept for backward compatibility. If both are given, "name" wins.'),
            parentFolderId: z
                .string()
                .optional()
                .describe('ID of folder where copy should be placed. If not provided, places in same location as original.'),
        })
            // Reject unrecognized parameters instead of the Zod default of
            // silently stripping them — an unsupported argument (issue #124:
            // a caller sent `name` back when the schema only accepted
            // `newName`) must surface as a validation error, not vanish with
            // no signal that it was dropped.
            .strict(),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            const requestedName = args.name ?? args.newName;
            log.info(`Copying file ${args.fileId} ${requestedName ? `as "${requestedName}"` : ''}`);
            try {
                // Get original file info
                const originalFile = await drive.files.get({
                    fileId: args.fileId,
                    fields: 'name,parents',
                    supportsAllDrives: true,
                });
                const copyMetadata = {
                    name: requestedName || `Copy of ${originalFile.data.name}`,
                };
                if (args.parentFolderId) {
                    copyMetadata.parents = [args.parentFolderId];
                }
                else if (originalFile.data.parents) {
                    copyMetadata.parents = originalFile.data.parents;
                }
                const response = await drive.files.copy({
                    fileId: args.fileId,
                    requestBody: copyMetadata,
                    fields: 'id,name,webViewLink',
                    supportsAllDrives: true,
                });
                const copiedFile = response.data;
                return JSON.stringify({
                    id: copiedFile.id,
                    name: copiedFile.name,
                    url: copiedFile.webViewLink,
                }, null, 2);
            }
            catch (error) {
                if (isPublicError(error)) throw error;
                log.error(`Error copying file: ${error.message || error}`);
                if (error.code === 404)
                    throw publicError('Original file or destination folder not found. Check the IDs.');
                if (error.code === 403)
                    throw publicError('Permission denied. Make sure you have read access to the original file and write access to the destination.');
throw wrapOperationError('copy file', error, { status: error?.code });
            }
        },
    });
}
