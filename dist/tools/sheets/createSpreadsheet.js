import { UserError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient, getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
import { trackRead } from '../../readTracker.js';
import {
    mintSheetsReadHandle,
    readNewSpreadsheetBlankGridBaseline,
    readSheetsValueBaseline,
} from '../../resourceHandles.js';
import { setResultResourceState } from '../../handleRuntime.js';

function initialDataRange(values) {
    if (!Array.isArray(values) || values.length === 0) return 'A1';
    const columns = Math.max(...values.map((row) => Array.isArray(row) ? row.length : 0));
    if (columns === 0) return 'A1';
    let value = columns;
    let letters = '';
    while (value > 0) {
        value -= 1;
        letters = String.fromCharCode(65 + (value % 26)) + letters;
        value = Math.floor(value / 26);
    }
    return `A1:${letters}${values.length}`;
}
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
                let readStateWarning;
                let readHandle;
                let observedRanges;
                // A failed optional write leaves the created file in an unknown
                // state. Never turn that partial success into write authority.
                if (initialDataStatus === 'failed') {
                    readStateWarning = 'Spreadsheet was created, but its initial data was not confirmed. It was not seeded as read; call readSpreadsheet before another mutation.';
                } else {
                    try {
                        const baseline = initialDataStatus === 'added'
                            ? await readSheetsValueBaseline({
                                drive, sheets, spreadsheetId, ranges: [initialDataRange(args.initialData)],
                            })
                            : await readNewSpreadsheetBlankGridBaseline({ drive, sheets, spreadsheetId });
                        trackRead(spreadsheetId);
                        const issued = await mintSheetsReadHandle(spreadsheetId, baseline);
                        readHandle = issued?.readHandle;
                        observedRanges = baseline.displayRanges;
                        setResultResourceState({ kind: 'sheets-values-v1', ranges: observedRanges });
                    }
                    catch (seedError) {
                        log.warn(`Spreadsheet ${spreadsheetId} created but a verified read baseline could not be captured.`, seedError);
                        readStateWarning = 'Spreadsheet was created, but its read baseline could not be captured. Call readSpreadsheet before the next mutation.';
                    }
                }
                return JSON.stringify({
                    id: spreadsheetId,
                    name: driveResponse.data.name,
                    url: driveResponse.data.webViewLink,
                    ...(initialDataStatus ? { initialData: initialDataStatus } : {}),
                    ...(readHandle ? { readHandleNote: 'This spreadsheet was read after creation. The returned readHandle authorizes only its captured bounded range.' } : {}),
                    ...(observedRanges ? { observedRanges } : {}),
                    ...(readStateWarning ? { warnings: [readStateWarning] } : {}),
                }, null, 2);
            }
            catch (error) {
                log.error(`Error creating spreadsheet: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError('Parent folder not found. Check the folder ID.');
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have write access to the destination folder.');
                throw wrapOperationError('create spreadsheet', error, { status: error?.code });
            }
        },
    });
}
