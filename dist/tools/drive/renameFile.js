import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'renameFile',
        description: 'Renames a file or folder in Google Drive. Returns the updated file info.',
        parameters: z.object({
            fileId: z
                .string()
                .describe('The file or folder ID from a Google Drive URL or a previous tool result.'),
            newName: z.string().min(1).describe('New name for the file or folder.'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Renaming file ${args.fileId} to "${args.newName}"`);
            try {
                const response = await drive.files.update({
                    fileId: args.fileId,
                    requestBody: {
                        name: args.newName,
                    },
                    fields: 'id,name,webViewLink',
                    supportsAllDrives: true,
                });
                const file = response.data;
                return `Successfully renamed to "${file.name}" (ID: ${file.id})\nLink: ${file.webViewLink}`;
            }
            catch (error) {
                log.error(`Error renaming file: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError('File not found. Check the file ID.');
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have write access to this file.');
                throw new UserError(`Failed to rename file: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
