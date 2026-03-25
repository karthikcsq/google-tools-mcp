import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'listFolderContents',
        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive.",
        parameters: z.object({
            folderId: z
                .string()
                .describe('ID of the folder to list contents of. Use "root" for the root Drive folder.'),
            includeSubfolders: z
                .boolean()
                .optional()
                .default(true)
                .describe('Whether to include subfolders in results.'),
            includeFiles: z
                .boolean()
                .optional()
                .default(true)
                .describe('Whether to include files in results.'),
            maxResults: z
                .number()
                .int()
                .min(1)
                .max(100)
                .optional()
                .default(50)
                .describe('Maximum number of items to return.'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Listing contents of folder: ${args.folderId}`);
            try {
                let queryString = `'${args.folderId}' in parents and trashed=false`;
                // Filter by type if specified
                if (!args.includeSubfolders && !args.includeFiles) {
                    throw new UserError('At least one of includeSubfolders or includeFiles must be true.');
                }
                if (!args.includeSubfolders) {
                    queryString += ` and mimeType!='application/vnd.google-apps.folder'`;
                }
                else if (!args.includeFiles) {
                    queryString += ` and mimeType='application/vnd.google-apps.folder'`;
                }
                const response = await drive.files.list({
                    q: queryString,
                    pageSize: args.maxResults,
                    orderBy: 'folder,name',
                    fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
                    supportsAllDrives: true,
                    includeItemsFromAllDrives: true,
                });
                const items = response.data.files || [];
                const folders = items
                    .filter((f) => f.mimeType === 'application/vnd.google-apps.folder')
                    .map((f) => ({
                    id: f.id,
                    name: f.name,
                    modifiedTime: f.modifiedTime,
                }));
                const files = items
                    .filter((f) => f.mimeType !== 'application/vnd.google-apps.folder')
                    .map((f) => ({
                    id: f.id,
                    name: f.name,
                    mimeType: f.mimeType,
                    modifiedTime: f.modifiedTime,
                }));
                return JSON.stringify({ folders, files }, null, 2);
            }
            catch (error) {
                log.error(`Error listing folder contents: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError('Folder not found. Check the folder ID.');
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have access to this folder.');
                throw new UserError(`Failed to list folder contents: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
