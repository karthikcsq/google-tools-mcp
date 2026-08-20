import { publicError, isPublicError, wrapOperationError, getApiErrorDetail } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'removePermission',
        description: 'Revokes a specific sharing permission from a Drive file or folder. Use listPermissions first to get the permissionId you want to remove.',
        parameters: z.object({
            fileId: z.string().describe('The ID of the file or folder.'),
            permissionId: z
                .string()
                .describe('The ID of the permission to remove (from listPermissions).'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Removing permission ${args.permissionId} from file ${args.fileId}`);
            try {
                await drive.permissions.delete({
                    fileId: args.fileId,
                    permissionId: args.permissionId,
                    supportsAllDrives: true,
                });
                return JSON.stringify({
                    fileId: args.fileId,
                    permissionId: args.permissionId,
                    removed: true,
                }, null, 2);
            }
            catch (error) {
                if (isPublicError(error)) throw error;
                log.error(`Error removing permission: ${error.message || error}`);
                if (error.code === 404)
                    throw publicError(`Permission or file not found (fileId: ${args.fileId}, permissionId: ${args.permissionId}).`);
                if (error.code === 403)
                    throw publicError('Permission denied. You need writer+ access (or be the owner) to modify sharing.');
                // Validated upstream detail (e.g. "cannot remove the last
                // organizer") stays caller-visible; the raw thrown text does not.
                const detail = getApiErrorDetail(error);
                if (!detail) throw wrapOperationError('remove Drive permission', error, { status: error?.code });
                throw publicError(`Failed to remove permission: ${detail.description}`);
            }
        },
    });
}
