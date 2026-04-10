import * as fs from 'fs';
import * as path from 'path';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';

// Common MIME type mappings for file extensions
const MIME_TYPES = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.md': 'text/markdown',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.tar': 'application/x-tar',
};

export function register(server) {
    server.addTool({
        name: 'uploadFile',
        description:
            'Uploads a local file from the filesystem to Google Drive. ' +
            'Auto-detects MIME type from file extension. ' +
            'Returns the uploaded file\'s Drive ID and URL.',
        parameters: z.object({
            localPath: z.string().describe('Absolute path to the local file to upload.'),
            name: z
                .string()
                .optional()
                .describe('Custom name for the file in Drive. If not provided, uses the local filename.'),
            parentFolderId: z
                .string()
                .optional()
                .describe('ID of the Drive folder to upload into. If not provided, uploads to the root of My Drive.'),
            mimeType: z
                .string()
                .optional()
                .describe('MIME type override. If not provided, auto-detected from file extension.'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();

            // Validate file exists
            if (!fs.existsSync(args.localPath)) {
                throw new UserError(`File not found: ${args.localPath}`);
            }

            const stats = fs.statSync(args.localPath);
            if (!stats.isFile()) {
                throw new UserError(`Path is not a file: ${args.localPath}`);
            }

            const fileName = args.name || path.basename(args.localPath);
            const ext = path.extname(args.localPath).toLowerCase();
            const mimeType = args.mimeType || MIME_TYPES[ext] || 'application/octet-stream';

            log.info(`Uploading "${args.localPath}" as "${fileName}" (${mimeType}, ${stats.size} bytes)`);

            try {
                const fileMetadata = { name: fileName };
                if (args.parentFolderId) {
                    fileMetadata.parents = [args.parentFolderId];
                }

                const response = await drive.files.create({
                    requestBody: fileMetadata,
                    media: {
                        mimeType,
                        body: fs.createReadStream(args.localPath),
                    },
                    fields: 'id,name,webViewLink,mimeType,size',
                    supportsAllDrives: true,
                });

                const file = response.data;
                return JSON.stringify({
                    id: file.id,
                    name: file.name,
                    url: file.webViewLink,
                    mimeType: file.mimeType,
                    size: file.size,
                }, null, 2);
            } catch (error) {
                log.error(`Error uploading file: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError('Destination folder not found. Check the parentFolderId.');
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have write access to the destination folder.');
                throw new UserError(`Failed to upload file: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
