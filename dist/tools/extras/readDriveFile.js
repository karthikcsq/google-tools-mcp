import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient, getDocsClient, getSheetsClient } from '../../clients.js';
import { docsJsonToMarkdown } from '../../markdown-transformer/index.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import { extractText, downloadBuffer } from './readFile.js';
import { trackRead } from '../../readTracker.js';

// Google-native MIME types
const GOOGLE_DOC = 'application/vnd.google-apps.document';
const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_SLIDES = 'application/vnd.google-apps.presentation';

// Capabilities by file type category
const CAPABILITIES = {
    googleDoc: {
        fileType: 'Google Doc',
        capabilities: ['read', 'readDocument', 'modifyText', 'replaceDocumentWithMarkdown', 'appendMarkdown', 'appendText', 'findAndReplace', 'deleteRange'],
    },
    googleSheet: {
        fileType: 'Google Sheet',
        capabilities: ['read', 'readSpreadsheet', 'writeSpreadsheet', 'appendRows', 'formatCells'],
    },
    docx: {
        fileType: 'Word Document (.docx)',
        capabilities: ['read'],
        note: 'This is a Word document. Editing tools (modifyText, appendMarkdown, etc.) are not available unless converted to a Google Doc via copyFile or Drive UI.',
    },
    pdf: {
        fileType: 'PDF',
        capabilities: ['read'],
        note: 'This is a PDF file. Editing tools are not available. Convert to a Google Doc first if editing is needed.',
    },
    other: {
        fileType: 'Unknown',
        capabilities: ['download'],
        note: 'This file type cannot be read as text. Use downloadFile to download it.',
    },
};

export function register(server) {
    server.addTool({
        name: 'readDriveFile',
        description:
            'Unified read tool: accepts any Google Drive file ID, auto-detects the file type (Google Doc, Sheet, Word .docx, PDF), ' +
            'and routes to the appropriate reader. Returns content along with metadata about available capabilities. ' +
            'Use this when you have a file ID but don\'t know the file type, or when readDocument fails with a 400 error.',
        parameters: z.object({
            fileId: z
                .string()
                .describe('The Google Drive file ID (the long string between /d/ and /edit in a Drive URL).'),
            format: z
                .enum(['text', 'json', 'markdown'])
                .optional()
                .default('markdown')
                .describe("Output format for Google Docs: 'markdown' (default), 'text' (plain text), 'json' (raw structure). Ignored for non-Doc files."),
            range: z
                .string()
                .optional()
                .describe("A1 notation range for Google Sheets (e.g., 'Sheet1!A1:C10'). Required for spreadsheets."),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();

            // 1. Get file metadata to determine type
            let fileMeta;
            try {
                const res = await drive.files.get({
                    fileId: args.fileId,
                    fields: 'id,name,mimeType,modifiedTime,size',
                    supportsAllDrives: true,
                });
                fileMeta = res.data;
            } catch (error) {
                if (error.code === 404) throw new UserError(`File not found: ${args.fileId}`);
                if (error.code === 403) throw new UserError('Permission denied. Check that the file is shared with this account.');
                throw new UserError(`Failed to get file info: ${error.message}`);
            }

            log.info(`File "${fileMeta.name}" is ${fileMeta.mimeType}`);
            trackRead(args.fileId, fileMeta.modifiedTime);

            // 2. Route based on MIME type
            if (fileMeta.mimeType === GOOGLE_DOC) {
                return await readGoogleDoc(args, fileMeta, log);
            }

            if (fileMeta.mimeType === GOOGLE_SHEET) {
                return await readGoogleSheet(args, fileMeta, log);
            }

            // Try reading as docx/pdf
            const text = await tryReadBinaryFile(drive, args.fileId, fileMeta, log);
            if (text !== null) {
                return text;
            }

            // Unsupported type
            const capInfo = CAPABILITIES.other;
            capInfo.fileType = fileMeta.mimeType;
            return JSON.stringify({
                file: { id: fileMeta.id, name: fileMeta.name, mimeType: fileMeta.mimeType },
                ...capInfo,
                content: null,
            }, null, 2);
        },
    });
}

async function readGoogleDoc(args, fileMeta, log) {
    const docs = await getDocsClient();
    const res = await docs.documents.get({
        documentId: args.fileId,
        fields: args.format === 'text' ? 'body(content(paragraph(elements(textRun(content)))))' : '*',
    });

    let content;
    if (args.format === 'json') {
        content = JSON.stringify(res.data, null, 2);
    } else if (args.format === 'markdown') {
        content = docsJsonToMarkdown(res.data);
    } else {
        // text
        let textContent = '';
        res.data.body?.content?.forEach((element) => {
            if (element.paragraph?.elements) {
                element.paragraph.elements.forEach((pe) => {
                    if (pe.textRun?.content) textContent += pe.textRun.content;
                });
            }
            if (element.table?.tableRows) {
                element.table.tableRows.forEach((row) => {
                    row.tableCells?.forEach((cell) => {
                        cell.content?.forEach((cellElement) => {
                            cellElement.paragraph?.elements?.forEach((pe) => {
                                if (pe.textRun?.content) textContent += pe.textRun.content;
                            });
                        });
                    });
                });
            }
        });
        content = textContent || '(empty document)';
    }

    return JSON.stringify({
        file: { id: fileMeta.id, name: fileMeta.name, mimeType: fileMeta.mimeType },
        ...CAPABILITIES.googleDoc,
        content,
    }, null, 2);
}

async function readGoogleSheet(args, fileMeta, log) {
    if (!args.range) {
        // Return sheet info without data
        const sheets = await getSheetsClient();
        const info = await sheets.spreadsheets.get({
            spreadsheetId: args.fileId,
            fields: 'sheets(properties(sheetId,title,gridProperties))',
        });
        const sheetList = info.data.sheets?.map(s => ({
            title: s.properties.title,
            sheetId: s.properties.sheetId,
            rows: s.properties.gridProperties?.rowCount,
            cols: s.properties.gridProperties?.columnCount,
        }));
        return JSON.stringify({
            file: { id: fileMeta.id, name: fileMeta.name, mimeType: fileMeta.mimeType },
            ...CAPABILITIES.googleSheet,
            note: 'Provide a range parameter (e.g., "Sheet1!A1:C10") to read data. Available sheets listed below.',
            sheets: sheetList,
        }, null, 2);
    }

    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: args.fileId,
        range: args.range,
    });
    return JSON.stringify({
        file: { id: fileMeta.id, name: fileMeta.name, mimeType: fileMeta.mimeType },
        ...CAPABILITIES.googleSheet,
        range: args.range,
        values: response.data.values || [],
    }, null, 2);
}

async function tryReadBinaryFile(drive, fileId, fileMeta, log) {
    const { mimeType, name } = fileMeta;
    const isDocxFile = mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || name?.endsWith('.docx');
    const isPdfFile = mimeType === 'application/pdf' || name?.endsWith('.pdf');

    if (!isDocxFile && !isPdfFile) return null;

    const buffer = await downloadBuffer(drive, fileId);
    const text = await extractText(buffer, mimeType, name);

    if (text === null) return null;

    const capInfo = isDocxFile ? CAPABILITIES.docx : CAPABILITIES.pdf;
    return JSON.stringify({
        file: { id: fileMeta.id, name: fileMeta.name, mimeType: fileMeta.mimeType },
        ...capInfo,
        content: text,
    }, null, 2);
}
