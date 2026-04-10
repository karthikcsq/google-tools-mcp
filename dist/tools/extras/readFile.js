import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
import { trackRead } from '../../readTracker.js';
import mammoth from 'mammoth';

function isDocx(mimeType, name) {
    return (
        mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        (name && name.endsWith('.docx'))
    );
}

function isPdf(mimeType, name) {
    return mimeType === 'application/pdf' || (name && name.endsWith('.pdf'));
}

async function downloadBuffer(drive, fileId) {
    const response = await drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' }
    );
    return Buffer.from(response.data);
}

export async function extractText(buffer, mimeType, name) {
    if (isDocx(mimeType, name)) {
        const result = await mammoth.extractRawText({ buffer });
        return result.value;
    }
    if (isPdf(mimeType, name)) {
        const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
        const result = await pdfParse(buffer);
        return result.text;
    }
    return null;
}

export { isDocx, isPdf, downloadBuffer };

export function register(server) {
    server.addTool({
        name: 'readFile',
        description:
            'Read the full text content of a .docx or .pdf file from Google Drive by file ID. ' +
            'Use this for Word documents and PDFs that cannot be read with readDocument.',
        parameters: z.object({
            fileId: z.string().describe('The Google Drive file ID'),
        }),
        execute: async ({ fileId }, { log }) => {
            const drive = await getDriveClient();
            log.info(`Reading file ${fileId}`);

            try {
                const meta = await drive.files.get({
                    fileId,
                    fields: 'name,mimeType',
                    supportsAllDrives: true,
                });

                const { name, mimeType } = meta.data;
                trackRead(fileId);
                const buffer = await downloadBuffer(drive, fileId);
                const text = await extractText(buffer, mimeType, name);

                if (text === null) {
                    throw new UserError(
                        `Unsupported file type: ${mimeType} (${name}). Only .docx and .pdf are supported.`
                    );
                }

                return `# ${name}\n\n${text}`;
            } catch (error) {
                if (error instanceof UserError) throw error;
                log.error(`Error reading file: ${error.message}`);
                if (error.code === 404)
                    throw new UserError(`File not found: ${fileId}`);
                if (error.code === 403)
                    throw new UserError('Permission denied. Check that the file is shared with this account.');
                throw new UserError(`Failed to read file: ${error.message}`);
            }
        },
    });
}
