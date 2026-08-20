// End-to-end coverage for plan-PR3: the read-handle capability, its guard, and
// per-handle workspace ownership (docs/plans/mcp-2026-07-28-migration.md §2/§3).
//
// Everything here drives the REAL SDK v2 facade (dist/mcpServer.js) over real
// wire requests, with only dist/clients.js mocked -- readHandles.js,
// requestContext.js, handleRuntime.js, docsHandles.js, readTracker.js, the
// tools, and the workspace filesystem layer all run for real. Following
// tests/mcpServerFacade.test.js for the wire helpers and
// tests/mutatingDocsToolsWriteControl.test.js for the Google client mocks.
import { describe, expect, it, jest, beforeEach, afterEach, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { z } from 'zod';

// Point the whole workspace layer at a throwaway sandbox before anything reads
// it, so these tests never touch the real per-user working-copy directory.
const WORKSPACE_ROOT = path.join(os.tmpdir(), `gt-mcp-handles-${process.pid}-${Date.now()}`);
process.env.GOOGLE_MCP_WORKSPACE_DIR = WORKSPACE_ROOT;

const TOKEN = 'read-handle-integration-token-aaaaaaaaaaaa';
const OTHER_TOKEN = 'read-handle-integration-token-bbbbbbbbbbbb';

let fakeDocs;
let fakeDrive;
let fakeSheets;

const unusedClient = async () => { throw new Error('client not used in this suite'); };
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => fakeDocs,
    getDriveClient: async () => fakeDrive,
    getSheetsClient: async () => fakeSheets,
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

const {
    createV2HttpHandler, prepareMcpServerFactory, startV2Stdio, MCP_PROTOCOL_VERSION,
} = await import('../dist/mcpServer.js');
const { register: registerReadDocument } = await import('../dist/tools/docs/readGoogleDoc.js');
const { register: registerAppendText } = await import('../dist/tools/docs/appendToGoogleDoc.js');
const { register: registerReadSpreadsheet } = await import('../dist/tools/sheets/readSpreadsheet.js');
const { register: registerWriteSpreadsheet } = await import('../dist/tools/sheets/writeSpreadsheet.js');
const { beginDocsMutation } = await import('../dist/docsHandles.js');
const { cleanupHandleWorkspaces, resetHandleRuntimeState } = await import('../dist/handleRuntime.js');

const V2_ROOT = path.join(WORKSPACE_ROOT, 'v2-handles');
const BASELINE_DIR = path.join(V2_ROOT, 'baselines');

const DOC_ID = 'handle-doc-1';
const REVISION = 'rev-read-1';

// --- Google client fakes ----------------------------------------------------

function docPayload(text = 'Hello world\n', revisionId = REVISION) {
    return {
        data: {
            revisionId,
            body: { content: [{ startIndex: 1, endIndex: text.length + 1, paragraph: { elements: [{ startIndex: 1, endIndex: text.length + 1, textRun: { content: text } }] } }] },
        },
    };
}

let batchUpdate;
let documentsGet;

function setUpGoogleMocks({ text = 'Hello world\n', revisionId = REVISION } = {}) {
    documentsGet = jest.fn(async () => docPayload(text, revisionId));
    batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl ?? { requiredRevisionId: 'rev-after-write' } } }));
    fakeDocs = { documents: { get: documentsGet, batchUpdate } };
    fakeDrive = { files: { get: async () => ({ data: { modifiedTime: null } }) } };
    fakeSheets = {};
}

// A test-only tool that exercises the beginDocsMutation seam directly. It is
// the only way to cover `expectedRevisionId` today, because #108 has not landed
// and no shipped tool declares that parameter yet.
function registerProbe(server) {
    server.addTool({
        name: 'probeWrite',
        description: 'test probe',
        parameters: z.object({
            documentId: z.string(),
            readHandle: z.string().optional(),
            expectedRevisionId: z.string().optional(),
        }),
        execute: async (args) => {
            const lease = await beginDocsMutation(args.documentId, {
                tabId: null,
                readHandle: args.readHandle,
                expectedRevisionId: args.expectedRevisionId ?? null,
            });
            const response = await lease.write(
                (writeControl) => fakeDocs.documents.batchUpdate({
                    documentId: args.documentId,
                    requestBody: { requests: [{ insertText: { location: { index: 1 }, text: 'probe' } }], ...(writeControl && { writeControl }) },
                }),
                (result) => result?.data?.writeControl?.requiredRevisionId,
            );
            return `probe-ok:${JSON.stringify(response.data.writeControl ?? null)}`;
        },
    });
}

