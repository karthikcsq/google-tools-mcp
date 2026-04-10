import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
import { guardMutation } from '../../readTracker.js';
export function register(server) {
    server.addTool({
        name: 'deleteFile',
        description: 'Moves a file or folder to the trash, or permanently deletes it. Set permanent=true for irreversible deletion.',
        parameters: z.object({
            fileId: z
                .string()
                .describe('The file or folder ID from a Google Drive URL or a previous tool result.'),
            permanent: z
                .boolean()
                .optional()
                .default(false)
                .describe('If true, permanently deletes the file instead of moving it to trash.'),
        }),
        execute: async (args, { log }) => {
            await guardMutation(args.fileId, { skipExternalCheck: true });
            const drive = await getDriveClient();
            log.info(`Deleting file ${args.fileId} ${args.permanent ? '(permanent)' : '(to trash)'}`);
            try {
                // Get file info before deletion
                const fileInfo = await drive.files.get({
                    fileId: args.fileId,
                    fields: 'name,mimeType',
                    supportsAllDrives: true,
                });
                const fileName = fileInfo.data.name;
                const isFolder = fileInfo.data.mimeType === 'application/vnd.google-apps.folder';
                if (args.permanent) {
                    await drive.files.delete({
                        fileId: args.fileId,
                        supportsAllDrives: true,
                    });
                    return JSON.stringify({
                        success: true,
                        action: 'permanently_deleted',
                        fileId: args.fileId,
                        fileName,
                        type: isFolder ? 'folder' : 'file',
                        message: `Permanently deleted ${isFolder ? 'folder' : 'file'} "${fileName}".`,
                    }, null, 2);
                }
                else {
                    await drive.files.update({
                        fileId: args.fileId,
                        requestBody: {
                            trashed: true,
                        },
                        supportsAllDrives: true,
                    });
                    return JSON.stringify({
                        success: true,
                        action: 'trashed',
                        fileId: args.fileId,
                        fileName,
                        type: isFolder ? 'folder' : 'file',
                        message: `Moved ${isFolder ? 'folder' : 'file'} "${fileName}" to trash. It can be restored from the trash.`,
                    }, null, 2);
                }
            }
            catch (error) {
                log.error(`Error deleting file: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError('File not found. Check the file ID.');
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have delete access to this file.');
                throw new UserError(`Failed to delete file: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
