import { publicError, isPublicError, wrapOperationError, getApiErrorDetail } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'updatePermission',
        description: 'Changes the role (access level) of an existing sharing permission. Use listPermissions first to get the permissionId.',
        parameters: z.object({
            fileId: z.string().describe('The ID of the file or folder.'),
            permissionId: z
                .string()
                .describe('The ID of the permission to update (from listPermissions).'),
            role: z
                .enum(['reader', 'commenter', 'writer', 'fileOrganizer', 'organizer', 'owner'])
                .describe('New access level. Use owner only with transferOwnership=true.'),
            transferOwnership: z
                .boolean()
                .optional()
                .default(false)
                .describe("Set to true when transferring ownership (role must be 'owner')."),
        }),
        execute: async (args, { log }) => {
            if (args.role === 'owner' && !args.transferOwnership) {
                throw publicError("Role 'owner' requires transferOwnership=true.");
            }
            const drive = await getDriveClient();
            log.info(`Updating permission ${args.permissionId} on ${args.fileId} to role=${args.role}`);
            try {
                const response = await drive.permissions.update({
                    fileId: args.fileId,
                    permissionId: args.permissionId,
                    requestBody: { role: args.role },
                    transferOwnership: args.transferOwnership,
                    supportsAllDrives: true,
                    fields: 'id,type,role,emailAddress,domain,displayName,allowFileDiscovery,pendingOwner',
                });
                return JSON.stringify(response.data, null, 2);
            }
            catch (error) {
                if (isPublicError(error)) throw error;
                log.error(`Error updating permission: ${error.message || error}`);
                if (error.code === 404)
                    throw publicError(`Permission or file not found (fileId: ${args.fileId}, permissionId: ${args.permissionId}).`);
                if (error.code === 403)
                    throw publicError('Permission denied. You need writer+ access (or be the owner) to modify sharing.');
                // Validated upstream detail (e.g. an illegal role change) stays
                // caller-visible; the raw thrown text does not.
                const detail = getApiErrorDetail(error);
                if (!detail) throw wrapOperationError('update Drive permission', error, { status: error?.code });
                throw publicError(`Failed to update permission: ${detail.description}`);
            }
        },
    });
}