async function buildFactory() {
    return prepareMcpServerFactory({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        registerTools: async (server) => {
            registerReadDocument(server);
            registerAppendText(server);
            registerReadSpreadsheet(server);
            registerWriteSpreadsheet(server);
            registerProbe(server);
        },
    });
}

// --- wire helpers -----------------------------------------------------------

function modernCall(name, args, token = TOKEN) {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${token}`,
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

async function call(handler, name, args, token = TOKEN) {
    const response = await handler.fetch(modernCall(name, args, token));
    const body = await response.json();
    return body.result;
}

function textOf(result) {
    return result.content.map((entry) => entry.text ?? '').join('');
}

function localPathFrom(result) {
    const match = textOf(result).match(/Local file: (.+)\n/);
    return match ? match[1] : null;
}

function stdioMessages(output) {
    let buffer = '';
    const pending = [];
    const messages = [];
    output.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const message = JSON.parse(line);
            const waiter = pending.shift();
            if (waiter) waiter(message); else messages.push(message);
        }
    });
    return () => (messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => pending.push(resolve)));
}

async function listBaselines() {
    try {
        return (await fs.readdir(BASELINE_DIR)).sort();
    } catch {
        return [];
    }
}

const realDateNow = Date.now;

beforeEach(() => {
    setUpGoogleMocks();
});

afterEach(() => {
    Date.now = realDateNow;
    resetHandleRuntimeState();
});

afterAll(async () => {
    await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------

describe('v2 HTTP: reads mint handles and handles authorize writes', () => {
    it('returns readHandle as a top-level result field for every format', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            // 'index' included: a structural index read is still a read, and it
            // must authorize the mutation that follows (issue #105).
            for (const format of ['markdown', 'text', 'json', 'index']) {
                const read = await call(handler, 'readDocument', { documentId: DOC_ID, format });
                expect(read.readHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
                expect(read.structuredContent.readHandle).toBe(read.readHandle);
                expect(read.structuredContent.readHandleExpiresAt).toBeGreaterThan(realDateNow());
                // Under 24h, per the plan's expiry bound.
                expect(read.structuredContent.readHandleExpiresAt - realDateNow())
                    .toBeLessThan(24 * 60 * 60 * 1000);
            }
        } finally { await handler.close(); }
    });

    it('carries the validated record revision into WriteControl.requiredRevisionId', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const write = await call(handler, 'appendText', {
                documentId: DOC_ID, text: 'appended', readHandle: read.readHandle,
            });
            expect(write.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalledTimes(1);
            expect(batchUpdate.mock.calls[0][0].requestBody.writeControl)
                .toEqual({ requiredRevisionId: REVISION });
            // A successful write mints the successor capability and surfaces it.
            expect(write.readHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(write.readHandle).not.toBe(read.readHandle);
        } finally { await handler.close(); }
    });

    it('rejects a consumed handle on replay without reaching Google', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            await call(handler, 'appendText', { documentId: DOC_ID, text: 'one', readHandle: read.readHandle });
            batchUpdate.mockClear();
            const replay = await call(handler, 'appendText', { documentId: DOC_ID, text: 'two', readHandle: read.readHandle });
            expect(replay.isError).toBe(true);
            expect(textOf(replay)).toMatch(/already been consumed/i);
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally { await handler.close(); }
    });
});

describe('v2 HTTP: a mutation without a valid handle fails before any Google write', () => {
    it('refuses a guarded Docs mutation with no readHandle', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            batchUpdate.mockClear();
            const write = await call(handler, 'appendText', { documentId: DOC_ID, text: 'no handle' });
            expect(write.isError).toBe(true);
            expect(textOf(write)).toMatch(/requires a readHandle/i);
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally { await handler.close(); }
    });

    it('refuses even when a current expectedRevisionId is supplied without a handle', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const probe = await call(handler, 'probeWrite', { documentId: DOC_ID, expectedRevisionId: REVISION });
            expect(probe.isError).toBe(true);
            expect(textOf(probe)).toMatch(/requires a readHandle/i);
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally { await handler.close(); }
    });

    it('rejects an expectedRevisionId that disagrees with the handle record, and honours one that agrees', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const stale = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const mismatch = await call(handler, 'probeWrite', {
                documentId: DOC_ID, readHandle: stale.readHandle, expectedRevisionId: 'rev-something-else',
            });
            expect(mismatch.isError).toBe(true);
            expect(textOf(mismatch)).toMatch(/does not match the revision/i);
            expect(batchUpdate).not.toHaveBeenCalled();

            // The same handle is still usable once the assertion agrees, and the
            // WriteControl value comes from the record rather than the input.
            const ok = await call(handler, 'probeWrite', {
                documentId: DOC_ID, readHandle: stale.readHandle, expectedRevisionId: REVISION,
            });
            expect(ok.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalledTimes(1);
            expect(batchUpdate.mock.calls[0][0].requestBody.writeControl)
                .toEqual({ requiredRevisionId: REVISION });
        } finally { await handler.close(); }
    });

    it('rejects an unknown, malformed, or guessed high-entropy handle', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const guesses = [
                'A'.repeat(43),
                'not-a-handle',
                Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64url'),
            ];
            for (const guess of guesses) {
                const write = await call(handler, 'appendText', { documentId: DOC_ID, text: 'x', readHandle: guess });
                expect(write.isError).toBe(true);
                expect(textOf(write)).toMatch(/not recognized|no longer valid|required/i);
            }
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally { await handler.close(); }
    });

    it('rejects a handle bound to a different file or tab', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const wrongFile = await call(handler, 'appendText', {
                documentId: 'a-different-document', text: 'x', readHandle: read.readHandle,
            });
            expect(wrongFile.isError).toBe(true);
            expect(textOf(wrongFile)).toMatch(/does not match this request or resource/i);

            const wrongTab = await call(handler, 'appendText', {
                documentId: DOC_ID, tabId: 'tab-that-was-not-read', text: 'x', readHandle: read.readHandle,
            });
            expect(wrongTab.isError).toBe(true);
            expect(textOf(wrongTab)).toMatch(/does not match this request or resource/i);
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally { await handler.close(); }
    });

    it('rejects an expired handle', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const base = realDateNow();
            Date.now = () => base + (24 * 60 * 60 * 1000);
            const write = await call(handler, 'appendText', { documentId: DOC_ID, text: 'x', readHandle: read.readHandle });
            expect(write.isError).toBe(true);
            expect(textOf(write)).toMatch(/expired/i);
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally { Date.now = realDateNow; await handler.close(); }
    });

    it('rejects a handle presented under a different principal fingerprint, and invalidates on rotation', async () => {
        const factory = await buildFactory();
        // One process, one endpoint, two different configured bearer tokens ==
        // the token-rotation case: the fingerprint changes, so every handle
        // minted under the old one is invalidated before it can authorize a write.
        const original = createV2HttpHandler(factory, { auth: { token: TOKEN }, profile: 'p1', epoch: 'e1' });
        const rotated = createV2HttpHandler(factory, { auth: { token: OTHER_TOKEN }, profile: 'p1', epoch: 'e1' });
        try {
            const read = await call(original, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const stolen = await call(rotated, 'appendText', { documentId: DOC_ID, text: 'x', readHandle: read.readHandle }, OTHER_TOKEN);
            expect(stolen.isError).toBe(true);
            expect(batchUpdate).not.toHaveBeenCalled();

            // ... and the pre-rotation holder cannot use it afterwards either.
            const afterRotation = await call(original, 'appendText', { documentId: DOC_ID, text: 'x', readHandle: read.readHandle });
            expect(afterRotation.isError).toBe(true);
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally { await original.close(); await rotated.close(); }
    });

    it('rejects a handle minted under a different configured Google profile', async () => {
        const factory = await buildFactory();
        const profileA = createV2HttpHandler(factory, { auth: { token: TOKEN }, profile: 'work', epoch: 'e1' });
        const profileB = createV2HttpHandler(factory, { auth: { token: TOKEN }, profile: 'personal', epoch: 'e1' });
        try {
            const read = await call(profileA, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const crossProfile = await call(profileB, 'appendText', { documentId: DOC_ID, text: 'x', readHandle: read.readHandle });
            expect(crossProfile.isError).toBe(true);
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally { await profileA.close(); await profileB.close(); }
    });

    it('never stores or returns raw credential material alongside a handle', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const serialized = JSON.stringify(read);
            expect(serialized).not.toContain(TOKEN);
            expect(serialized).not.toContain('Bearer');
        } finally { await handler.close(); }
    });
});

describe('v2 HTTP: one request\'s read can never authorize another request\'s mutation', () => {
    // The regression this whole PR exists for. Before the readTracker request
    // scoping below, both requests fell into readTracker's shared DEFAULT_SESSION
    // namespace, so B's guardMutation found A's entry and authorized B's write.
    it('does not let request A\'s Docs read authorize request B\'s Docs mutation', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            // Request A: a full read of the document, populating every tracker field.
            const readA = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            expect(readA.readHandle).toBeTruthy();
            batchUpdate.mockClear();

            // Request B: an independent authenticated request that never read the
            // document and presents no handle.
            const writeB = await call(handler, 'appendText', { documentId: DOC_ID, text: 'from B' });
            expect(writeB.isError).toBe(true);
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally { await handler.close(); }
    });

    it('fails closed on guarded Sheets surfaces that have no handle wiring yet', async () => {
        const factory = await buildFactory();
        const writeRange = jest.fn(async () => ({ updatedCells: 1, updatedRows: 1, updatedColumns: 1 }));
        fakeSheets = {
            spreadsheets: {
                values: {
                    get: jest.fn(async () => ({ data: { values: [['a']] } })),
                    update: writeRange,
                },
            },
        };
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            // Request A reads the spreadsheet (trackRead runs for real).
            const readA = await call(handler, 'readSpreadsheet', { spreadsheetId: 'sheet-1', range: 'A1:B2' });
            expect(readA.isError).toBeFalsy();

            // Request B mutates it without ever reading it. It must fail closed
            // rather than borrow A's tracker entry.
            const writeB = await call(handler, 'writeSpreadsheet', {
                spreadsheetId: 'sheet-1', range: 'A1:B2', values: [['x']],
            });
            expect(writeB.isError).toBe(true);
            expect(textOf(writeB)).toMatch(/has not been read in this request/i);
            expect(writeRange).not.toHaveBeenCalled();
        } finally { await handler.close(); }
    });
});

describe('v2 stdio: implicit state is pinned to one connection', () => {
    async function stdioClient(factory, epoch) {
        const input = new PassThrough();
        const output = new PassThrough();
        const runtime = startV2Stdio(factory, {
            input, output, epoch, profile: 'default', logger: { info() {}, warn() {}, error() {} },
        });
        const next = stdioMessages(output);
        const meta = {
            'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientCapabilities': {},
        };
        let id = 0;
        const send = async (name, args) => {
            id += 1;
            input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, _meta: meta } })}\n`);
            return (await next()).result;
        };
        return { runtime, send };
    }

    it('lets a mutation resolve the connection\'s own last read, and denies a second connection', async () => {
        const factory = await buildFactory();
        // A shared epoch keeps this test about connection pinning rather than
        // about the per-start epoch rotation covered above.
        const first = await stdioClient(factory, 'stdio-shared-epoch');
        const second = await stdioClient(factory, 'stdio-shared-epoch');
        try {
            const read = await first.send('readDocument', { documentId: DOC_ID, format: 'markdown' });
            expect(read.readHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);

            // No explicit handle: the pinned connection resolves its own state.
            const implicitWrite = await first.send('appendText', { documentId: DOC_ID, text: 'implicit' });
            expect(implicitWrite.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalledTimes(1);
            expect(batchUpdate.mock.calls[0][0].requestBody.writeControl)
                .toEqual({ requiredRevisionId: REVISION });

            batchUpdate.mockClear();
            // The second connection has no implicit state of its own and cannot
            // reach the first connection's.
            const otherConnection = await second.send('appendText', { documentId: DOC_ID, text: 'stolen' });
            expect(otherConnection.isError).toBe(true);
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally {
            await first.runtime.close();
            await second.runtime.close();
        }
    });
});

