import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'createFolder',
        description: 'Creates a new folder in Google Drive. Optionally places it inside an existing parent folder.',
        parameters: z.object({
            name: z.string().min(1).describe('Name for the new folder.'),
            parentFolderId: z
                .string()
                .optional()
                .describe('Parent folder ID. If not provided, creates folder in Drive root.'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Creating folder "${args.name}" ${args.parentFolderId ? `in parent ${args.parentFolderId}` : 'in root'}`);
            try {
                const folderMetadata = {
                    name: args.name,
                    mimeType: 'application/vnd.google-apps.folder',
                };
                if (args.parentFolderId) {
                    folderMetadata.parents = [args.parentFolderId];
                }
                const response = await drive.files.create({
                    requestBody: folderMetadata,
                    fields: 'id,name,parents,webViewLink',
                    supportsAllDrives: true,
                });
                const folder = response.data;
                return JSON.stringify({
                    id: folder.id,
                    name: folder.name,
                    url: folder.webViewLink,
                }, null, 2);
            }
            catch (error) {
                log.error(`Error creating folder: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError('Parent folder not found. Check the parent folder ID.');
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have write access to the parent folder.');
                throw new UserError(`Failed to create folder: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
