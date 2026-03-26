import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'listSharedWithMe',
        description: 'Lists files and folders that have been shared with the user ("Shared with me"). Returns items shared by others that are not in the user\'s own Drive. Use folder IDs with listFolderContents to navigate into shared folders.',
        parameters: z.object({
            mimeType: z
                .string()
                .optional()
                .describe('Filter by MIME type. Use "application/vnd.google-apps.folder" for folders only, "application/vnd.google-apps.document" for Docs, "application/vnd.google-apps.spreadsheet" for Sheets, etc.'),
            query: z
                .string()
                .optional()
                .describe('Search query to filter shared items by name (uses "contains" matching).'),
            maxResults: z
                .number()
                .int()
                .min(1)
                .max(100)
                .optional()
                .default(50)
                .describe('Maximum number of items to return.'),
            pageToken: z
                .string()
                .optional()
                .describe('Token for fetching the next page of results.'),
            orderBy: z
                .enum(['name', 'modifiedTime', 'sharedWithMeTime'])
                .optional()
                .default('sharedWithMeTime')
                .describe('How to sort results. Defaults to most recently shared first.'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info('Listing shared with me');
            try {
                let queryParts = ['sharedWithMe=true', 'trashed=false'];
                if (args.mimeType) {
                    queryParts.push(`mimeType='${args.mimeType}'`);
                }
                if (args.query) {
                    queryParts.push(`name contains '${args.query.replace(/'/g, "\\'")}'`);
                }
                const orderBy = args.orderBy === 'sharedWithMeTime'
                    ? 'sharedWithMeTime desc'
                    : args.orderBy === 'modifiedTime'
                        ? 'modifiedTime desc'
                        : 'name';
                const response = await drive.files.list({
                    q: queryParts.join(' and '),
                    pageSize: args.maxResults,
                    pageToken: args.pageToken || undefined,
                    orderBy,
                    fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,sharedWithMeTime,sharingUser(displayName,emailAddress),webViewLink,owners(displayName))',
                    supportsAllDrives: true,
                    includeItemsFromAllDrives: true,
                });
                const items = response.data.files || [];
                const folders = items
                    .filter((f) => f.mimeType === 'application/vnd.google-apps.folder')
                    .map((f) => ({
                    id: f.id,
                    name: f.name,
                    sharedWithMeTime: f.sharedWithMeTime,
                    sharedBy: f.sharingUser?.displayName || f.owners?.[0]?.displayName || null,
                    sharedByEmail: f.sharingUser?.emailAddress || null,
                }));
                const files = items
                    .filter((f) => f.mimeType !== 'application/vnd.google-apps.folder')
                    .map((f) => ({
                    id: f.id,
                    name: f.name,
                    mimeType: f.mimeType,
                    modifiedTime: f.modifiedTime,
                    sharedWithMeTime: f.sharedWithMeTime,
                    sharedBy: f.sharingUser?.displayName || f.owners?.[0]?.displayName || null,
                    sharedByEmail: f.sharingUser?.emailAddress || null,
                }));
                const result = {
                    folders,
                    files,
                    nextPageToken: response.data.nextPageToken || null,
                    totalCount: items.length,
                };
                return JSON.stringify(result, null, 2);
            }
            catch (error) {
                log.error(`Error listing shared items: ${error.message || error}`);
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have the correct Drive API scopes.');
                throw new UserError(`Failed to list shared items: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
