import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
import { guardMutation } from '../../readTracker.js';
import { beginDriveDeletion, ResourceReadHandleParameter } from '../../resourceHandles.js';
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
            readHandle: ResourceReadHandleParameter,
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Deleting file ${args.fileId} ${args.permanent ? '(permanent)' : '(to trash)'}`);
            try {
                const lease = await beginDriveDeletion({
                    fileId: args.fileId, readHandle: args.readHandle, drive,
                    legacyGuard: () => guardMutation(args.fileId, { skipExternalCheck: true }),
                });
                const fileInfo = lease.file ?? (await drive.files.get({
                    fileId: args.fileId, fields: 'name,mimeType', supportsAllDrives: true,
                })).data;
                const fileName = fileInfo.name;
                const isFolder = fileInfo.mimeType === 'application/vnd.google-apps.folder';
                if (args.permanent) {
                    await lease.remove(() => drive.files.delete({
                        fileId: args.fileId,
                        supportsAllDrives: true,
                    }));
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
                    await lease.remove(() => drive.files.update({
                        fileId: args.fileId,
                        requestBody: {
                            trashed: true,
                        },
                        supportsAllDrives: true,
                    }));
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
                if (isPublicError(error)) throw error;
                log.error(`Error deleting file: ${error.message || error}`);
                if (error.code === 404)
                    throw publicError('File not found. Check the file ID.');
                if (error.code === 403)
                    throw publicError('Permission denied. Make sure you have delete access to this file.');
throw wrapOperationError('delete file', error, { status: error?.code });
            }
        },
    });
}
