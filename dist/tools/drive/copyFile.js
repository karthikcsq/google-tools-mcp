import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient, getDocsClient } from '../../clients.js';
import { docsJsonToMarkdown } from '../../markdown-transformer/index.js';
import { trackRead } from '../../readTracker.js';
import { mintDocsReadHandle } from '../../docsHandles.js';

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
                    // Sheets reads intentionally record no content or revision,
                    // so a copied Sheet must use that same honest baseline.
                    try {
                        trackRead(copiedFile.id);
                    }
                    catch (seedError) {
                        log.warn(`Copied Google Sheet ${copiedFile.id} but read state could not be seeded: ${seedError.message}`);
                        readStateWarning = 'The Google Sheet copy was created, but its read state could not be seeded. Call readSpreadsheet before the next mutation.';
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
                        readHandleNote: 'This document copy has been seeded as read. You can mutate it immediately without calling readDocument first.',
                    }),
                    ...(readStateWarning && { warnings: [readStateWarning] }),
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
