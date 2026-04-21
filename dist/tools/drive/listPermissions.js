import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'listPermissions',
        description: 'Lists all sharing permissions on a Drive file or folder. Shows who the file is shared with (users, groups, domains, anyone) along with their roles (reader, commenter, writer, owner, etc.). Use addPermission/updatePermission/removePermission to change sharing.',
        parameters: z.object({
            fileId: z.string().describe('The ID of the file or folder whose permissions to list.'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Listing permissions for file: ${args.fileId}`);
            try {
                const response = await drive.permissions.list({
                    fileId: args.fileId,
                    fields: 'permissions(id,type,role,emailAddress,domain,displayName,allowFileDiscovery,deleted,pendingOwner)',
                    supportsAllDrives: true,
                });
                const permissions = (response.data.permissions || []).map((p) => ({
                    id: p.id,
                    type: p.type,
                    role: p.role,
                    emailAddress: p.emailAddress || null,
                    domain: p.domain || null,
                    displayName: p.displayName || null,
                    allowFileDiscovery: p.allowFileDiscovery ?? null,
                    deleted: p.deleted ?? false,
                    pendingOwner: p.pendingOwner ?? false,
                }));
                return JSON.stringify({ fileId: args.fileId, permissions }, null, 2);
            }
            catch (error) {
                log.error(`Error listing permissions: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError(`File not found (ID: ${args.fileId}).`);
                if (error.code === 403)
                    throw new UserError('Permission denied. You need access to the file to list its permissions.');
                throw new UserError(`Failed to list permissions: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
