import { describe, expect, test } from '@jest/globals';
import { configureOfflineBackend, getDriveClient, getSheetsClient, getOfflineBackendStatus } from '../scripts/agent-testing/offline-clients.mjs';

configureOfflineBackend({ folderId: 'sheet-test-root', workspaceDir: process.cwd() });
describe('offline Sheets interpretation boundary', () => {
    test.each(['update', 'append'])('%s rejects USER_ENTERED strings atomically and preserves RAW literals', async (method) => {
        const drive = await getDriveClient();
        const sheets = await getSheetsClient();
        const { data: file } = await drive.files.create({ requestBody: {
            name: 'Input modes', mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['sheet-test-root'],
        } });
        const params = { spreadsheetId: file.id, range: 'A1:C2' };
        const raw = [['=1+1', '001', '2026-10-19']];
        await sheets.spreadsheets.values[method]({ ...params, valueInputOption: 'RAW', requestBody: { values: raw } });
        expect((await sheets.spreadsheets.values.get(params)).data.values).toEqual(raw);
        const before = getOfflineBackendStatus().counters.unsupported;
        for (const value of ['=1+1', '001', '2026-10-19', "'literal"]) {
            await expect(sheets.spreadsheets.values[method]({
                ...params, valueInputOption: 'USER_ENTERED', requestBody: { values: [[123, value]] },
            })).rejects.toMatchObject({ code: 'OFFLINE_UNSUPPORTED' });
            expect((await sheets.spreadsheets.values.get(params)).data.values).toEqual(raw);
        }
        expect(getOfflineBackendStatus().counters.unsupported).toBe(before + 4);
        await drive.files.update({ fileId: file.id, requestBody: { trashed: true } });
    });
});
