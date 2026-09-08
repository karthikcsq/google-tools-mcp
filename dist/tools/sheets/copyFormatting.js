import { UserError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient, getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
import { guardMutation } from '../../readTracker.js';
import { beginSheetsCellStateMutation, prepareSheetRangeTargets, ResourceReadHandleParameter } from '../../resourceHandles.js';

function effectiveCopyDestination(source, destination) {
    const sourceHeight = source.endRow - source.startRow;
    const sourceWidth = source.endColumn - source.startColumn;
    const destinationHeight = destination.endRow - destination.startRow;
    const destinationWidth = destination.endColumn - destination.startColumn;
    return {
        ...destination,
        // CopyPaste repeats the source across a smaller destination. Its
        // actual touched area is therefore the larger dimension in each axis.
        endRow: destination.startRow + Math.max(sourceHeight, destinationHeight),
        endColumn: destination.startColumn + Math.max(sourceWidth, destinationWidth),
    };
}

export function register(server) {
    server.addTool({
        name: 'copyFormatting',
        description: 'Copies formatting (not values) from a source range to a destination range within the same spreadsheet. Copies bold, colors, borders, number formats, etc. CopyPaste expands a smaller destination to the source size, so on modern runtimes readCellFormat must cover that complete effective destination range.',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            sourceSheetName: z.string().min(1).describe('Source sheet/tab name (e.g., "Sheet1").'),
            sourceRange: z
                .string()
                .describe('A1 notation for the source range (e.g., "A1:D10"). Do not include the sheet name — use sourceSheetName instead.'),
            destinationSheetName: z
                .string()
                .min(1)
                .describe('Destination sheet/tab name (e.g., "Sheet2").'),
            destinationRange: z
                .string()
                .describe('A1 notation for the destination range (e.g., "A1:D10"). Do not include the sheet name — use destinationSheetName instead.'),
            readHandle: ResourceReadHandleParameter,
        }),
        execute: async (args, { log }) => {
            const sheets = await getSheetsClient();
            const drive = await getDriveClient();
            let lease;
            log.info(`Copying formatting from ${args.sourceSheetName}!${args.sourceRange} to ${args.destinationSheetName}!${args.destinationRange} in spreadsheet ${args.spreadsheetId}`);
            try {
                const source = `'${args.sourceSheetName.replace(/'/g, "''")}'!${args.sourceRange}`;
                const destination = `'${args.destinationSheetName.replace(/'/g, "''")}'!${args.destinationRange}`;
                // Canonicalize both ranges up front. This rejects unbounded
                // CopyPaste inputs and derives the API's true write extent
                // before the handle is reserved or Google is called.
                const [sourceTarget] = await prepareSheetRangeTargets(sheets, args.spreadsheetId, [source]);
                const [destinationTarget] = await prepareSheetRangeTargets(sheets, args.spreadsheetId, [destination]);
                const targets = [effectiveCopyDestination(sourceTarget, destinationTarget)];
                lease = await beginSheetsCellStateMutation({
                    spreadsheetId: args.spreadsheetId, readHandle: args.readHandle, drive, sheets,
                    targets,
                    legacyGuard: () => guardMutation(args.spreadsheetId),
                });
                // The destination state is the guarded overwrite scope. The
                // source is read immediately before the copy and may therefore
                // supply its current format without minting write authority.
                const sourceSheet = lease.sheets.find((sheet) => sheet.title === args.sourceSheetName);
                const destSheet = lease.sheets.find((sheet) => sheet.title === args.destinationSheetName);
                if (!sourceSheet || !destSheet) {
                    await lease.abort();
                    throw new UserError('A source or destination sheet is no longer present. Call readCellFormat again.');
                }
                const sourceSheetId = sourceSheet.sheetId;
                const destSheetId = destSheet.sheetId;
                // Convert A1 ranges to GridRange objects
                const sourceGridRange = SheetsHelpers.parseA1ToGridRange(args.sourceRange, sourceSheetId);
                const destGridRange = SheetsHelpers.parseA1ToGridRange(args.destinationRange, destSheetId);
                await lease.write(() => sheets.spreadsheets.batchUpdate({
                    spreadsheetId: args.spreadsheetId,
                    requestBody: {
                        requests: [
                            {
                                copyPaste: {
                                    source: sourceGridRange,
                                    destination: destGridRange,
                                    pasteType: 'PASTE_FORMAT',
                                },
                            },
                        ],
                    },
                }));
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`;
                return `${sheetUrl}\nSuccessfully copied formatting from ${args.sourceSheetName}!${args.sourceRange} to ${args.destinationSheetName}!${args.destinationRange}.`;
            }
            catch (error) {
                await lease?.abort();
                log.error(`Error copying formatting in spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw wrapOperationError('copy formatting', error, { status: error?.code });
            }
        },
    });
}
