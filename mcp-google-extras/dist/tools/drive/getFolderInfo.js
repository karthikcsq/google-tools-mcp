import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'getFolderInfo',
        description: 'Gets metadata about a Drive folder including its name, owner, sharing status, and parent folder.',
        parameters: z.object({
            folderId: z.string().describe('ID of the folder to get information about.'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Getting folder info: ${args.folderId}`);
            try {
                const response = await drive.files.get({
                    fileId: args.folderId,
                    fields: 'id,name,description,createdTime,modifiedTime,webViewLink,owners(displayName,emailAddress),lastModifyingUser(displayName),shared,parents',
                    supportsAllDrives: true,
                });
                const file = response.data;
                if (file.mimeType !== 'application/vnd.google-apps.folder') {
                    throw new UserError('The specified ID does not belong to a folder.');
                }
                const info = {
                    id: file.id,
                    name: file.name,
                    createdTime: file.createdTime,
                    modifiedTime: file.modifiedTime,
                    owner: file.owners?.[0]?.displayName || null,
                    lastModifyingUser: file.lastModifyingUser?.displayName || null,
                    shared: file.shared || false,
                    url: file.webViewLink,
                    description: file.description || null,
                    parentFolderId: file.parents?.[0] || null,
                };
                return JSON.stringify(info, null, 2);
            }
            catch (error) {
                log.error(`Error getting folder info: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError(`Folder not found (ID: ${args.folderId}).`);
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have access to this folder.');
                throw new UserError(`Failed to get folder info: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
