import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
import { isDocx, isPdf, downloadBuffer, extractText } from './readFile.js';

export function register(server) {
    server.addTool({
        name: 'searchFileContents',
        description:
            'Search Google Drive for files whose content or name matches a query. ' +
            'For .docx and .pdf files, extracts and returns matching text snippets. ' +
            'Use this to find information inside Office documents and PDFs.',
        parameters: z.object({
            query: z.string().describe('Text to search for'),
            maxResults: z
                .number()
                .optional()
                .default(5)
                .describe('Max number of files to search (default 5)'),
            folderId: z
                .string()
                .optional()
                .describe('Restrict search to a specific folder ID'),
        }),
        execute: async ({ query, maxResults = 5, folderId }, { log }) => {
            const drive = await getDriveClient();
            log.info(`Searching file contents for: "${query}"`);

            try {
                const escaped = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                let q = `fullText contains '${escaped}' and trashed = false`;
                if (folderId) q += ` and '${folderId}' in parents`;

                const response = await drive.files.list({
                    q,
                    pageSize: maxResults,
                    fields: 'files(id,name,mimeType)',
                    supportsAllDrives: true,
                    includeItemsFromAllDrives: true,
                });

                const files = response.data.files || [];
                if (files.length === 0) return 'No files found matching that query.';

                const results = [];

                for (const file of files) {
                    const canRead = isDocx(file.mimeType, file.name) || isPdf(file.mimeType, file.name);

                    if (canRead) {
                        try {
                            const buffer = await downloadBuffer(drive, file.id);
                            const text = await extractText(buffer, file.mimeType, file.name);

                            const lowerText = text.toLowerCase();
                            const lowerQuery = query.toLowerCase();
                            const idx = lowerText.indexOf(lowerQuery);
                            const snippet =
                                idx !== -1
                                    ? '...' + text.slice(Math.max(0, idx - 150), idx + 300).trim() + '...'
                                    : text.slice(0, 400).trim() + '...';

                            results.push(`**${file.name}** (ID: \`${file.id}\`)\n\n${snippet}`);
                        } catch (e) {
                            results.push(`**${file.name}** (ID: \`${file.id}\`)\n\n[Could not read: ${e.message}]`);
                        }
                    } else {
                        results.push(`**${file.name}** (ID: \`${file.id}\`, type: ${file.mimeType})`);
                    }
                }

                return results.join('\n\n---\n\n');
            } catch (error) {
                log.error(`Error searching files: ${error.message}`);
                if (error.code === 403)
                    throw new UserError('Permission denied. Check Drive access.');
                throw new UserError(`Failed to search files: ${error.message}`);
            }
        },
    });
}
