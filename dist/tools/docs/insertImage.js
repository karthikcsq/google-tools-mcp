import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDocsClient, getDriveClient, getScriptClient } from '../../clients.js';
import { DocumentIdParameter } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
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
                        throw new UserError(`Tab with ID "${args.tabId}" not found in document.`);
                    }
                    if (!targetTab.documentTab) {
                        throw new UserError(`Tab "${args.tabId}" does not have content (may not be a document tab).`);
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
                    const driveFileId = await GDocsHelpers.uploadImageToDrive(drive, args.localImagePath, parentFolderId, true // skipPublicSharing
                    );
                    log.info(`[AppsScript] Inserting image via marker at index ${args.index} (fileId: ${driveFileId})`);
                    await GDocsHelpers.insertImageViaAppsScript(docs, scriptClient, appsScriptDeploymentId, args.documentId, driveFileId, args.index, args.tabId);
                    const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                    return `${docUrl}\nSuccessfully inserted local image at index ${args.index} via Apps Script${args.tabId ? ` in tab ${args.tabId}` : ''}.`;
                }
                // --- Standard path: public URL insertion via Docs API ---
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
                    resolvedUrl = await GDocsHelpers.uploadImageToDrive(drive, args.localImagePath, parentFolderId);
                    log.info(`Image uploaded successfully, URL: ${resolvedUrl}`);
                }
                else {
                    resolvedUrl = args.imageUrl;
                    log.info(`Inserting image from URL ${resolvedUrl} at index ${args.index} in doc ${args.documentId}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);
                }
                await GDocsHelpers.insertInlineImage(docs, args.documentId, resolvedUrl, args.index, args.width, args.height, args.tabId);
                let sizeInfo = '';
                if (args.width && args.height) {
                    sizeInfo = ` with size ${args.width}x${args.height}pt`;
                }
                const docUrl2 = `https://docs.google.com/document/d/${args.documentId}/edit`;
                return `${docUrl2}\nSuccessfully inserted image at index ${args.index}${sizeInfo}${args.tabId ? ` in tab ${args.tabId}` : ''}.`;
            }
            catch (error) {
                log.error(`Error inserting image in doc ${args.documentId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to insert image: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
