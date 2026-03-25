import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDriveClient, getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'createSpreadsheet',
        description: 'Creates a new spreadsheet. Optionally places it in a specific folder and populates it with initial data.',
        parameters: z.object({
            title: z.string().min(1).describe('Title for the new spreadsheet.'),
            parentFolderId: z
                .string()
                .optional()
                .describe('ID of folder where spreadsheet should be created. If not provided, creates in Drive root.'),
            initialData: z
                .array(z.array(z.any()))
                .optional()
                .describe('Optional initial data to populate in the first sheet. Each inner array represents a row.'),
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            const sheets = await getSheetsClient();
            log.info(`Creating new spreadsheet "${args.title}"`);
            try {
                // Create the spreadsheet file in Drive
                const spreadsheetMetadata = {
                    name: args.title,
                    mimeType: 'application/vnd.google-apps.spreadsheet',
                };
                if (args.parentFolderId) {
                    spreadsheetMetadata.parents = [args.parentFolderId];
                }
                const driveResponse = await drive.files.create({
                    requestBody: spreadsheetMetadata,
                    fields: 'id,name,webViewLink',
                    supportsAllDrives: true,
                });
                const spreadsheetId = driveResponse.data.id;
                if (!spreadsheetId) {
                    throw new UserError('Failed to create spreadsheet - no ID returned.');
                }
                let initialDataStatus;
                // Add initial data if provided
                if (args.initialData && args.initialData.length > 0) {
                    try {
                        await SheetsHelpers.writeRange(sheets, spreadsheetId, 'A1', args.initialData, 'USER_ENTERED');
                        initialDataStatus = 'added';
                    }
                    catch (contentError) {
                        log.warn(`Spreadsheet created but failed to add initial data: ${contentError.message}`);
                        initialDataStatus = 'failed';
                    }
                }
                return JSON.stringify({
                    id: spreadsheetId,
                    name: driveResponse.data.name,
                    url: driveResponse.data.webViewLink,
                    ...(initialDataStatus ? { initialData: initialDataStatus } : {}),
                }, null, 2);
            }
            catch (error) {
                log.error(`Error creating spreadsheet: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError('Parent folder not found. Check the folder ID.');
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have write access to the destination folder.');
                throw new UserError(`Failed to create spreadsheet: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
