import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'listDocuments',
        description: 'Lists Google Documents in your Drive, optionally filtered by name or content. Use modifiedAfter to find recently changed documents.',
        parameters: z.object({
            maxResults: z
                .number()
                .int()
                .min(1)
                .max(100)
                .optional()
                .default(20)
                .describe('Maximum number of documents to return (1-100).'),
            query: z.string().optional().describe('Search query to filter documents by name or content.'),
            orderBy: z
                .enum(['name', 'modifiedTime', 'createdTime'])
                .optional()
                .default('modifiedTime')
                .describe('Sort order for results.'),
            modifiedAfter: z
                .string()
                .optional()
                .describe('Only return documents modified after this date (ISO 8601 format, e.g., "2024-01-01").'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Listing Google Docs. Query: ${args.query || 'none'}, Max: ${args.maxResults}, Order: ${args.orderBy}`);
            try {
                // Build the query string for Google Drive API
                let queryString = "mimeType='application/vnd.google-apps.document' and trashed=false";
                if (args.query) {
                    queryString += ` and (name contains '${args.query}' or fullText contains '${args.query}')`;
                }
                if (args.modifiedAfter) {
                    const cutoffDate = new Date(args.modifiedAfter).toISOString();
                    queryString += ` and modifiedTime > '${cutoffDate}'`;
                }
                const response = await drive.files.list({
                    q: queryString,
                    pageSize: args.maxResults,
                    orderBy: args.orderBy === 'name' ? 'name' : args.orderBy,
                    fields: 'files(id,name,modifiedTime,createdTime,size,webViewLink,owners(displayName,emailAddress))',
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
                log.error(`Error listing Google Docs: ${error.message || error}`);
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have granted Google Drive access to the application.');
                throw new UserError(`Failed to list documents: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
