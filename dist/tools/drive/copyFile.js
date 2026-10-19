import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient, getDocsClient, getSheetsClient } from '../../clients.js';
import { docsJsonToMarkdown } from '../../markdown-transformer/index.js';
import { trackRead } from '../../readTracker.js';
import { mintDocsReadHandle } from '../../docsHandles.js';
import { mintSheetsReadHandle, readSheetsValueBaseline } from '../../resourceHandles.js';
import { setResultResourceState } from '../../handleRuntime.js';

const GOOGLE_DOC_MIME_TYPE = 'application/vnd.google-apps.document';
const GOOGLE_SHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet';
export function register(server) {
    server.addTool({
        name: 'copyFile',
        description: "Creates a copy of a file or document in Google Drive. Returns the new copy's ID and URL.",
        parameters: z.object({
            fileId: z
                .string()
                .describe('The file or folder ID from a Google Drive URL or a previous tool result.'),
            name: z
                .string()
                .optional()
                .describe('Name for the copied file (matches the Drive API\'s own "name" field). If not provided, will use "Copy of [original name]".'),
            newName: z
                .string()
                .optional()
                .describe('Deprecated alias for "name", kept for backward compatibility. If both are given, "name" wins.'),
            parentFolderId: z
                .string()
                .optional()
                .describe('ID of folder where copy should be placed. If not provided, places in same location as original.'),
        })
            // Reject unrecognized parameters instead of the Zod default of
            // silently stripping them — an unsupported argument (issue #124:
            // a caller sent `name` back when the schema only accepted
            // `newName`) must surface as a validation error, not vanish with
            // no signal that it was dropped.
            .strict(),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            const requestedName = args.name ?? args.newName;
            log.info(`Copying file ${args.fileId} ${requestedName ? `as "${requestedName}"` : ''}`);
            try {
                // Get original file info
                const originalFile = await drive.files.get({
                    fileId: args.fileId,
                    fields: 'name,parents',
                    supportsAllDrives: true,
                });
                const copyMetadata = {
                    name: requestedName || `Copy of ${originalFile.data.name}`,
                };
                if (args.parentFolderId) {
                    copyMetadata.parents = [args.parentFolderId];
                }
                else if (originalFile.data.parents) {
                    copyMetadata.parents = originalFile.data.parents;
                }
                const response = await drive.files.copy({
                    fileId: args.fileId,
                    requestBody: copyMetadata,
                    fields: 'id,name,webViewLink,mimeType,modifiedTime',
                    supportsAllDrives: true,
                });
                const copiedFile = response.data;
                let readHandle;
                let readStateWarning;
                let observedRanges;
                if (copiedFile.mimeType === GOOGLE_DOC_MIME_TYPE) {
                    // A Docs mutation needs the exact content and revision it
                    // is based on. Fetch the copied document rather than
                    // treating the source copy operation as a content read.
                    try {
                        const docs = await getDocsClient();
                        const seedRes = await docs.documents.get({ documentId: copiedFile.id, fields: '*' });
                        const contentSource = seedRes.data;
                        const markdownContent = docsJsonToMarkdown(contentSource);
                        trackRead(copiedFile.id, copiedFile.modifiedTime, markdownContent, seedRes.data.revisionId);
                        const minted = await mintDocsReadHandle({
                            documentId: copiedFile.id,
                            tabId: null,
                            revisionId: seedRes.data.revisionId ?? null,
                            contentSource,
                            content: markdownContent,
                        });
                        readHandle = minted?.readHandle;
                    }
                    catch (seedError) {
                        // The Drive copy already succeeded. Do not turn a
                        // failed post-copy read into an orphaned file; leave
                        // it unseeded so the next mutation fails closed.
                        log.warn(`Copied Google Doc ${copiedFile.id} but read state could not be seeded: ${seedError.message}`);
                        readStateWarning = 'The Google Doc copy was created, but its read state could not be seeded. Call readDocument before the next mutation.';
                    }
                }
                else if (copiedFile.mimeType === GOOGLE_SHEET_MIME_TYPE) {
                    // A copied spreadsheet has no trusted value snapshot until
                    // it is read back with Drive version, formulas and sheet
                    // identity. A failed baseline stays explicitly unread.
                    try {
                        const sheets = await getSheetsClient();
                        const baseline = await readSheetsValueBaseline({
                            drive, sheets, spreadsheetId: copiedFile.id, ranges: ['A1'],
                        });
                        trackRead(copiedFile.id);
                        const minted = await mintSheetsReadHandle(copiedFile.id, baseline);
                        readHandle = minted?.readHandle;
                        observedRanges = baseline.displayRanges;
                        setResultResourceState({ kind: 'sheets-values-v1', ranges: observedRanges });
                    }
                    catch (seedError) {
                        log.warn(`Copied Google Sheet ${copiedFile.id} but a verified read baseline could not be captured.`, seedError);
                        readStateWarning = 'The Google Sheet copy was created, but its read baseline could not be captured. Call readSpreadsheet before the next mutation.';
                    }
                }
                // Arbitrary binary copies deliberately stay unseeded. Some
                // generic mutations (for example deleteFile) are guarded, but
                // copyFile has no content snapshot for a binary destination;
                // claiming a read here would silently weaken that guard.
                return JSON.stringify({
                    id: copiedFile.id,
                    name: copiedFile.name,
                    url: copiedFile.webViewLink,
                    ...(readHandle && {
                        readHandleNote: copiedFile.mimeType === GOOGLE_SHEET_MIME_TYPE
                            ? 'This spreadsheet copy was read after copying. The returned readHandle authorizes only its captured bounded range.'
                            : 'This document copy has been seeded as read. You can mutate it immediately without calling readDocument first.',
                    }),
                    ...(readStateWarning && { warnings: [readStateWarning] }),
                    ...(observedRanges ? { observedRanges } : {}),
                }, null, 2);
            }
            catch (error) {
                if (isPublicError(error)) throw error;
                log.error(`Error copying file: ${error.message || error}`);
                if (error.code === 404)
                    throw publicError('Original file or destination folder not found. Check the IDs.');
                if (error.code === 403)
                    throw publicError('Permission denied. Make sure you have read access to the original file and write access to the destination.');
throw wrapOperationError('copy file', error, { status: error?.code });
            }
        },
    });
}
