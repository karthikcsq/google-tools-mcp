// Regression coverage for PR #42 review (ElliotDrel): appendText, deleteRange, and
// findAndReplace previously only had the older, weaker guardMutation (Drive
// modifiedTime) check against the exact TOCTOU race issue #37 describes. They now
// seed a WriteControl guard from the caller's last tracked read (getLastReadRevisionId)
// and attach it to their batchUpdate call, same as modifyText/appendMarkdown/
// replaceDocumentWithMarkdown.
//
// Drives each tool's real execute() with a mocked Google Docs/Drive client (clients.js
// is the only external dependency; readTracker and googleDocsApiHelpers run for real),
// mirroring tests/docsWriteControl.test.js and tests/replaceMarkdownWriteControl.test.js.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { UserError } from 'fastmcp';

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
const { register: registerAppendText } = await import('../dist/tools/docs/appendToGoogleDoc.js');
const { register: registerDeleteRange } = await import('../dist/tools/docs/deleteRange.js');
const { register: registerFindAndReplace } = await import('../dist/tools/docs/findAndReplace.js');

function createMockServer() {
    const tools = new Map();
    return {
        addTool(def) { tools.set(def.name, def); },
        getTool(name) { return tools.get(name); },
    };
}

const noopLog = { info() {}, error() {}, warn() {}, debug() {} };

// A revision-conflict error shaped like a real Docs API FAILED_PRECONDITION response.
function staleRevisionError() {
    return Object.assign(new Error('Precondition check failed.'), {
        code: 400,
        response: { data: { error: { status: 'FAILED_PRECONDITION', message: 'Precondition check failed.' } } },
    });
}

beforeEach(() => {
    // guardMutation's Drive modifiedTime check is a no-op when the tracked entry
    // has no modifiedTime (as set by our trackRead(..., null, ...) calls below).
    fakeDrive = { files: { get: async () => ({ data: { modifiedTime: null } }) } };
});

describe('appendText — WriteControl guard', () => {
    function setUpDocsMock(batchUpdateImpl) {
        const documentsGet = jest.fn(async () => ({
            data: { body: { content: [{ endIndex: 10 }] } },
        }));
        const batchUpdate = jest.fn(batchUpdateImpl);
        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
        return { documentsGet, batchUpdate };
    }

    it('sends the revision from the last tracked read and succeeds on a clean write', async () => {
        const documentId = `append-ok-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock(async ({ requestBody }) => ({
            data: { writeControl: requestBody.writeControl },
        }));
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerAppendText(server);
        const tool = server.getTool('appendText');

        const result = await tool.execute({ documentId, text: 'hello' }, { log: noopLog });

        expect(batchUpdate).toHaveBeenCalledTimes(1);
        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-read' });
        expect(result).toMatch(/Successfully appended text/);
    });

    it('rejects a stale-revision write with a clear re-read error', async () => {
        const documentId = `append-stale-${Date.now()}`;
        setUpDocsMock(async () => { throw staleRevisionError(); });
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerAppendText(server);
        const tool = server.getTool('appendText');

        await expect(
            tool.execute({ documentId, text: 'hello' }, { log: noopLog })
        ).rejects.toThrow(/changed since you last read/i);
    });

    it('omits writeControl when the document was never read (legacy/no-op behavior)', async () => {
        const documentId = `append-untracked-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock(async () => ({ data: {} }));
        // No trackRead call — hasBeenRead is false, so guardMutation would normally
        // reject, but appendText's own guardMutation call requires a read to exist.
        // Track a read WITHOUT a revisionId (simulates a legacy read path).
        trackRead(documentId, null, null, undefined);

        const server = createMockServer();
        registerAppendText(server);
        const tool = server.getTool('appendText');

        await tool.execute({ documentId, text: 'hello' }, { log: noopLog });

        expect(batchUpdate).toHaveBeenCalledTimes(1);
        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toBeUndefined();
    });
});

