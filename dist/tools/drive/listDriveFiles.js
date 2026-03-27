import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';

const MIME_TYPES = {
    document: 'application/vnd.google-apps.document',
    spreadsheet: 'application/vnd.google-apps.spreadsheet',
    presentation: 'application/vnd.google-apps.presentation',
    form: 'application/vnd.google-apps.form',
    pdf: 'application/pdf',
};

export function register(server) {
    server.addTool({
        name: 'listDriveFiles',
        description:
            'Lists files in your Drive, optionally filtered by type (document, spreadsheet, presentation, form, pdf), name/content query, or modification date.',
        parameters: z.object({
            fileType: z
                .enum(['document', 'spreadsheet', 'presentation', 'form', 'pdf', 'all'])
                .optional()
                .default('all')
                .describe('Filter by file type. Defaults to all types.'),
            maxResults: z
                .number()
                .int()
                .min(1)
                .max(100)
                .optional()
                .default(20)
                .describe('Maximum number of files to return (1-100).'),
            query: z
                .string()
                .optional()
                .describe('Search query to filter files by name or content.'),
            orderBy: z
                .enum(['name', 'modifiedTime', 'createdTime'])
                .optional()
                .default('modifiedTime')
                .describe('Sort order for results.'),
            modifiedAfter: z
                .string()
                .optional()
                .describe(
                    'Only return files modified after this date (ISO 8601 format, e.g., "2024-01-01").'
                ),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(
                `Listing Drive files. Type: ${args.fileType}, Query: ${args.query || 'none'}, Max: ${args.maxResults}, Order: ${args.orderBy}`
            );
            try {
                let queryParts = ['trashed=false'];

                // Filter by mime type
                if (args.fileType !== 'all') {
                    queryParts.push(`mimeType='${MIME_TYPES[args.fileType]}'`);
                } else if (!args.query) {
                    // Exclude folders from "all" results only when not doing fullText search
                    // (Drive API doesn't allow fullText contains with negated mimeType filters)
                    queryParts.push("mimeType!='application/vnd.google-apps.folder'");
                }

                if (args.query) {
                    queryParts.push(
                        `(name contains '${args.query}' or fullText contains '${args.query}')`
                    );
                }

                if (args.modifiedAfter) {
                    const cutoffDate = new Date(args.modifiedAfter).toISOString();
                    queryParts.push(`modifiedTime > '${cutoffDate}'`);
                }

                const response = await drive.files.list({
                    q: queryParts.join(' and '),
                    pageSize: args.maxResults,
                    orderBy: args.orderBy === 'name' ? 'name' : args.orderBy,
                    fields: 'files(id,name,mimeType,modifiedTime,createdTime,size,webViewLink,owners(displayName,emailAddress))',
                    supportsAllDrives: true,
                    includeItemsFromAllDrives: true,
                });

                const files = (response.data.files || []).map((file) => ({
                    id: file.id,
                    name: file.name,
                    mimeType: file.mimeType,
                    modifiedTime: file.modifiedTime,
                    owner: file.owners?.[0]?.displayName || null,
                    url: file.webViewLink,
                }));

                return JSON.stringify({ files }, null, 2);
            } catch (error) {
                log.error(`Error listing Drive files: ${error.message || error}`);
                if (error.code === 403)
                    throw new UserError(
                        'Permission denied. Make sure you have granted Google Drive access to the application.'
                    );
                throw new UserError(
                    `Failed to list files: ${error.message || 'Unknown error'}`
                );
            }
        },
    });
}
