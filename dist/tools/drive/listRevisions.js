import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'listRevisions',
        description: 'Lists all saved versions (revision history) of a Drive file such as a Google Doc, Sheet, or Slide. Returns each revision\'s ID, modifier, timestamp, and whether it is kept forever.',
        parameters: z.object({
            fileId: z.string().describe('The ID of the Drive file to list revisions for.'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Listing revisions for file: ${args.fileId}`);
            try {
                const revisions = [];
                let pageToken;
                do {
                    const response = await drive.revisions.list({
                        fileId: args.fileId,
                        fields: 'nextPageToken,revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress),keepForever,published,size)',
                        pageSize: 200,
                        ...(pageToken ? { pageToken } : {}),
                    });
                    const page = response.data.revisions || [];
                    revisions.push(...page);
                    pageToken = response.data.nextPageToken;
                } while (pageToken);
                const result = revisions.map((r, i) => ({
                    revisionId: r.id,
                    index: i + 1,
                    modifiedTime: r.modifiedTime,
                    modifiedBy: r.lastModifyingUser?.displayName || null,
                    modifiedByEmail: r.lastModifyingUser?.emailAddress || null,
                    keepForever: r.keepForever || false,
                    published: r.published || false,
                    sizeBytes: r.size ? parseInt(r.size, 10) : null,
                }));
                return JSON.stringify({ total: result.length, revisions: result }, null, 2);
            }
            catch (error) {
                log.error(`Error listing revisions: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError(`File not found (ID: ${args.fileId}).`);
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have access to this file.');
                throw new UserError(`Failed to list revisions: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
