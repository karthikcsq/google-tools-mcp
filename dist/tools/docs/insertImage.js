import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDocsClient, getDriveClient, getScriptClient } from '../../clients.js';
import { DocumentIdParameter } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import { ReadHandleParameter, beginDocsMutation } from '../../docsHandles.js';
export function register(server) {
    server.addTool({
        name: 'insertImage',
        description: 'Inserts an inline image into a Google Document. Provide either a publicly accessible URL or a local file path. Local files are automatically uploaded to Google Drive before insertion.',
        parameters: DocumentIdParameter.extend({
            imageUrl: z
                .string()
                .url()
                .optional()
                .describe('Publicly accessible URL to the image (http:// or https://).'),
            localImagePath: z
                .string()
                .optional()
                .describe('Absolute path to a local image file (supports .jpg, .jpeg, .png, .gif, .bmp, .webp, .svg). The file will be uploaded to Google Drive.'),
            index: z
                .number()
                .int()
                .min(1)
                .describe("1-based character index in the document body where the image should be inserted. Use readDocument with format='json' to inspect indices."),
            width: z.number().min(1).optional().describe('Width of the image in points.'),
            height: z.number().min(1).optional().describe('Height of the image in points.'),
            tabId: z
                .string()
                .optional()
                .describe('The ID of the specific tab to insert into. Use listDocumentTabs to get tab IDs. If not specified, inserts into the first tab.'),
            readHandle: ReadHandleParameter,
        })
            .refine((data) => data.imageUrl || data.localImagePath, {
            message: 'Either imageUrl or localImagePath must be provided.',
        })
            .refine((data) => !(data.imageUrl && data.localImagePath), {
            message: 'Provide only one of imageUrl or localImagePath, not both.',
        }),
        execute: async (args, { log }) => {
            const docs = await getDocsClient();
            const appsScriptDeploymentId = process.env.APPS_SCRIPT_DEPLOYMENT_ID;
            try {
                if (args.tabId) {
                    const docInfo = await docs.documents.get({
                        documentId: args.documentId,
                        includeTabsContent: true,
                        fields: 'tabs(tabProperties,documentTab)',
                    });
                    const targetTab = GDocsHelpers.findTabById(docInfo.data, args.tabId);
                    if (!targetTab) {
                        throw publicError(`Tab with ID "${args.tabId}" not found in document.`);
                    }
                    if (!targetTab.documentTab) {
                        throw publicError(`Tab "${args.tabId}" does not have content (may not be a document tab).`);
                    }
                }
                // --- Apps Script path: local files when APPS_SCRIPT_DEPLOYMENT_ID is set ---
                if (args.localImagePath && appsScriptDeploymentId) {
                    const drive = await getDriveClient();
                    const scriptClient = await getScriptClient();
                    log.info(`[AppsScript] Uploading ${args.localImagePath} to Drive (no public sharing)`);
                    let parentFolderId;
                    try {
                        const docInfo = await drive.files.get({
                            fileId: args.documentId,
                            fields: 'parents',
                            supportsAllDrives: true,
                        });
                        if (docInfo.data.parents && docInfo.data.parents.length > 0) {
                            parentFolderId = docInfo.data.parents[0];
                        }
                    }
                    catch (folderError) {
                        log.warn(`Could not determine document's parent folder, using Drive root: ${folderError}`);
                    }
                    // Acquire the lease BEFORE any Drive upload: a rejected mutation
                    // (unauthorized/never-read document, expired handle, etc.) must
                    // never leave a file behind in the user's Drive (#87 gap).
                    const appsScriptLease = await beginDocsMutation(args.documentId, {
                        tabId: args.tabId ?? null,
                        readHandle: args.readHandle,
                    });
                    let driveFileId;
                    try {
                        driveFileId = await GDocsHelpers.uploadImageToDrive(drive, args.localImagePath, parentFolderId, true // skipPublicSharing
                        );
                    }
                    catch (uploadError) {
                        // Nothing was written to the document, so this is not a
                        // failed mutation — fail() would terminalize the handle
                        // as INVALID. abort() returns the record to active so a
                        // corrected retry can reuse the same handle.
                        await appsScriptLease.abort();
                        throw uploadError;
                    }
                    log.info(`[AppsScript] Inserting image via marker at index ${args.index} (fileId: ${driveFileId})`);
                    try {
                        await GDocsHelpers.insertImageViaAppsScript(docs, scriptClient, appsScriptDeploymentId, args.documentId, driveFileId, args.index, args.tabId, appsScriptLease.writeControlFor());
                    }
                    catch (appsScriptError) {
                        // The upload already succeeded at this point; existing
                        // behavior is to leave the uploaded Drive file in place
                        // (no delete-on-write-failure cleanup exists for this tool)
                        // and only release the lease.
                        await appsScriptLease.fail();
                        throw appsScriptError;
                    }
                    // The Apps Script call that replaces the marker with the image mutates
                    // the document outside our batchUpdate visibility, so we have no way to
                    // learn the true post-write revision here. trackMutation would clear the
                    // revision and the modifiedTime, which leaves the next write with nothing
                    // to check against and sends it out unguarded on a pre-image baseline.
                    // Require a fresh read instead.
                    log.warn(`Document ${args.documentId} must be read again before the next write ` +
                        '(the Apps Script mutates the doc outside batchUpdate visibility, so no true post-write revision is available).');
                    await appsScriptLease.requireReread('an Apps Script inserted an image and its resulting revision is not visible to us.');
                    const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                    return `${docUrl}\nSuccessfully inserted local image at index ${args.index} via Apps Script${args.tabId ? ` in tab ${args.tabId}` : ''}.`;
                }
                // --- Standard path: public URL insertion via Docs API ---
                // Acquire the lease BEFORE any Drive upload: a rejected mutation
                // (unauthorized/never-read document, expired handle, etc.) must
                // never leave a file behind in the user's Drive (#87 gap).
                const lease = await beginDocsMutation(args.documentId, {
                    tabId: args.tabId ?? null,
                    readHandle: args.readHandle,
                });
                let resolvedUrl;
                if (args.localImagePath) {
                    const drive = await getDriveClient();
                    log.info(`Uploading local image ${args.localImagePath} and inserting at index ${args.index} in doc ${args.documentId}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);
                    let parentFolderId;
                    try {
                        const docInfo = await drive.files.get({
                            fileId: args.documentId,
                            fields: 'parents',
                            supportsAllDrives: true,
                        });
                        if (docInfo.data.parents && docInfo.data.parents.length > 0) {
                            parentFolderId = docInfo.data.parents[0];
                        }
                    }
                    catch (folderError) {
                        log.warn(`Could not determine document's parent folder, using Drive root: ${folderError}`);
                    }
                    try {
                        resolvedUrl = await GDocsHelpers.uploadImageToDrive(drive, args.localImagePath, parentFolderId);
                    }
                    catch (uploadError) {
                        // Nothing was written to the document, so this is not a
                        // failed mutation — fail() would terminalize the handle
                        // as INVALID. abort() returns the record to active so a
                        // corrected retry can reuse the same handle.
                        await lease.abort();
                        throw uploadError;
                    }
                    log.info(`Image uploaded successfully, URL: ${resolvedUrl}`);
                }
                else {
                    resolvedUrl = args.imageUrl;
                    log.info(`Inserting image from URL ${resolvedUrl} at index ${args.index} in doc ${args.documentId}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);
                }
                await lease.write(
                    (writeControl) => GDocsHelpers.insertInlineImage(docs, args.documentId, resolvedUrl, args.index, args.width, args.height, args.tabId, writeControl),
                    (response) => response?.writeControl?.requiredRevisionId,
                );
                let sizeInfo = '';
                if (args.width && args.height) {
                    sizeInfo = ` with size ${args.width}x${args.height}pt`;
                }
                const docUrl2 = `https://docs.google.com/document/d/${args.documentId}/edit`;
                return `${docUrl2}\nSuccessfully inserted image at index ${args.index}${sizeInfo}${args.tabId ? ` in tab ${args.tabId}` : ''}.`;
            }
            catch (error) {
                log.error(`Error inserting image in doc ${args.documentId}: ${error.message || error}`);
                if (isPublicError(error))
                    throw error;
throw wrapOperationError('insert document image', error, { status: error?.code });
            }
        },
    });
}
