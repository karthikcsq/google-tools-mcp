import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'getFileInfo',
        description: 'Gets metadata about any Drive file (document, spreadsheet, PDF, etc.) including its name, type, owner, sharing status, and modification history.',
        parameters: z.object({
            fileId: z.string().describe('The ID of the file to get information about.'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Getting info for file: ${args.fileId}`);
            try {
                const response = await drive.files.get({
                    fileId: args.fileId,
                    fields: 'id,name,description,mimeType,size,createdTime,modifiedTime,webViewLink,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),shared,parents,version',
                    supportsAllDrives: true,
                });
                const file = response.data;
                if (!file) {
                    throw new UserError(`File with ID ${args.fileId} not found.`);
                }
                const info = {
                    id: file.id,
                    name: file.name,
                    mimeType: file.mimeType,
                    createdTime: file.createdTime,
                    modifiedTime: file.modifiedTime,
                    owner: file.owners?.[0]?.displayName || null,
                    lastModifyingUser: file.lastModifyingUser?.displayName || null,
                    shared: file.shared || false,
                    url: file.webViewLink,
                    description: file.description || null,
                };
                return JSON.stringify(info, null, 2);
            }
            catch (error) {
                log.error(`Error getting file info: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError(`File not found (ID: ${args.fileId}).`);
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have access to this file.');
                throw new UserError(`Failed to get file info: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
