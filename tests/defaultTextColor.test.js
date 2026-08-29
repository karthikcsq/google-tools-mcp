// End-to-end coverage for issue #14 (explicit default text color on inserted
// text) across every insertion path that emits its own batchUpdate requests,
// per docs/plans/issue-14-explicit-font-color.md.
//
// The plan's original acceptance criteria could pass while modifyText (the
// path the issue actually reported) stayed broken, because they only
// exercised the pure markdown converter. These tests drive the REAL tool
// modules end-to-end with a mocked googleapis client (clients.js is the only
// mocked dependency — readTracker, docsHandles, and googleDocsApiHelpers run
// for real) and assert the emitted batchUpdate requests, mirroring
// tests/mutatingDocsToolsWriteControl.test.js and tests/extraDocsToolsWriteControl.test.js.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

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
const { register: registerModifyText } = await import('../dist/tools/docs/modifyText.js');
const { register: registerAppendText } = await import('../dist/tools/docs/appendToGoogleDoc.js');
const { register: registerFindAndReplace } = await import('../dist/tools/docs/findAndReplace.js');
const { register: registerInsertTableWithData } = await import('../dist/tools/docs/insertTableWithData.js');
const { register: registerCreateDocument } = await import('../dist/tools/drive/createDocument.js');
const { register: registerCreateFromTemplate } = await import('../dist/tools/drive/createFromTemplate.js');

function createMockServer() {
    const tools = new Map();
    return { addTool(def) { tools.set(def.name, def); }, getTool(name) { return tools.get(name); } };
}

const noopLog = { info() {}, error() {}, warn() {}, debug() {} };

// A NORMAL_TEXT named style with an explicit RGB default color — the stock
// Google Docs template shape.
const DEFAULT_RGB = { red: 0.1, green: 0.2, blue: 0.3 };
function namedStylesResponse(rgb = DEFAULT_RGB) {
    return {
        data: {
            namedStyles: {
                styles: [
                    { namedStyleType: 'NORMAL_TEXT', textStyle: rgb ? { foregroundColor: { color: { rgbColor: rgb } } } : {} },
                ],
            },
        },
    };
}

function colorRequestsIn(requests) {
    return requests.filter((r) => r.updateTextStyle?.fields === 'foregroundColor');
}

beforeEach(() => {
    fakeDrive = { files: { get: async () => ({ data: { modifiedTime: null } }) } };
});

