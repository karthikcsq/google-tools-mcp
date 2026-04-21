import { UserError } from 'fastmcp';
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
                log.error(`Error removing permission: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError(`Permission or file not found (fileId: ${args.fileId}, permissionId: ${args.permissionId}).`);
                if (error.code === 403)
                    throw new UserError('Permission denied. You need writer+ access (or be the owner) to modify sharing.');
                const apiMsg = error.response?.data?.error?.message || error.message || 'Unknown error';
                throw new UserError(`Failed to remove permission: ${apiMsg}`);
            }
        },
    });
}
