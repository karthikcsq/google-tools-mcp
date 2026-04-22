import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'updateRevision',
        description: 'Updates metadata for a specific revision of a Drive file. Use this to pin a revision so it is kept forever (never auto-deleted by Drive), or to control publishing settings for Google Docs/Slides.',
        parameters: z.object({
            fileId: z.string().describe('The ID of the Drive file.'),
            revisionId: z.string().describe('The revision ID to update (from listRevisions).'),
            keepForever: z.boolean().optional().describe('If true, this revision is kept indefinitely and will not be automatically deleted. Only applies to files with a binary content type; Google Docs revisions are always kept.'),
            published: z.boolean().optional().describe('Whether this revision is published. Only applies to Google Docs and Slides.'),
            publishAuto: z.boolean().optional().describe('Whether subsequent revisions are automatically republished. Only applies to Google Docs and Slides.'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Updating revision ${args.revisionId} for file: ${args.fileId}`);
            const body = {};
            if (args.keepForever !== undefined) body.keepForever = args.keepForever;
            if (args.published !== undefined) body.published = args.published;
            if (args.publishAuto !== undefined) body.publishAuto = args.publishAuto;
            if (Object.keys(body).length === 0) {
                throw new UserError('No fields to update. Provide at least one of: keepForever, published, publishAuto.');
            }
            try {
                const response = await drive.revisions.update({
                    fileId: args.fileId,
                    revisionId: args.revisionId,
                    fields: 'id,keepForever,published,publishAuto,modifiedTime',
                    requestBody: body,
                });
                const r = response.data;
                return JSON.stringify({
                    revisionId: r.id,
                    modifiedTime: r.modifiedTime,
                    keepForever: r.keepForever || false,
                    published: r.published || false,
                    publishAuto: r.publishAuto || false,
                }, null, 2);
            }
            catch (error) {
                log.error(`Error updating revision: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError(`File or revision not found (fileId: ${args.fileId}, revisionId: ${args.revisionId}).`);
                if (error.code === 403)
                    throw new UserError('Permission denied. You need edit access to update revisions.');
                throw new UserError(`Failed to update revision: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
