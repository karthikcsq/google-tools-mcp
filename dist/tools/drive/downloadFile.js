import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

// Google Workspace MIME types and their export formats
const EXPORT_FORMATS = {
    'application/vnd.google-apps.document': {
        label: 'Google Doc',
        formats: {
            pdf: 'application/pdf',
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            md: 'text/markdown',
            txt: 'text/plain',
            html: 'text/html',
            rtf: 'application/rtf',
            odt: 'application/vnd.oasis.opendocument.text',
            epub: 'application/epub+zip',
        },
        defaultFormat: 'pdf',
        extensions: {
            pdf: '.pdf',
            docx: '.docx',
            md: '.md',
            txt: '.txt',
            html: '.html',
            rtf: '.rtf',
            odt: '.odt',
            epub: '.epub',
        },
    },
    'application/vnd.google-apps.spreadsheet': {
        label: 'Google Sheet',
        formats: {
            pdf: 'application/pdf',
            xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            csv: 'text/csv',
            tsv: 'text/tab-separated-values',
            ods: 'application/vnd.oasis.opendocument.spreadsheet',
        },
        defaultFormat: 'xlsx',
        extensions: {
            pdf: '.pdf',
            xlsx: '.xlsx',
            csv: '.csv',
            tsv: '.tsv',
            ods: '.ods',
        },
    },
    'application/vnd.google-apps.presentation': {
        label: 'Google Slides',
        formats: {
            pdf: 'application/pdf',
            pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            odp: 'application/vnd.oasis.opendocument.presentation',
            txt: 'text/plain',
        },
        defaultFormat: 'pdf',
        extensions: {
            pdf: '.pdf',
            pptx: '.pptx',
            odp: '.odp',
            txt: '.txt',
        },
    },
    'application/vnd.google-apps.drawing': {
        label: 'Google Drawing',
        formats: {
            pdf: 'application/pdf',
            png: 'image/png',
            jpg: 'image/jpeg',
            svg: 'image/svg+xml',
        },
        defaultFormat: 'pdf',
        extensions: {
            pdf: '.pdf',
            png: '.png',
            jpg: '.jpg',
            svg: '.svg',
        },
    },
};

// All supported export format keys
const ALL_FORMAT_KEYS = [
    ...new Set(
        Object.values(EXPORT_FORMATS).flatMap((t) => Object.keys(t.formats))
    ),
];

export function register(server) {
    server.addTool({
        name: 'downloadFile',
        description:
            'Downloads a file from Google Drive to the local filesystem. ' +
            'For Google Workspace files (Docs, Sheets, Slides, Drawings), specify an export format ' +
            '(e.g. pdf, docx, md, xlsx, csv, pptx). For regular files (images, PDFs, etc.), ' +
            'downloads the original file directly.',
        parameters: z.object({
            fileId: z.string().describe('The ID of the file to download.'),
            localPath: z
                .string()
                .describe(
                    'The local file path to save the downloaded file to. ' +
                    'Can be an absolute path or relative to the current working directory. ' +
                    'If a directory is provided, the file will be saved with its Drive name.'
                ),
            exportFormat: z
                .enum(ALL_FORMAT_KEYS)
                .optional()
                .describe(
                    'Export format for Google Workspace files. ' +
                    'Docs: pdf, docx, md, txt, html, rtf, odt, epub. ' +
                    'Sheets: pdf, xlsx, csv, tsv, ods. ' +
                    'Slides: pdf, pptx, odp, txt. ' +
                    'Drawings: pdf, png, jpg, svg. ' +
                    'Ignored for non-Google files (they download as-is).'
                ),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Downloading file: ${args.fileId}`);

            try {
                // Get file metadata first
                const metaResponse = await drive.files.get({
                    fileId: args.fileId,
                    fields: 'id,name,mimeType,size',
                    supportsAllDrives: true,
                });
                const file = metaResponse.data;
                if (!file) {
                    throw new UserError(
                        `File with ID ${args.fileId} not found.`
                    );
                }

                const isGoogleWorkspace =
                    file.mimeType in EXPORT_FORMATS;

                // Determine export MIME type and file extension
                let exportMimeType = null;
                let fileExtension = '';

                if (isGoogleWorkspace) {
                    const typeInfo = EXPORT_FORMATS[file.mimeType];
                    const format =
                        args.exportFormat || typeInfo.defaultFormat;

                    if (!typeInfo.formats[format]) {
                        const available = Object.keys(
                            typeInfo.formats
                        ).join(', ');
                        throw new UserError(
                            `Format '${format}' is not supported for ${typeInfo.label}. ` +
                            `Available formats: ${available}`
                        );
                    }

                    exportMimeType = typeInfo.formats[format];
                    fileExtension = typeInfo.extensions[format];
                }

                // Resolve the local path
                let destPath = path.resolve(args.localPath);

                // Check if destPath is a directory
                let isDir = false;
                try {
                    const stat = await fs.stat(destPath);
                    isDir = stat.isDirectory();
                } catch {
                    // Path doesn't exist yet — treat as a file path
                }

                if (isDir) {
                    // Build filename from Drive name + appropriate extension
                    let fileName = file.name;
                    if (isGoogleWorkspace && fileExtension) {
                        // Google Workspace files don't have extensions in their name
                        fileName = file.name + fileExtension;
                    }
                    destPath = path.join(destPath, fileName);
                } else if (
                    isGoogleWorkspace &&
                    fileExtension &&
                    !destPath.endsWith(fileExtension)
                ) {
                    // Append extension if not already present
                    destPath = destPath + fileExtension;
                }

                // Ensure parent directory exists
                await fs.mkdir(path.dirname(destPath), { recursive: true });

                // Download the file
                if (isGoogleWorkspace) {
                    log.info(
                        `Exporting ${EXPORT_FORMATS[file.mimeType].label} as ${args.exportFormat || EXPORT_FORMATS[file.mimeType].defaultFormat}`
                    );
                    const exportResponse = await drive.files.export(
                        { fileId: args.fileId, mimeType: exportMimeType },
                        { responseType: 'stream' }
                    );
                    await pipeline(
                        exportResponse.data,
                        createWriteStream(destPath)
                    );
                } else {
                    log.info(`Downloading binary file: ${file.name}`);
                    const downloadResponse = await drive.files.get(
                        {
                            fileId: args.fileId,
                            alt: 'media',
                            supportsAllDrives: true,
                        },
                        { responseType: 'stream' }
                    );
                    await pipeline(
                        downloadResponse.data,
                        createWriteStream(destPath)
                    );
                }

                // Get the final file size
                const stat = await fs.stat(destPath);

                const result = {
                    success: true,
                    fileName: file.name,
                    savedTo: destPath,
                    fileSize: stat.size,
                    mimeType: isGoogleWorkspace
                        ? exportMimeType
                        : file.mimeType,
                };

                if (isGoogleWorkspace) {
                    result.exportedAs =
                        args.exportFormat ||
                        EXPORT_FORMATS[file.mimeType].defaultFormat;
                }

                return JSON.stringify(result, null, 2);
            } catch (error) {
                if (error instanceof UserError) throw error;
                log.error(
                    `Error downloading file: ${error.message || error}`
                );
                if (error.code === 404)
                    throw new UserError(
                        `File not found (ID: ${args.fileId}).`
                    );
                if (error.code === 403)
                    throw new UserError(
                        'Permission denied. Make sure you have access to this file.'
                    );
                throw new UserError(
                    `Failed to download file: ${error.message || 'Unknown error'}`
                );
            }
        },
    });
}
