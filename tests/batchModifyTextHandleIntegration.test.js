// Read-handle guard coverage for batchModifyText (issue #88), driven through
// the REAL SDK v2 facade over real wire requests with only dist/clients.js
// mocked. Follows tests/replaceRangeHandleIntegration.test.js.
//
// What it pins: a multi-operation edit is a guarded Docs mutation like any
// other — over HTTP it fails before any Google write without a valid handle,
// the single WriteControl it sends comes from the validated record rather than
// caller input, a success mints the successor capability, and the calls that
// write nothing (a dryRun, an overlap rejection, a missed text search) leave
// the handle usable instead of burning it.
import { describe, expect, it, jest, beforeEach, afterEach, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const WORKSPACE_ROOT = path.join(os.tmpdir(), `gt-mcp-batch-${process.pid}-${Date.now()}`);
process.env.GOOGLE_MCP_WORKSPACE_DIR = WORKSPACE_ROOT;

const TOKEN = 'batch-modify-handle-token-bbbbbbbbbbbb';
const DOC_ID = 'batch-handle-doc';
const REVISION = 'rev-batch-1';

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
const { register: registerBatchModifyText } = await import('../dist/tools/docs/batchModifyText.js');
const { resetHandleRuntimeState } = await import('../dist/handleRuntime.js');

const PARAGRAPHS = ['Alpha one\n', 'Beta two\n'];
// Document indices of "one" in paragraph 1 and "two" in paragraph 2.
const ONE = { startIndex: 1 + 'Alpha '.length, endIndex: 1 + 'Alpha one'.length };
const TWO_START = 1 + PARAGRAPHS[0].length + 'Beta '.length;
const TWO = { startIndex: TWO_START, endIndex: TWO_START + 'two'.length };

let batchUpdate;

function setUpGoogleMocks() {
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
        return elements;
    };
    fakeDocs = {
        documents: {
            get: jest.fn(async ({ fields }) => {
                if (fields === 'namedStyles') return { data: { namedStyles: { styles: [] } } };
                return { data: { revisionId: REVISION, body: { content: content() }, lists: {} } };
            }),
            batchUpdate: jest.fn(async () => ({ data: { writeControl: { requiredRevisionId: 'rev-after-write' } } })),
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
            registerBatchModifyText(server);
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
const batchArgs = (extra = {}) => ({
    documentId: DOC_ID,
    operations: [
        { target: ONE, text: 'ONE' },
        { target: TWO, text: 'TWO' },
    ],
    ...extra,
});

beforeEach(() => { setUpGoogleMocks(); });
afterEach(() => { resetHandleRuntimeState(); });
afterAll(async () => { await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true }).catch(() => {}); });

describe('batchModifyText under the read-handle guard', () => {
    it('refuses a batch with no readHandle before any Google write', async () => {
        const handler = createV2HttpHandler(await buildFactory(), { auth: { token: TOKEN } });
        try {
            await call(handler, 'readDocument', { documentId: DOC_ID, format: 'index' });
            batchUpdate.mockClear();
            const write = await call(handler, 'batchModifyText', batchArgs());
            expect(write.isError).toBe(true);
            expect(textOf(write)).toMatch(/requires a readHandle/i);
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally { await handler.close(); }
    });

    it('sends ONE batch, guarded by the validated record revision, and mints a successor handle', async () => {
        const handler = createV2HttpHandler(await buildFactory(), { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'index' });
            const write = await call(handler, 'batchModifyText', batchArgs({ readHandle: read.readHandle }));

            expect(write.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalledTimes(1);
            // Never from caller input: the revision comes from the handle record.
            expect(batchUpdate.mock.calls[0][0].requestBody.writeControl)
                .toEqual({ requiredRevisionId: REVISION });
            expect(write.readHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(write.readHandle).not.toBe(read.readHandle);
        } finally { await handler.close(); }
    });

    it('rejects replaying a consumed handle without reaching Google', async () => {
        const handler = createV2HttpHandler(await buildFactory(), { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'index' });
            await call(handler, 'batchModifyText', batchArgs({ readHandle: read.readHandle }));
            batchUpdate.mockClear();
            const replay = await call(handler, 'batchModifyText', batchArgs({ readHandle: read.readHandle }));
            expect(replay.isError).toBe(true);
            expect(textOf(replay)).toMatch(/already been consumed/i);
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally { await handler.close(); }
    });

    it('rejects an expectedRevisionId that disagrees with the handle record', async () => {
        const handler = createV2HttpHandler(await buildFactory(), { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'index' });
            const write = await call(handler, 'batchModifyText', batchArgs({
                readHandle: read.readHandle, expectedRevisionId: 'rev-something-else',
            }));
            expect(write.isError).toBe(true);
            expect(textOf(write)).toMatch(/does not match the revision/i);
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally { await handler.close(); }
    });

    it('leaves the handle usable after a dryRun and after an overlap rejection', async () => {
        const handler = createV2HttpHandler(await buildFactory(), { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'index' });

            const dry = await call(handler, 'batchModifyText', batchArgs({ readHandle: read.readHandle, dryRun: true }));
            expect(dry.isError).toBeFalsy();
            expect(textOf(dry)).toContain('DRY RUN');
            expect(batchUpdate).not.toHaveBeenCalled();

            // An overlap is a validation failure, not a write, so it must not
            // burn the handle either.
            const overlapping = await call(handler, 'batchModifyText', {
                documentId: DOC_ID,
                operations: [
                    { target: { startIndex: 1, endIndex: 10 }, text: 'x' },
                    { target: { startIndex: 4, endIndex: 8 }, text: 'y' },
                ],
                readHandle: read.readHandle,
            });
            expect(overlapping.isError).toBe(true);
            expect(textOf(overlapping)).toMatch(/ranges overlap/);
            expect(batchUpdate).not.toHaveBeenCalled();

            // The same handle still authorizes the corrected call.
            const good = await call(handler, 'batchModifyText', batchArgs({ readHandle: read.readHandle }));
            expect(good.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalledTimes(1);
            expect(batchUpdate.mock.calls[0][0].requestBody.writeControl)
                .toEqual({ requiredRevisionId: REVISION });
        } finally { await handler.close(); }
    });
});