describe('workspace ownership: unique editable copies over shared immutable baselines', () => {
    it('gives two identical reads distinct editable files backed by one baseline', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const readA = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const readB = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const pathA = localPathFrom(readA);
            const pathB = localPathFrom(readB);

            expect(pathA).toBeTruthy();
            expect(pathB).toBeTruthy();
            expect(pathA).not.toBe(pathB);
            expect(await fs.readFile(pathA, 'utf-8')).toBe(await fs.readFile(pathB, 'utf-8'));
            // Identical content, one immutable baseline shared between them.
            expect(await listBaselines()).toHaveLength(1);

            // An edit through A's workspace is invisible in B's.
            await fs.writeFile(pathA, 'edited only in A', 'utf-8');
            expect(await fs.readFile(pathB, 'utf-8')).toBe('Hello world');
        } finally { await handler.close(); }
    });

    it('preserves a dirty workspace through expiry cleanup and reclaims clean unreferenced baselines', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const readA = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const readB = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const pathA = localPathFrom(readA);
            const pathB = localPathFrom(readB);

            // A third read of *different* content gets its own baseline.
            setUpGoogleMocks({ text: 'Totally different content\n', revisionId: 'rev-read-2' });
            const readC = await call(handler, 'readDocument', { documentId: 'handle-doc-2', format: 'markdown' });
            const pathC = localPathFrom(readC);
            expect(await listBaselines()).toHaveLength(2);

            // The caller edits A's working copy but never pushes it.
            await fs.writeFile(pathA, '# rewritten and unsaved', 'utf-8');

            const base = realDateNow();
            Date.now = () => base + (24 * 60 * 60 * 1000);
            const cleaned = await cleanupHandleWorkspaces();

            // Dirty A survives and is reported; clean B and C are reclaimed.
            expect(cleaned.retained.map((entry) => entry.editablePath)).toEqual([pathA]);
            expect(cleaned.removed).toHaveLength(2);
            await expect(fs.readFile(pathA, 'utf-8')).resolves.toBe('# rewritten and unsaved');
            await expect(fs.access(pathB)).rejects.toBeDefined();
            await expect(fs.access(pathC)).rejects.toBeDefined();

            // C's baseline had no other reference and is gone; A still holds the
            // shared one, so that baseline is retained.
            expect(await listBaselines()).toHaveLength(1);
        } finally { Date.now = realDateNow; await handler.close(); }
    });

    it('retains a dirty workspace when the Google write fails after the guard passed', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const editable = localPathFrom(read);
            await fs.writeFile(editable, 'unsaved local edit', 'utf-8');
            batchUpdate.mockImplementation(async () => { throw new Error('backend exploded'); });

            const write = await call(handler, 'appendText', { documentId: DOC_ID, text: 'x', readHandle: read.readHandle });
            expect(write.isError).toBe(true);
            // The file the caller was editing is still there to recover from.
            await expect(fs.readFile(editable, 'utf-8')).resolves.toBe('unsaved local edit');
        } finally { await handler.close(); }
    });

    it('reclaims clean workspaces on shutdown and starts the next runtime fresh', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
        const editable = localPathFrom(read);
        await handler.close();

        await expect(fs.access(editable)).rejects.toBeDefined();
        expect(await listBaselines()).toHaveLength(0);

        // A restart in the same process must not honour the previous run's handle.
        const restarted = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const write = await call(restarted, 'appendText', { documentId: DOC_ID, text: 'x', readHandle: read.readHandle });
            expect(write.isError).toBe(true);
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally { await restarted.close(); }
    });
});