describe('modifyText — explicit default text color (issue #14)', () => {
    function setUpDocsMock({ rgb = DEFAULT_RGB } = {}) {
        const documentsGet = jest.fn(async ({ fields } = {}) => {
            if (fields === 'namedStyles') return namedStylesResponse(rgb);
            return { data: {} };
        });
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl, requests: requestBody.requests } }));
        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
        return { documentsGet, batchUpdate };
    }

    it('insert: emits a foregroundColor request over the newly inserted range, sourced from NORMAL_TEXT', async () => {
        const documentId = `modify-insert-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock();
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerModifyText(server);
        await server.getTool('modifyText').execute(
            { documentId, target: { insertionIndex: 5 }, text: 'hello' },
            { log: noopLog }
        );

        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        const colorRequests = colorRequestsIn(requests);
        expect(colorRequests).toHaveLength(1);
        expect(colorRequests[0].updateTextStyle.range).toEqual({ startIndex: 5, endIndex: 10 });
        expect(colorRequests[0].updateTextStyle.textStyle.foregroundColor.color.rgbColor).toEqual(DEFAULT_RGB);
    });

    it('replace: colors the newly inserted replacement range, not the deleted one', async () => {
        const documentId = `modify-replace-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock();
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerModifyText(server);
        await server.getTool('modifyText').execute(
            { documentId, target: { startIndex: 5, endIndex: 8 }, text: 'longer replacement' },
            { log: noopLog }
        );

        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        const colorRequests = colorRequestsIn(requests);
        expect(colorRequests).toHaveLength(1);
        expect(colorRequests[0].updateTextStyle.range).toEqual({ startIndex: 5, endIndex: 5 + 'longer replacement'.length });
    });

    it('caller-supplied style.foregroundColor still wins over the default paint', async () => {
        const documentId = `modify-caller-color-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock();
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerModifyText(server);
        await server.getTool('modifyText').execute(
            { documentId, target: { insertionIndex: 5 }, text: 'hi', style: { foregroundColor: '#ff0000' } },
            { log: noopLog }
        );

        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        const colorRequests = colorRequestsIn(requests);
        // Both the default-color paint and the caller's explicit style produce a
        // foregroundColor request; the caller's must be the LAST one applied.
        expect(colorRequests.length).toBeGreaterThanOrEqual(1);
        const last = colorRequests[colorRequests.length - 1];
        expect(last.updateTextStyle.textStyle.foregroundColor.color.rgbColor).toEqual({ red: 1, green: 0, blue: 0 });
    });

    it('theme-color-based NORMAL_TEXT (no rgbColor): inserts inherit-only, no error', async () => {
        const documentId = `modify-theme-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock({ rgb: null });
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerModifyText(server);
        const result = await server.getTool('modifyText').execute(
            { documentId, target: { insertionIndex: 5 }, text: 'hi' },
            { log: noopLog }
        );

        expect(result).toMatch(/Successfully/);
        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        expect(colorRequestsIn(requests)).toHaveLength(0);
    });

    it('style-only calls (no new text) never touch color, even with a resolvable default', async () => {
        const documentId = `modify-style-only-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock();
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerModifyText(server);
        await server.getTool('modifyText').execute(
            { documentId, target: { startIndex: 1, endIndex: 10 }, style: { bold: true } },
            { log: noopLog }
        );

        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        expect(colorRequestsIn(requests)).toHaveLength(0);
    });

    it('does not fail the insertion when the named-styles fetch fails — logs a warning instead', async () => {
        const documentId = `modify-fetch-fail-${Date.now()}`;
        const warn = jest.fn();
        const documentsGet = jest.fn(async ({ fields } = {}) => {
            if (fields === 'namedStyles') throw new Error('boom');
            return { data: {} };
        });
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl, requests: requestBody.requests } }));
        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerModifyText(server);
        const result = await server.getTool('modifyText').execute(
            { documentId, target: { insertionIndex: 1 }, text: 'hi' },
            { log: { ...noopLog, warn } }
        );

        expect(result).toMatch(/Successfully/);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not fetch document default text color/i));
        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        expect(colorRequestsIn(requests)).toHaveLength(0);
    });
});

describe('appendText — explicit default text color (issue #14)', () => {
    function setUpDocsMock({ rgb = DEFAULT_RGB } = {}) {
        const documentsGet = jest.fn(async ({ fields } = {}) => {
            if (fields === 'namedStyles') return namedStylesResponse(rgb);
            return { data: { body: { content: [{ endIndex: 10 }] } } };
        });
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl, requests: requestBody.requests } }));
        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
        return { documentsGet, batchUpdate };
    }

    it('colors the freshly appended range', async () => {
        const documentId = `append-color-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock();
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerAppendText(server);
        await server.getTool('appendText').execute({ documentId, text: 'hello' }, { log: noopLog });

        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        expect(colorRequestsIn(requests)).toHaveLength(1);
    });

    it('no color request when NORMAL_TEXT has no rgb default', async () => {
        const documentId = `append-theme-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock({ rgb: null });
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerAppendText(server);
        await server.getTool('appendText').execute({ documentId, text: 'hello' }, { log: noopLog });

        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        expect(colorRequestsIn(requests)).toHaveLength(0);
    });
});

describe('insertTableWithData — explicit default text color (issue #14)', () => {
    function setUpDocsMock({ rgb = DEFAULT_RGB } = {}) {
        const documentsGet = jest.fn(async ({ fields } = {}) => {
            if (fields === 'namedStyles') return namedStylesResponse(rgb);
            return { data: {} };
        });
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl, requests: requestBody.requests } }));
        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
        return { documentsGet, batchUpdate };
    }

    it('colors populated cells but not empty ones', async () => {
        const documentId = `table-color-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock();
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerInsertTableWithData(server);
        await server.getTool('insertTableWithData').execute(
            { documentId, data: [['a', ''], ['c', 'd']], index: 1 },
            { log: noopLog }
        );

        const allRequests = batchUpdate.mock.calls.flatMap((call) => call[0].requestBody.requests);
        const colorRequests = colorRequestsIn(allRequests);
        // 3 non-empty cells ('a', 'c', 'd') → 3 color requests.
        expect(colorRequests).toHaveLength(3);
    });
});

