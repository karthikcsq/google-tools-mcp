// Extends WriteControl coverage (PR #42 review) to the remaining Docs tools that
// call executeBatchUpdate / executeBatchUpdateWithSplitting / documents.batchUpdate
// but weren't in the originally-named list of 6 (modifyText, appendMarkdown,
// replaceDocumentWithMarkdown, appendText, deleteRange, findAndReplace). None of
// these tools ever had a guardMutation check, so there's no existing guard to
// preserve — this only proves the additive, opt-in WriteControl wiring is correct:
// when a caller's prior read is tracked, the revision is attached to every write.
import { describe, it, expect, jest } from '@jest/globals';

let fakeDocs;
let fakeDrive;
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => fakeDocs,
    getDriveClient: async () => fakeDrive,
    getSheetsClient: async () => { throw new Error('not used'); },
    getCalendarClient: async () => { throw new Error('not used'); },
    getScriptClient: async () => { throw new Error('not used'); },
}));

const { trackRead } = await import('../dist/readTracker.js');
const { register: registerInsertPageBreak } = await import('../dist/tools/docs/insertPageBreak.js');
const { register: registerApplyParagraphStyle } = await import('../dist/tools/docs/formatting/applyParagraphStyle.js');
const { register: registerInsertTableWithData } = await import('../dist/tools/docs/insertTableWithData.js');
const { register: registerInsertTable } = await import('../dist/tools/docs/insertTable.js');
const { register: registerAddTab } = await import('../dist/tools/docs/addTab.js');
const { register: registerRenameTab } = await import('../dist/tools/docs/renameTab.js');

function createMockServer() {
    const tools = new Map();
    return {
        addTool(def) { tools.set(def.name, def); },
        getTool(name) { return tools.get(name); },
    };
}

const noopLog = { info() {}, error() {}, warn() {}, debug() {} };

function staleRevisionError() {
    return Object.assign(new Error('Precondition check failed.'), {
        code: 400,
        response: { data: { error: { status: 'FAILED_PRECONDITION', message: 'Precondition check failed.' } } },
    });
}