describe('deleteRange — WriteControl guard', () => {
    function setUpDocsMock(batchUpdateImpl) {
        const documentsGet = jest.fn(async () => ({ data: {} }));
        const batchUpdate = jest.fn(batchUpdateImpl);
        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
        return { documentsGet, batchUpdate };
    }

    it('sends the revision from the last tracked read and succeeds on a clean write', async () => {
        const documentId = `delete-ok-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock(async ({ requestBody }) => ({
            data: { writeControl: requestBody.writeControl },
        }));
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerDeleteRange(server);
        const tool = server.getTool('deleteRange');

        const result = await tool.execute({ documentId, startIndex: 1, endIndex: 5 }, { log: noopLog });

        expect(batchUpdate).toHaveBeenCalledTimes(1);
        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-read' });
        expect(result).toMatch(/Successfully deleted content/);
    });

    it('rejects a stale-revision write with a clear re-read error', async () => {
        const documentId = `delete-stale-${Date.now()}`;
        setUpDocsMock(async () => { throw staleRevisionError(); });
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerDeleteRange(server);
        const tool = server.getTool('deleteRange');

        await expect(
            tool.execute({ documentId, startIndex: 1, endIndex: 5 }, { log: noopLog })
        ).rejects.toThrow(/changed since you last read/i);
    });

    it('omits writeControl when the document was never read (legacy/no-op behavior)', async () => {
        const documentId = `delete-untracked-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock(async () => ({ data: {} }));
        // Track a read WITHOUT a revisionId (simulates a legacy read path); guardMutation
        // requires a read to exist, but getLastReadRevisionId should still resolve to null.
        trackRead(documentId, null, null, undefined);

        const server = createMockServer();
        registerDeleteRange(server);
        const tool = server.getTool('deleteRange');

        await tool.execute({ documentId, startIndex: 1, endIndex: 5 }, { log: noopLog });

        expect(batchUpdate).toHaveBeenCalledTimes(1);
        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toBeUndefined();
    });
});

describe('findAndReplace — WriteControl guard', () => {
    function setUpDocsMock(batchUpdateImpl) {
        const documentsGet = jest.fn(async () => ({ data: {} }));
        const batchUpdate = jest.fn(batchUpdateImpl);
        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
        return { documentsGet, batchUpdate };
    }

    it('sends the revision from the last tracked read and succeeds on a clean write', async () => {
        const documentId = `far-ok-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock(async ({ requestBody }) => ({
            data: {
                writeControl: requestBody.writeControl,
                replies: [{ replaceAllText: { occurrencesChanged: 2 } }],
            },
        }));
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerFindAndReplace(server);
        const tool = server.getTool('findAndReplace');

        const result = await tool.execute(
            { documentId, findText: 'foo', replaceText: 'bar' },
            { log: noopLog }
        );

        expect(batchUpdate).toHaveBeenCalledTimes(1);
        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-read' });
        expect(result).toMatch(/Replaced 2 occurrence/);
    });

    it('rejects a stale-revision write with a clear re-read error', async () => {
        const documentId = `far-stale-${Date.now()}`;
        setUpDocsMock(async () => { throw staleRevisionError(); });
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerFindAndReplace(server);
        const tool = server.getTool('findAndReplace');

        await expect(
            tool.execute({ documentId, findText: 'foo', replaceText: 'bar' }, { log: noopLog })
        ).rejects.toThrow(/changed since you last read/i);
    });

    it('omits writeControl when the document was never read (legacy/no-op behavior)', async () => {
        const documentId = `far-untracked-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock(async () => ({
            data: { replies: [{ replaceAllText: { occurrencesChanged: 1 } }] },
        }));
        // Track a read WITHOUT a revisionId (simulates a legacy read path); guardMutation
        // requires a read to exist, but getLastReadRevisionId should still resolve to null.
        trackRead(documentId, null, null, undefined);

        const server = createMockServer();
        registerFindAndReplace(server);
        const tool = server.getTool('findAndReplace');

        await tool.execute({ documentId, findText: 'foo', replaceText: 'bar' }, { log: noopLog });

        expect(batchUpdate).toHaveBeenCalledTimes(1);
        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toBeUndefined();
    });
});
