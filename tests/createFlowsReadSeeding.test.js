// #87 gap 2: createDocument and createFromTemplate created a document but
// seeded no read state, so an immediate follow-up mutation was rejected as
// "unread" even though the tool call itself had just produced the document's
// exact content. This suite proves both creators now seed post-create read
// state on success (createDocument always; createFromTemplate only when its
// content ends in a fully-known state), on both stdio implicit state and v2
// HTTP explicit readHandle, and that flows the plan leaves deliberately
// unsupported (a failed template replacement) stay unseeded and explicit.
//
// Drives the real SDK v2 facade (dist/mcpServer.js) the same way
// tests/readHandleIntegration.test.js does, with only dist/clients.js mocked.
import { describe, expect, it, jest, afterEach, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

const WORKSPACE_ROOT = path.join(os.tmpdir(), `gt-mcp-create-seed-${process.pid}-${Date.now()}`);
process.env.GOOGLE_MCP_WORKSPACE_DIR = WORKSPACE_ROOT;

const TOKEN = 'create-flows-seed-token-aaaaaaaaaaaaaaaa';

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

const {
    createV2HttpHandler, prepareMcpServerFactory, startV2Stdio, MCP_PROTOCOL_VERSION,
} = await import('../dist/mcpServer.js');
const { register: registerCreateDocument } = await import('../dist/tools/drive/createDocument.js');
const { register: registerCreateFromTemplate } = await import('../dist/tools/drive/createFromTemplate.js');
const { register: registerAppendText } = await import('../dist/tools/docs/appendToGoogleDoc.js');
const { resetHandleRuntimeState } = await import('../dist/handleRuntime.js');
const { hasBeenRead } = await import('../dist/readTracker.js');

const REVISION = 'rev-created-1';

let docIdSequence = 0;
// readTracker's no-context namespace is one module-global Map (by design —
// see dist/readTracker.js). Each test that exercises the legacy/no-context
// path needs its own document id so a previous test's trackRead doesn't leak
// into hasBeenRead() assertions here.
function freshDocId(label) {
    docIdSequence += 1;
    return `${label}-${docIdSequence}`;
}

function docPayload(docId, text = 'seeded content\n', revisionId = REVISION) {
    return {
        data: {
            id: docId,
            revisionId,
            body: { content: [{ startIndex: 1, endIndex: text.length + 1, paragraph: { elements: [{ startIndex: 1, endIndex: text.length + 1, textRun: { content: text } }] } }] },
        },
    };
}

function setUpGoogleMocks(docId, { text = 'seeded content\n', revisionId = REVISION, replacementsFail = false } = {}) {
    const documentsGet = jest.fn(async () => docPayload(docId, text, revisionId));
    const batchUpdate = jest.fn(async ({ requestBody }) => {
        if (replacementsFail) throw new Error('backend exploded during replaceAllText');
        return { data: { writeControl: requestBody.writeControl } };
    });
    fakeDocs = { documents: { get: documentsGet, batchUpdate } };
    const filesCreate = jest.fn(async () => ({ data: { id: docId, name: 'New Doc', webViewLink: 'https://docs/new-doc' } }));
    const filesCopy = jest.fn(async () => ({ data: { id: docId, name: 'From Template', webViewLink: 'https://docs/from-template' } }));
    fakeDrive = {
        files: {
            create: filesCreate,
            copy: filesCopy,
            get: jest.fn(async () => ({ data: { modifiedTime: '2026-01-01T00:00:00.000Z' } })),
        },
    };
    return { documentsGet, batchUpdate, filesCreate, filesCopy };
}

async function buildFactory() {
    return prepareMcpServerFactory({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        registerTools: async (server) => {
            registerCreateDocument(server);
            registerCreateFromTemplate(server);
            registerAppendText(server);
        },
    });
}

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

afterEach(() => {
    resetHandleRuntimeState();
});

afterAll(async () => {
    await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('createDocument seeds post-create read state (#87 gap 2)', () => {
    it('v2 HTTP: an immediate follow-up mutation succeeds using the returned readHandle', async () => {
        const docId = freshDocId('createdoc-http');
        const { batchUpdate } = setUpGoogleMocks(docId);
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const created = await call(handler, 'createDocument', { title: 'New Doc' });
            expect(created.isError).toBeFalsy();
            expect(created.readHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);

            batchUpdate.mockClear();
            const write = await call(handler, 'appendText', {
                documentId: docId, text: 'appended', readHandle: created.readHandle,
            });
            expect(write.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalledTimes(1);
            expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: REVISION });
        } finally { await handler.close(); }
    });

    it('v2 HTTP with raw initialContent: still seeds and the JSON body reports the seeding note', async () => {
        setUpGoogleMocks(freshDocId('createdoc-raw'));
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const created = await call(handler, 'createDocument', {
                title: 'New Doc', initialContent: 'raw text', contentFormat: 'raw',
            });
            expect(created.isError).toBeFalsy();
            const body = JSON.parse(textOf(created));
            expect(body.readHandleNote).toMatch(/seeded as read/i);
            expect(created.readHandle).toBeTruthy();
        } finally { await handler.close(); }
    });

    it('stdio: the connection\'s implicit state authorizes an immediate follow-up mutation with no explicit handle', async () => {
        const docId = freshDocId('createdoc-stdio');
        const { batchUpdate } = setUpGoogleMocks(docId);
        const factory = await buildFactory();
        const client = await stdioClient(factory, 'create-doc-stdio-epoch');
        try {
            const created = await client.send('createDocument', { title: 'New Doc' });
            expect(created.isError).toBeFalsy();

            batchUpdate.mockClear();
            const write = await client.send('appendText', { documentId: docId, text: 'implicit append' });
            expect(write.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalledTimes(1);
        } finally { await client.runtime.close(); }
    });

    it('legacy (no request context): trackRead seeds the module tracker so hasBeenRead is true', async () => {
        const docId = freshDocId('createdoc-legacy');
        setUpGoogleMocks(docId);
        const server = { addTool(def) { this._def = def; }, getTool() { return this._def; } };
        registerCreateDocument(server);
        const result = await server.getTool().execute({ title: 'New Doc' }, { log: { info() {}, warn() {}, error() {} } });
        const body = JSON.parse(result);
        expect(body.id).toBe(docId);
        expect(hasBeenRead(docId)).toBe(true);
    });
});

describe('createFromTemplate seeds post-create read state only when content ends up fully known (#87 gap 2)', () => {
    it('v2 HTTP, no replacements requested: seeds and an immediate write succeeds', async () => {
        const docId = freshDocId('fromtemplate-http-noreplace');
        const { batchUpdate } = setUpGoogleMocks(docId);
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const created = await call(handler, 'createDocumentFromTemplate', {
                templateId: 'template-1', newTitle: 'From Template',
            });
            expect(created.isError).toBeFalsy();
            expect(created.readHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(textOf(created)).toMatch(/seeded as read/i);

            batchUpdate.mockClear();
            const write = await call(handler, 'appendText', {
                documentId: docId, text: 'appended', readHandle: created.readHandle,
            });
            expect(write.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalledTimes(1);
        } finally { await handler.close(); }
    });

    it('v2 HTTP, successful replacements: seeds and an immediate write succeeds', async () => {
        setUpGoogleMocks(freshDocId('fromtemplate-http-replace-ok'));
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const created = await call(handler, 'createDocumentFromTemplate', {
                templateId: 'template-1',
                newTitle: 'From Template',
                replacements: { '{{NAME}}': 'Ada' },
            });
            expect(created.isError).toBeFalsy();
            expect(created.readHandle).toBeTruthy();
        } finally { await handler.close(); }
    });

    it('v2 HTTP, failed replacements: stays unseeded, no readHandle, and the message says so explicitly', async () => {
        const docId = freshDocId('fromtemplate-http-replace-fail');
        setUpGoogleMocks(docId, { replacementsFail: true });
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const created = await call(handler, 'createDocumentFromTemplate', {
                templateId: 'template-1',
                newTitle: 'From Template',
                replacements: { '{{NAME}}': 'Ada' },
            });
            expect(created.isError).toBeFalsy();
            expect(created.readHandle).toBeUndefined();
            expect(textOf(created)).toMatch(/NOT seeded as read/i);
            expect(textOf(created)).toMatch(/call readDocument/i);

            const write = await call(handler, 'appendText', { documentId: docId, text: 'no handle' });
            expect(write.isError).toBe(true);
            expect(textOf(write)).toMatch(/requires a readHandle/i);
        } finally { await handler.close(); }
    });

    it('legacy (no request context), failed replacements: hasBeenRead stays false (explicit, unread)', async () => {
        const docId = freshDocId('fromtemplate-legacy-fail');
        setUpGoogleMocks(docId, { replacementsFail: true });
        const server = { addTool(def) { this._def = def; }, getTool() { return this._def; } };
        registerCreateFromTemplate(server);
        const result = await server.getTool().execute({
            templateId: 'template-1', newTitle: 'From Template', replacements: { '{{NAME}}': 'Ada' },
        }, { log: { info() {}, warn() {}, error() {} } });
        expect(result).toMatch(/NOT seeded as read/i);
        expect(hasBeenRead(docId)).toBe(false);
    });

    it('legacy (no request context), successful flow: hasBeenRead is true (no readHandle note off the v2 runtime)', async () => {
        const docId = freshDocId('fromtemplate-legacy-ok');
        setUpGoogleMocks(docId);
        const server = { addTool(def) { this._def = def; }, getTool() { return this._def; } };
        registerCreateFromTemplate(server);
        const result = await server.getTool().execute({
            templateId: 'template-1', newTitle: 'From Template',
        }, { log: { info() {}, warn() {}, error() {} } });
        // mintDocsReadHandle is a no-op off the v2 runtime, so no "seeded as
        // read" note is appended here — but trackRead() ran unconditionally,
        // so the legacy readTracker guard still authorizes an immediate write.
        expect(result).not.toMatch(/NOT seeded as read/i);
        expect(hasBeenRead(docId)).toBe(true);
    });
});
