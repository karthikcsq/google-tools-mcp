import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'getRevision',
        description: 'Gets details about a specific revision of a Drive file, including who made it, when, and an optional temporary download link to retrieve the content at that point in time.',
        parameters: z.object({
            fileId: z.string().describe('The ID of the Drive file.'),
            revisionId: z.string().describe('The revision ID (from listRevisions).'),
            includeDownloadLink: z.boolean().optional().default(false).describe('If true, includes a short-lived download URL for the revision content.'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Getting revision ${args.revisionId} for file: ${args.fileId}`);
            try {
                const fields = [
                    'id', 'modifiedTime', 'lastModifyingUser(displayName,emailAddress)',
                    'keepForever', 'published', 'publishedOutsideDomain', 'publishAuto',
                    'mimeType', 'size',
                    ...(args.includeDownloadLink ? ['exportLinks', 'downloadUrl'] : []),
                ].join(',');
                const response = await drive.revisions.get({
                    fileId: args.fileId,
                    revisionId: args.revisionId,
                    fields,
                });
                const r = response.data;
                const result = {
                    revisionId: r.id,
                    modifiedTime: r.modifiedTime,
                    modifiedBy: r.lastModifyingUser?.displayName || null,
                    modifiedByEmail: r.lastModifyingUser?.emailAddress || null,
                    mimeType: r.mimeType,
                    sizeBytes: r.size ? parseInt(r.size, 10) : null,
                    keepForever: r.keepForever || false,
                    published: r.published || false,
                    publishedOutsideDomain: r.publishedOutsideDomain || false,
                    publishAuto: r.publishAuto || false,
                    ...(args.includeDownloadLink ? {
                        downloadUrl: r.downloadUrl || null,
                        exportLinks: r.exportLinks || null,
                    } : {}),
                };
                return JSON.stringify(result, null, 2);
            }
            catch (error) {
                log.error(`Error getting revision: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError(`File or revision not found (fileId: ${args.fileId}, revisionId: ${args.revisionId}).`);
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have access to this file.');
                throw new UserError(`Failed to get revision: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
