// #87: a successful create or copy must seed only the read state that the
// destination type can honestly support. Docs receive their fetched content
// and revision, Sheets match readSpreadsheet's metadata-only tracker entry,
// and arbitrary binaries stay unread because no mutation-safe content view is
// available for them.
import { describe, expect, it, jest } from '@jest/globals';

let fakeDocs;
let fakeDrive;
let fakeSheets;

jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => fakeDocs,
    getDriveClient: async () => fakeDrive,
    getSheetsClient: async () => fakeSheets,
    getAuthClient: async () => { throw new Error('client not used in this suite'); },
    getAuthClientIfReady: () => null,
    getCalendarClient: async () => { throw new Error('client not used in this suite'); },
    getFormsClient: async () => { throw new Error('client not used in this suite'); },
    getGmailClient: async () => { throw new Error('client not used in this suite'); },
    getScriptClient: async () => { throw new Error('client not used in this suite'); },
    getSlidesClient: async () => { throw new Error('client not used in this suite'); },
    getTasksClient: async () => { throw new Error('client not used in this suite'); },
    resetClients: () => {},
    withAuthRetry: (fn) => fn(),
}));

const { register: registerCreateSpreadsheet } = await import('../dist/tools/sheets/createSpreadsheet.js');
const { register: registerWriteSpreadsheet } = await import('../dist/tools/sheets/writeSpreadsheet.js');
const { register: registerBatchWrite } = await import('../dist/tools/sheets/batchWrite.js');
const { register: registerCopyFile } = await import('../dist/tools/drive/copyFile.js');
const { register: registerAppendText } = await import('../dist/tools/docs/appendToGoogleDoc.js');
const { register: registerDeleteFile } = await import('../dist/tools/drive/deleteFile.js');

const MODIFIED_TIME = '2026-08-31T12:00:00.000Z';
const REVISION = 'copied-doc-revision';
const log = { info() {}, warn() {}, error() {} };

let idSequence = 0;
function freshId(label) {
    idSequence += 1;
    return `${label}-${idSequence}`;
}

function getTool(register) {
    let tool;
    register({ addTool(definition) { tool = definition; } });
    return tool;
}

function docPayload(id) {
    return {
        data: {
            id,
            revisionId: REVISION,
            body: {
                content: [{
                    startIndex: 1,
                    endIndex: 16,
                    paragraph: {
                        elements: [{
                            startIndex: 1,
                            endIndex: 16,
                            textRun: { content: 'copied content\n' },
                        }],
                    },
                }],
            },
        },
    };
}

function setGoogleMocks(id, {
    copiedMimeType = 'application/vnd.google-apps.spreadsheet',
    initialDataFails = false,
    docsSeedFails = false,
} = {}) {
    let valuesUpdateCalls = 0;
    const valuesUpdate = jest.fn(async () => {
        valuesUpdateCalls += 1;
        if (initialDataFails && valuesUpdateCalls === 1) {
            throw new Error('simulated initial-data failure');
        }
        return { data: { updatedCells: 1, updatedRows: 1, updatedColumns: 1 } };
    });
    const documentsGet = jest.fn(async () => {
        if (docsSeedFails) throw new Error('simulated Docs seed failure');
        return docPayload(id);
    });
    const batchUpdate = jest.fn(async ({ requestBody }) => ({
        data: { writeControl: requestBody.writeControl },
    }));

    fakeDocs = { documents: { get: documentsGet, batchUpdate } };
    fakeSheets = {
        spreadsheets: {
            values: {
                update: valuesUpdate,
                batchUpdate: jest.fn(async () => ({
                    data: {
                        totalUpdatedCells: 1,
                        totalUpdatedRows: 1,
                        totalUpdatedColumns: 1,
                        totalUpdatedSheets: 1,
                    },
                })),
            },
        },
    };
    const filesCreate = jest.fn(async () => ({
        data: { id, name: 'Created spreadsheet', webViewLink: `https://sheets/${id}` },
    }));
    const filesCopy = jest.fn(async () => ({
        data: {
            id,
            name: 'Copied file',
            webViewLink: `https://drive/${id}`,
            mimeType: copiedMimeType,
            modifiedTime: MODIFIED_TIME,
        },
    }));
    const filesGet = jest.fn(async ({ fileId }) => {
        if (fileId === 'source-file') {
            return { data: { name: 'Source file', parents: ['source-parent'] } };
        }
        return {
            data: {
                name: 'Copied file',
                mimeType: copiedMimeType,
                modifiedTime: MODIFIED_TIME,
            },
        };
    });
    fakeDrive = {
        files: {
            create: filesCreate,
            copy: filesCopy,
            get: filesGet,
            update: jest.fn(async () => ({ data: {} })),
            delete: jest.fn(async () => ({ data: {} })),
        },
    };
    return { documentsGet, batchUpdate, filesCreate, filesCopy, valuesUpdate };
}