describe('insertPageBreak — WriteControl guard', () => {
    it('attaches the tracked revision to its batchUpdate call', async () => {
        const documentId = `pagebreak-${Date.now()}`;
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
        fakeDocs = { documents: { get: jest.fn(), batchUpdate } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerInsertPageBreak(server);
        await server.getTool('insertPageBreak').execute({ documentId, index: 5 }, { log: noopLog });

        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-read' });
    });

    it('rejects a stale-revision write with a clear re-read error', async () => {
        const documentId = `pagebreak-stale-${Date.now()}`;
        fakeDocs = { documents: { get: jest.fn(), batchUpdate: jest.fn(async () => { throw staleRevisionError(); }) } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerInsertPageBreak(server);
        await expect(
            server.getTool('insertPageBreak').execute({ documentId, index: 5 }, { log: noopLog })
        ).rejects.toThrow(/changed since you last read/i);
    });
});

describe('applyParagraphStyle — WriteControl guard', () => {
    it('attaches the tracked revision to its batchUpdate call', async () => {
        const documentId = `parastyle-${Date.now()}`;
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
        fakeDocs = { documents: { get: jest.fn(), batchUpdate } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerApplyParagraphStyle(server);
        await server.getTool('applyParagraphStyle').execute({
            documentId,
            target: { startIndex: 1, endIndex: 10 },
            style: { alignment: 'CENTER' },
        }, { log: noopLog });

        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-read' });
    });

    it('rejects a stale-revision write with a clear re-read error', async () => {
        const documentId = `parastyle-stale-${Date.now()}`;
        fakeDocs = { documents: { get: jest.fn(), batchUpdate: jest.fn(async () => { throw staleRevisionError(); }) } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerApplyParagraphStyle(server);
        await expect(
            server.getTool('applyParagraphStyle').execute({
                documentId,
                target: { startIndex: 1, endIndex: 10 },
                style: { alignment: 'CENTER' },
            }, { log: noopLog })
        ).rejects.toThrow(/changed since you last read/i);
    });
});

describe('insertTableWithData — WriteControl guard', () => {
    it('attaches the tracked revision to every split batch', async () => {
        const documentId = `tablewithdata-${Date.now()}`;
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
        fakeDocs = { documents: { get: jest.fn(), batchUpdate } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerInsertTableWithData(server);
        await server.getTool('insertTableWithData').execute({
            documentId,
            data: [['a', 'b'], ['c', 'd']],
            index: 1,
        }, { log: noopLog });

        expect(batchUpdate).toHaveBeenCalled();
        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-read' });
    });

    it('rejects a stale-revision write with a clear re-read error', async () => {
        const documentId = `tablewithdata-stale-${Date.now()}`;
        fakeDocs = { documents: { get: jest.fn(), batchUpdate: jest.fn(async () => { throw staleRevisionError(); }) } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerInsertTableWithData(server);
        await expect(
            server.getTool('insertTableWithData').execute({
                documentId,
                data: [['a', 'b']],
                index: 1,
            }, { log: noopLog })
        ).rejects.toThrow(/changed since you last read/i);
    });
});

describe('insertTable — WriteControl guard', () => {
    it('attaches the tracked revision to its batchUpdate call', async () => {
        const documentId = `inserttable-${Date.now()}`;
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
        fakeDocs = { documents: { get: jest.fn(), batchUpdate } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerInsertTable(server);
        await server.getTool('insertTable').execute({ documentId, rows: 2, columns: 2, index: 1 }, { log: noopLog });

        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-read' });
    });
});

describe('addTab — WriteControl guard', () => {
    it('attaches the tracked revision to its batchUpdate call', async () => {
        const documentId = `addtab-${Date.now()}`;
        const batchUpdate = jest.fn(async ({ requestBody }) => ({
            data: {
                writeControl: requestBody.writeControl,
                replies: [{ addDocumentTab: { tabProperties: { tabId: 'new-tab', title: 'Untitled' } } }],
            },
        }));
        fakeDocs = { documents: { get: jest.fn(), batchUpdate } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerAddTab(server);
        await server.getTool('addTab').execute({ documentId }, { log: noopLog });

        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-read' });
    });

    it('rejects a stale-revision write with a clear re-read error', async () => {
        const documentId = `addtab-stale-${Date.now()}`;
        fakeDocs = { documents: { get: jest.fn(), batchUpdate: jest.fn(async () => { throw staleRevisionError(); }) } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerAddTab(server);
        await expect(
            server.getTool('addTab').execute({ documentId }, { log: noopLog })
        ).rejects.toThrow(/changed since you last read/i);
    });
});

describe('renameTab — WriteControl guard', () => {
    function setUpDocsMock(batchUpdateImpl) {
        const documentsGet = jest.fn(async () => ({
            data: { tabs: [{ tabProperties: { tabId: 'tab-1', title: 'Old Title' } }] },
        }));
        const batchUpdate = jest.fn(batchUpdateImpl);
        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
        return { documentsGet, batchUpdate };
    }

    it('attaches the tracked revision to its batchUpdate call', async () => {
        const documentId = `renametab-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerRenameTab(server);
        await server.getTool('renameTab').execute({ documentId, tabId: 'tab-1', newTitle: 'New Title' }, { log: noopLog });

        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-read' });
    });

    it('rejects a stale-revision write with a clear re-read error', async () => {
        const documentId = `renametab-stale-${Date.now()}`;
        setUpDocsMock(async () => { throw staleRevisionError(); });
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerRenameTab(server);
        await expect(
            server.getTool('renameTab').execute({ documentId, tabId: 'tab-1', newTitle: 'New Title' }, { log: noopLog })
        ).rejects.toThrow(/changed since you last read/i);
    });
});
