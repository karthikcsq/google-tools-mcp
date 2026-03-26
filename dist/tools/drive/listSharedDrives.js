import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'listSharedDrives',
        description: 'Lists all Shared Drives (Team Drives) the user has access to. Use the returned drive ID with listFolderContents to browse its contents.',
        parameters: z.object({
            maxResults: z
                .number()
                .int()
                .min(1)
                .max(100)
                .optional()
                .default(50)
                .describe('Maximum number of shared drives to return.'),
            pageToken: z
                .string()
                .optional()
                .describe('Token for fetching the next page of results.'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info('Listing shared drives');
            try {
                const response = await drive.drives.list({
                    pageSize: args.maxResults,
                    pageToken: args.pageToken || undefined,
                    fields: 'nextPageToken,drives(id,name,createdTime,hidden)',
                });
                const drives = (response.data.drives || []).map((d) => ({
                    id: d.id,
                    name: d.name,
                    createdTime: d.createdTime,
                    hidden: d.hidden || false,
                }));
                const result = {
                    drives,
                    nextPageToken: response.data.nextPageToken || null,
                    totalCount: drives.length,
                };
                return JSON.stringify(result, null, 2);
            }
            catch (error) {
                log.error(`Error listing shared drives: ${error.message || error}`);
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure the Drive API scope includes shared drives.');
                throw new UserError(`Failed to list shared drives: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