describe('createDocument (raw contentFormat) — explicit default text color (issue #14)', () => {
    it('paints the raw-inserted initial content with the document default color', async () => {
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { requests: requestBody.requests } }));
        const documentsGet = jest.fn(async ({ fields } = {}) => {
            if (fields === 'namedStyles') return namedStylesResponse();
            return { data: {} };
        });
        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
        fakeDrive = {
            files: {
                create: jest.fn(async () => ({ data: { id: 'doc-1', name: 'Test Doc', webViewLink: 'https://example.com' } })),
            },
        };

        const server = createMockServer();
        registerCreateDocument(server);
        const result = await server.getTool('createDocument').execute(
            { title: 'Test Doc', initialContent: 'raw text', contentFormat: 'raw' },
            { log: noopLog }
        );

        // Two batchUpdate calls: the raw insertText, then the color paint.
        expect(batchUpdate).toHaveBeenCalledTimes(2);
        const insertCallRequests = batchUpdate.mock.calls[0][0].requestBody.requests;
        expect(insertCallRequests[0].insertText.text).toBe('raw text');
        const colorCallRequests = batchUpdate.mock.calls[1][0].requestBody.requests;
        expect(colorRequestsIn(colorCallRequests)).toHaveLength(1);
        expect(colorCallRequests[0].updateTextStyle.range).toEqual({ startIndex: 1, endIndex: 1 + 'raw text'.length });

        const parsed = JSON.parse(result);
        expect(parsed.warnings).toBeUndefined();
    });

    it('surfaces a failed color update as a warning instead of silently succeeding unset', async () => {
        const batchUpdate = jest.fn(async ({ requestBody }) => {
            if (requestBody.requests[0]?.updateTextStyle) throw new Error('color update failed');
            return { data: { requests: requestBody.requests } };
        });
        const documentsGet = jest.fn(async ({ fields } = {}) => {
            if (fields === 'namedStyles') return namedStylesResponse();
            return { data: {} };
        });
        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
        fakeDrive = {
            files: {
                create: jest.fn(async () => ({ data: { id: 'doc-2', name: 'Test Doc 2', webViewLink: 'https://example.com' } })),
            },
        };

        const server = createMockServer();
        registerCreateDocument(server);
        const result = await server.getTool('createDocument').execute(
            { title: 'Test Doc 2', initialContent: 'raw text', contentFormat: 'raw' },
            { log: noopLog }
        );

        const parsed = JSON.parse(result);
        // The document and its raw text still exist — only the color paint failed.
        expect(parsed.id).toBe('doc-2');
        expect(parsed.warnings.join(' ')).toMatch(/default text color/i);
    });
});

describe('findAndReplace / createDocumentFromTemplate — no extra style request (issue #14 audit)', () => {
    it('findAndReplace emits only its replaceAllText request — replaceAllText inherits the style of the text it replaces', async () => {
        const documentId = `far-nocolor-${Date.now()}`;
        const documentsGet = jest.fn(async () => ({ data: {} }));
        const batchUpdate = jest.fn(async ({ requestBody }) => ({
            data: { writeControl: requestBody.writeControl, replies: [{ replaceAllText: { occurrencesChanged: 1 } }] },
        }));
        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerFindAndReplace(server);
        await server.getTool('findAndReplace').execute({ documentId, findText: 'foo', replaceText: 'bar' }, { log: noopLog });

        expect(batchUpdate).toHaveBeenCalledTimes(1);
        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        expect(requests).toHaveLength(1);
        expect(requests[0]).toHaveProperty('replaceAllText');
        // No documents.get call for namedStyles: this path never fetches a default color.
        expect(documentsGet.mock.calls.some((call) => call[0]?.fields === 'namedStyles')).toBe(false);
    });

    it('createDocumentFromTemplate emits only replaceAllText requests, no color styling', async () => {
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { requests: requestBody.requests } }));
        const documentsGet = jest.fn(async () => ({ data: {} }));
        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
        fakeDrive = {
            files: {
                copy: jest.fn(async () => ({ data: { id: 'copy-1', name: 'Copy', webViewLink: 'https://example.com' } })),
            },
        };

        const server = createMockServer();
        registerCreateFromTemplate(server);
        await server.getTool('createDocumentFromTemplate').execute(
            { templateId: 'template-1', newTitle: 'Copy', replacements: { '{{NAME}}': 'Alice' } },
            { log: noopLog }
        );

        expect(batchUpdate).toHaveBeenCalledTimes(1);
        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        expect(requests.every((r) => 'replaceAllText' in r)).toBe(true);
        expect(documentsGet.mock.calls.some((call) => call[0]?.fields === 'namedStyles')).toBe(false);
    });
});
