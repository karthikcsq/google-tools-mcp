import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'moveFile',
        description: 'Moves a file or folder to a different Drive folder. By default adds the new parent while keeping existing parents; set removeFromAllParents=true for a true move.',
        parameters: z.object({
            fileId: z
                .string()
                .describe('The file or folder ID from a Google Drive URL or a previous tool result.'),
            newParentId: z.string().describe('ID of the destination folder. Use "root" for Drive root.'),
            removeFromAllParents: z
                .boolean()
                .optional()
                .default(false)
                .describe('If true, removes from all current parents. If false, adds to new parent while keeping existing parents.'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Moving file ${args.fileId} to folder ${args.newParentId}`);
            try {
                // First get the current parents
                const fileInfo = await drive.files.get({
                    fileId: args.fileId,
                    fields: 'name,parents',
                    supportsAllDrives: true,
                });
                const fileName = fileInfo.data.name;
                const currentParents = fileInfo.data.parents || [];
                let updateParams = {
                    fileId: args.fileId,
                    addParents: args.newParentId,
                    fields: 'id,name,parents,webViewLink',
                    supportsAllDrives: true,
                };
                if (args.removeFromAllParents && currentParents.length > 0) {
                    updateParams.removeParents = currentParents.join(',');
                }
                const response = await drive.files.update(updateParams);
                const action = args.removeFromAllParents ? 'moved' : 'copied';
                const fileUrl = response.data.webViewLink || `https://drive.google.com/file/d/${response.data.id}/view`;
                return `${fileUrl}\nSuccessfully ${action} "${fileName}" to new location.\nFile ID: ${response.data.id}`;
            }
            catch (error) {
                log.error(`Error moving file: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError('File or destination folder not found. Check the IDs.');
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have write access to both source and destination.');
                throw new UserError(`Failed to move file: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
