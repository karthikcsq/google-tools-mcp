// Read-handle guard coverage for replaceRangeWithMarkdown (issue #107), driven
// through the REAL SDK v2 facade over real wire requests with only
// dist/clients.js mocked. Follows tests/readHandleIntegration.test.js.
//
// What it pins: a section-scoped markdown replace is a guarded Docs mutation
// like any other — over HTTP it fails before any Google write without a valid
// handle, the WriteControl it sends comes from the validated record rather than
// caller input, a success mints the successor capability, and a dryRun (which
// writes nothing) leaves the handle usable instead of burning it.
import { describe, expect, it, jest, beforeEach, afterEach, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const WORKSPACE_ROOT = path.join(os.tmpdir(), `gt-mcp-range-${process.pid}-${Date.now()}`);
process.env.GOOGLE_MCP_WORKSPACE_DIR = WORKSPACE_ROOT;

const TOKEN = 'replace-range-handle-token-aaaaaaaaaaaa';
const DOC_ID = 'range-handle-doc';
const REVISION = 'rev-range-1';

let fakeDocs;
let fakeDrive;
const unusedClient = async () => { throw new Error('client not used in this suite'); };
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => fakeDocs,
    getDriveClient: async () => fakeDrive,
    getSheetsClient: unusedClient,
    getAuthClient: unusedClient,
    getAuthClientIfReady: () => null,
    getCalendarClient: unusedClient,
    getFormsClient: unusedClient,
    getGmailClient: unusedClient,
    getScriptClient: unusedClient,
    getSlidesClient: unusedClient,
    getTasksClient: unusedClient,
    resetClients: () => {},
    withAuthRetry: (fn) => fn(),
}));

const { createV2HttpHandler, prepareMcpServerFactory, MCP_PROTOCOL_VERSION } = await import('../dist/mcpServer.js');
const { register: registerReadDocument } = await import('../dist/tools/docs/readGoogleDoc.js');
const { register: registerReplaceRange } = await import('../dist/tools/docs/replaceRangeWithMarkdown.js');
const { resetHandleRuntimeState } = await import('../dist/handleRuntime.js');

// "Alpha\n" then "Beta\n": the first paragraph is the range under test, the
// second is the content that must survive.
const PARAGRAPHS = ['Alpha\n', 'Beta\n'];
const RANGE_START = 1;
const RANGE_END = 1 + PARAGRAPHS[0].length;

let batchUpdate;

function setUpGoogleMocks() {
    let growth = 0;
    let currentRevisionId = REVISION;
    const content = () => {
        const elements = [];
        let index = 1;
        for (const text of PARAGRAPHS) {
            elements.push({
                startIndex: index,
                endIndex: index + text.length,
                paragraph: { elements: [{ startIndex: index, endIndex: index + text.length, textRun: { content: text } }] },
            });
            index += text.length;
        }
        const last = elements[elements.length - 1];
        return [...elements.slice(0, -1), { ...last, endIndex: last.endIndex + growth }];
    };
    fakeDocs = {
        documents: {
            get: jest.fn(async ({ fields }) => {
                if (fields === 'namedStyles') return { data: { namedStyles: { styles: [] } } };
                return { data: { revisionId: currentRevisionId, body: { content: content() }, lists: {} } };
            }),
            batchUpdate: jest.fn(async ({ requestBody }) => {
                for (const request of requestBody.requests) {
                    if (request.insertText) growth += request.insertText.text.length;
                    if (request.deleteContentRange) {
                        growth -= request.deleteContentRange.range.endIndex - request.deleteContentRange.range.startIndex;
                    }
                }
                currentRevisionId = 'rev-after-write';
                return { data: { writeControl: { requiredRevisionId: currentRevisionId } } };
            }),
        },
    };
    batchUpdate = fakeDocs.documents.batchUpdate;
    fakeDrive = { files: { get: async () => ({ data: { modifiedTime: null } }) } };
}

async function buildFactory() {
    return prepareMcpServerFactory({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        registerTools: async (server) => {
            registerReadDocument(server);
            registerReplaceRange(server);
        },
    });
}

function modernCall(name, args) {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            'mcp-protocol-version': MCP_PROTOCOL_VERSION,
            'mcp-method': 'tools/call',
            'mcp-name': name,
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name,
                arguments: args,
                _meta: {
                    'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
                    'io.modelcontextprotocol/clientCapabilities': {},
                },
            },
        }),
    });
}

