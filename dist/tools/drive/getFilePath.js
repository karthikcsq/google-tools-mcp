import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'getFilePath',
        description: 'Returns the full folder path of a Drive file from root to the file itself (e.g. "My Drive/Projects/Docs/report.pdf"). Walks up the parent chain to reconstruct the complete path.',
        parameters: z.object({
            fileId: z.string().describe('The ID of the file or folder to get the path for.'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Getting full path for file: ${args.fileId}`);
            try {
                const pathParts = [];
                let currentId = args.fileId;

                while (currentId) {
                    const response = await drive.files.get({
                        fileId: currentId,
                        fields: 'id,name,parents',
                        supportsAllDrives: true,
                    });
                    const file = response.data;
                    if (!file) break;

                    pathParts.unshift(file.name);

                    if (file.parents && file.parents.length > 0) {
                        currentId = file.parents[0];
                    } else {
                        break;
                    }
                }

                const fullPath = pathParts.join('/');

                return JSON.stringify({ fileId: args.fileId, path: fullPath }, null, 2);
            } catch (error) {
                if (isPublicError(error)) throw error;
                log.error(`Error getting file path: ${error.message || error}`);
                if (error.code === 404)
                    throw publicError(`File not found (ID: ${args.fileId}).`);
                if (error.code === 403)
                    throw publicError('Permission denied. Make sure you have access to this file.');
throw wrapOperationError('get file path', error, { status: error?.code });
            }
        },
    });
}