describe('create and copy read seeding (#87)', () => {
    it('createSpreadsheet then writeSpreadsheet succeeds without a redundant read', async () => {
        const id = freshId('created-sheet-write');
        const { filesCreate, valuesUpdate } = setGoogleMocks(id);

        const created = await getTool(registerCreateSpreadsheet).execute({ title: 'Created sheet' }, { log });
        expect(JSON.parse(created).id).toBe(id);
        const written = await getTool(registerWriteSpreadsheet).execute({
            spreadsheetId: id, range: 'A1', values: [['created then written']],
        }, { log });

        expect(written).toMatch(/Successfully wrote 1 cells/);
        expect(filesCreate).toHaveBeenCalledTimes(1);
        expect(valuesUpdate).toHaveBeenCalledTimes(1);
    });

    it('createSpreadsheet still seeds when optional initial data fails, so batchWrite succeeds', async () => {
        const id = freshId('created-sheet-batch');
        setGoogleMocks(id, { initialDataFails: true });

        const created = await getTool(registerCreateSpreadsheet).execute({
            title: 'Created sheet', initialData: [['this write fails']],
        }, { log });
        expect(JSON.parse(created)).toMatchObject({ id, initialData: 'failed' });
        const written = await getTool(registerBatchWrite).execute({
            spreadsheetId: id,
            data: [{ range: 'A1', values: [['batch write after create']] }],
        }, { log });

        expect(written).toMatch(/Successfully batch-wrote 1 cells/);
    });

    it('copyFile seeds a Google Doc from a fetched content and revision snapshot before appendText', async () => {
        const id = freshId('copied-doc');
        const { batchUpdate, documentsGet } = setGoogleMocks(id, {
            copiedMimeType: 'application/vnd.google-apps.document',
        });

        const copied = await getTool(registerCopyFile).execute({ fileId: 'source-file' }, { log });
        expect(JSON.parse(copied).id).toBe(id);
        const appended = await getTool(registerAppendText).execute({
            documentId: id, text: 'after copy',
        }, { log });

        expect(appended).toMatch(/Successfully appended text/);
        expect(documentsGet).toHaveBeenCalled();
        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: REVISION });
    });

    it('copyFile seeds a Google Sheet with the same metadata-only state as readSpreadsheet', async () => {
        const id = freshId('copied-sheet');
        setGoogleMocks(id, { copiedMimeType: 'application/vnd.google-apps.spreadsheet' });

        const copied = await getTool(registerCopyFile).execute({ fileId: 'source-file' }, { log });
        expect(JSON.parse(copied).id).toBe(id);
        const written = await getTool(registerWriteSpreadsheet).execute({
            spreadsheetId: id, range: 'A1', values: [['after copy']],
        }, { log });

        expect(written).toMatch(/Successfully wrote 1 cells/);
    });

    it('keeps arbitrary binary copies unread, because deleteFile is guarded but copyFile did not read their content', async () => {
        const id = freshId('copied-binary');
        setGoogleMocks(id, { copiedMimeType: 'application/pdf' });

        await getTool(registerCopyFile).execute({ fileId: 'source-file' }, { log });

        // Intentional: deleteFile is the generic guarded mutation, but an
        // arbitrary binary copy has no trustworthy content snapshot here.
        await expect(getTool(registerDeleteFile).execute({ fileId: id }, { log }))
            .rejects.toThrow(/has not been read in this session/i);
    });

    it('returns the successful copied-Doc payload when its best-effort seed fetch fails', async () => {
        const id = freshId('copied-doc-seed-fail');
        const { documentsGet, filesCopy } = setGoogleMocks(id, {
            copiedMimeType: 'application/vnd.google-apps.document', docsSeedFails: true,
        });

        const copied = await getTool(registerCopyFile).execute({ fileId: 'source-file' }, { log });

        expect(JSON.parse(copied)).toMatchObject({
            id,
            name: 'Copied file',
            url: `https://drive/${id}`,
            warnings: ['The Google Doc copy was created, but its read state could not be seeded. Call readDocument before the next mutation.'],
        });
        expect(filesCopy).toHaveBeenCalledTimes(1);
        expect(documentsGet).toHaveBeenCalledTimes(1);
    });
});