async function call(handler, name, args) {
    const response = await handler.fetch(modernCall(name, args));
    return (await response.json()).result;
}

const textOf = (result) => result.content.map((entry) => entry.text ?? '').join('');
const replaceArgs = (extra = {}) => ({
    documentId: DOC_ID,
    target: { startIndex: RANGE_START, endIndex: RANGE_END },
    markdown: '- rewritten\n',
    ...extra,
});

beforeEach(() => { setUpGoogleMocks(); });
afterEach(() => { resetHandleRuntimeState(); });
afterAll(async () => { await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true }).catch(() => {}); });

describe('replaceRangeWithMarkdown under the read-handle guard', () => {
    it('refuses a range replace with no readHandle before any Google write', async () => {
        const handler = createV2HttpHandler(await buildFactory(), { auth: { token: TOKEN } });
        try {
            await call(handler, 'readDocument', { documentId: DOC_ID, format: 'index' });
            batchUpdate.mockClear();
            const write = await call(handler, 'replaceRangeWithMarkdown', replaceArgs());
            expect(write.isError).toBe(true);
            expect(textOf(write)).toMatch(/requires a readHandle/i);
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally { await handler.close(); }
    });

    it('carries the validated record revision into every batch and mints a successor handle', async () => {
        const handler = createV2HttpHandler(await buildFactory(), { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'index' });
            const write = await call(handler, 'replaceRangeWithMarkdown', replaceArgs({ readHandle: read.readHandle }));
            expect(write.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalled();
            // The first write is guarded by the revision the read saw...
            expect(batchUpdate.mock.calls[0][0].requestBody.writeControl)
                .toEqual({ requiredRevisionId: REVISION });
            // ...and each later batch by the revision the previous one returned.
            for (const invocation of batchUpdate.mock.calls.slice(1)) {
                expect(invocation[0].requestBody.writeControl)
                    .toEqual({ requiredRevisionId: 'rev-after-write' });
            }
            // A successful write consumes the handle and mints its successor.
            expect(write.readHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(write.readHandle).not.toBe(read.readHandle);
        } finally { await handler.close(); }
    });

    it('rejects replaying a consumed handle without reaching Google', async () => {
        const handler = createV2HttpHandler(await buildFactory(), { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'index' });
            await call(handler, 'replaceRangeWithMarkdown', replaceArgs({ readHandle: read.readHandle }));
            batchUpdate.mockClear();
            const replay = await call(handler, 'replaceRangeWithMarkdown', replaceArgs({ readHandle: read.readHandle }));
            expect(replay.isError).toBe(true);
            expect(textOf(replay)).toMatch(/already been consumed/i);
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally { await handler.close(); }
    });

    it('rejects an expectedRevisionId that disagrees with the handle record', async () => {
        const handler = createV2HttpHandler(await buildFactory(), { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'index' });
            const write = await call(handler, 'replaceRangeWithMarkdown', replaceArgs({
                readHandle: read.readHandle, expectedRevisionId: 'rev-something-else',
            }));
            expect(write.isError).toBe(true);
            expect(textOf(write)).toMatch(/does not match the revision/i);
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally { await handler.close(); }
    });

    it('leaves the handle usable after a dryRun and after a range that fails validation', async () => {
        const handler = createV2HttpHandler(await buildFactory(), { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'index' });

            const dry = await call(handler, 'replaceRangeWithMarkdown', replaceArgs({
                readHandle: read.readHandle, dryRun: true,
            }));
            expect(dry.isError).toBeFalsy();
            expect(textOf(dry)).toContain('DRY RUN');
            expect(batchUpdate).not.toHaveBeenCalled();

            // A bad range is not a write either, so it must not burn the handle.
            const bad = await call(handler, 'replaceRangeWithMarkdown', {
                documentId: DOC_ID,
                target: { startIndex: 1, endIndex: 9999 },
                markdown: '- x\n',
                readHandle: read.readHandle,
            });
            expect(bad.isError).toBe(true);
            expect(textOf(bad)).toMatch(/runs past the end/);

            // The same handle still authorizes the corrected call.
            const good = await call(handler, 'replaceRangeWithMarkdown', replaceArgs({ readHandle: read.readHandle }));
            expect(good.isError).toBeFalsy();
            expect(batchUpdate.mock.calls[0][0].requestBody.writeControl)
                .toEqual({ requiredRevisionId: REVISION });
        } finally { await handler.close(); }
    });
});
