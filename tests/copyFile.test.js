// Regression tests for issue #124: copyFile silently dropped the caller's
// `name` argument because the schema only accepted `newName`, so the copy
// always ended up as "Copy of <original>" with no error. Fixed by accepting
// `name` (the Drive API's own field), keeping `newName` for compatibility,
// and rejecting truly-unknown parameters instead of Zod's default silent
// strip so a future typo/rename fails loudly instead of vanishing again.
import { describe, expect, it, jest } from '@jest/globals';

let fakeDrive;
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDriveClient: async () => fakeDrive,
}));

const { register } = await import('../dist/tools/drive/copyFile.js');

function getTool() {
    let tool;
    register({ addTool(definition) { tool = definition; } });
    return tool;
}

const log = { info() {}, warn() {}, error() {}, debug() {} };

function setDrive({ getResult = { name: 'Original', parents: ['parent-1'] }, copyResult = { id: 'copy-1', name: 'ignored', webViewLink: 'https://drive.google.com/copy-1' } } = {}) {
    fakeDrive = {
        files: {
            get: jest.fn(async () => ({ data: getResult })),
            copy: jest.fn(async () => ({ data: copyResult })),
        },
    };
    return fakeDrive;
}

describe('copyFile', () => {
    it('applies the "name" argument to the copy request body (issue #124 repro)', async () => {
        const drive = setDrive();
        await getTool().execute({ fileId: 'file-1', name: 'TEMP - markdown push test - DELETE ME' }, { log });

        expect(drive.files.copy).toHaveBeenCalledWith(expect.objectContaining({
            requestBody: expect.objectContaining({ name: 'TEMP - markdown push test - DELETE ME' }),
        }));
    });

    it('still honors the legacy "newName" argument for backward compatibility', async () => {
        const drive = setDrive();
        await getTool().execute({ fileId: 'file-1', newName: 'Legacy Name' }, { log });

        expect(drive.files.copy).toHaveBeenCalledWith(expect.objectContaining({
            requestBody: expect.objectContaining({ name: 'Legacy Name' }),
        }));
    });

    it('prefers "name" over "newName" when both are given', async () => {
        const drive = setDrive();
        await getTool().execute({ fileId: 'file-1', name: 'New Name', newName: 'Old Name' }, { log });

        expect(drive.files.copy).toHaveBeenCalledWith(expect.objectContaining({
            requestBody: expect.objectContaining({ name: 'New Name' }),
        }));
    });

    it('falls back to "Copy of <original>" when neither name argument is provided', async () => {
        const drive = setDrive({ getResult: { name: 'Kickoff Email Drafts', parents: ['parent-1'] } });
        await getTool().execute({ fileId: 'file-1' }, { log });

        expect(drive.files.copy).toHaveBeenCalledWith(expect.objectContaining({
            requestBody: expect.objectContaining({ name: 'Copy of Kickoff Email Drafts' }),
        }));
    });

    it('rejects an unrecognized parameter instead of silently dropping it', () => {
        const parameters = getTool().parameters;
        expect(parameters.safeParse({ fileId: 'x', name: 'y' }).success).toBe(true);
        expect(parameters.safeParse({ fileId: 'x', newName: 'y' }).success).toBe(true);
        const result = parameters.safeParse({ fileId: 'x', name: 'y', unknownParam: 'z' });
        expect(result.success).toBe(false);
    });
});
