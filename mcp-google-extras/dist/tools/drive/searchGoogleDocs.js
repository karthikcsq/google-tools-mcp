import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'searchDocuments',
        description: 'Searches for documents by name, content, or both. Use listDocuments for browsing and this tool for targeted queries.',
        parameters: z.object({
            query: z.string().min(1).describe('Search term to find in document names or content.'),
            searchIn: z
                .enum(['name', 'content', 'both'])
                .optional()
                .default('both')
                .describe('Where to search: document names, content, or both.'),
            maxResults: z
                .number()
                .int()
                .min(1)
                .max(50)
                .optional()
                .default(10)
                .describe('Maximum number of results to return.'),
            modifiedAfter: z
                .string()
                .optional()
                .describe('Only return documents modified after this date (ISO 8601 format, e.g., "2024-01-01").'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Searching Google Docs for: "${args.query}" in ${args.searchIn}`);
            try {
                let queryString = "mimeType='application/vnd.google-apps.document' and trashed=false";
                // Add search criteria
                if (args.searchIn === 'name') {
                    queryString += ` and name contains '${args.query}'`;
                }
                else if (args.searchIn === 'content') {
                    queryString += ` and fullText contains '${args.query}'`;
                }
                else {
                    queryString += ` and (name contains '${args.query}' or fullText contains '${args.query}')`;
                }
                // Add date filter if provided
                if (args.modifiedAfter) {
                    queryString += ` and modifiedTime > '${args.modifiedAfter}'`;
                }
                const response = await drive.files.list({
                    q: queryString,
                    pageSize: args.maxResults,
                    orderBy: 'modifiedTime desc',
                    fields: 'files(id,name,modifiedTime,createdTime,webViewLink,owners(displayName),parents)',
                    supportsAllDrives: true,
                    includeItemsFromAllDrives: true,
                });
                const files = response.data.files || [];
                const documents = files.map((file) => ({
                    id: file.id,
                    name: file.name,
                    modifiedTime: file.modifiedTime,
                    owner: file.owners?.[0]?.displayName || null,
                    url: file.webViewLink,
                }));
                return JSON.stringify({ documents }, null, 2);
            }
            catch (error) {
                log.error(`Error searching Google Docs: ${error.message || error}`);
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have granted Google Drive access to the application.');
                throw new UserError(`Failed to search documents: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
