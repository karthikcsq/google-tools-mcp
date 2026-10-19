import { UserError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient, getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
import { trackRead } from '../../readTracker.js';
import { mintSheetsReadHandle, readSheetsValueBaseline } from '../../resourceHandles.js';
import { setResultWarning } from '../../handleRuntime.js';
export function register(server) {
    server.addTool({
        name: 'readSpreadsheet',
        description: 'Reads data from a range in a spreadsheet. Returns rows as arrays. Use A1 notation for the range (e.g., "Sheet1!A1:C10").',
        parameters: z.object({
            spreadsheetId: z
                .string()
                .describe('The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'),
            range: z.string().optional().describe('One bounded A1 range to read (e.g., "A1:B10" or "Sheet1!A1:B10").'),
            ranges: z.array(z.string()).min(1).optional().describe('Several bounded A1 ranges to read into one handle, for a later batchWrite.'),
            valueRenderOption: z
                .enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'])
                .optional()
                .default('FORMATTED_VALUE')
                .describe('How values should be rendered in the output.'),
        }),
        execute: async (args, { log }) => {
            const ranges = args.ranges ?? (args.range ? [args.range] : []);
            if (ranges.length === 0 || (args.ranges && args.range)) {
                throw new UserError('Provide exactly one of range or ranges.');
            }
            const sheets = await getSheetsClient();
            const drive = await getDriveClient();
            log.info(`Reading spreadsheet ${args.spreadsheetId}, range(s): ${ranges.join(', ')}`);
            try {
                // This is the capability baseline, not metadata-only tracking:
                // it binds exact bounded ranges, sheet identity, formulas and
                // values, plus Drive's version for the resource.
                let baseline;
                try {
                    baseline = await readSheetsValueBaseline({
                        drive, sheets, spreadsheetId: args.spreadsheetId, ranges,
                        valueRenderOption: args.valueRenderOption,
                    });
                } catch (error) {
                    // Preserve ordinary read-only named/unbounded range support,
                    // but never mint or track write authority from a range that
                    // cannot be bounded precisely.
                    if (!/bounded A1|read-handle range|resource read may cover|A1 column/i.test(error?.message ?? '')) throw error;
                    const fallback = [];
                    for (const range of ranges) fallback.push(await SheetsHelpers.readRange(
                        sheets, args.spreadsheetId, range, args.valueRenderOption,
                    ));
                    const warning = 'This read uses an unbounded or named range and does not mint a readHandle. Read an explicit bounded A1 range before a mutation.';
                    setResultWarning(warning);
                    if (args.range) return JSON.stringify({ range: args.range, values: fallback[0].values || [], warnings: [warning] }, null, 2);
                    return JSON.stringify({
                        ranges: ranges.map((range, index) => ({ range, values: fallback[index].values || [] })),
                        warnings: [warning],
                    }, null, 2);
                }
                trackRead(args.spreadsheetId);
                await mintSheetsReadHandle(args.spreadsheetId, baseline);
                if (args.range) {
                    return JSON.stringify({ ...baseline.displayRanges[0], range: args.range }, null, 2);
                }
                return JSON.stringify({
                    ranges: ranges.map((range, index) => ({ ...baseline.displayRanges[index], range })),
                }, null, 2);
            }
            catch (error) {
                log.error(`Error reading spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw wrapOperationError('read spreadsheet', error, { status: error?.code });
            }
        },
    });
}
