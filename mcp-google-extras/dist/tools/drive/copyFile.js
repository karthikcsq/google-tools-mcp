import { UserError } from 'fastmcp';
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
            newName: z
                .string()
                .optional()
                .describe('Name for the copied file. If not provided, will use "Copy of [original name]".'),
            parentFolderId: z
                .string()
                .optional()
                .describe('ID of folder where copy should be placed. If not provided, places in same location as original.'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Copying file ${args.fileId} ${args.newName ? `as "${args.newName}"` : ''}`);
            try {
                // Get original file info
                const originalFile = await drive.files.get({
                    fileId: args.fileId,
                    fields: 'name,parents',
                    supportsAllDrives: true,
                });
                const copyMetadata = {
                    name: args.newName || `Copy of ${originalFile.data.name}`,
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
                log.error(`Error copying file: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError('Original file or destination folder not found. Check the IDs.');
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have read access to the original file and write access to the destination.');
                throw new UserError(`Failed to copy file: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
