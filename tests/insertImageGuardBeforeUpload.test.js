// #87 gap 1: insertImage used to upload to Drive BEFORE the beginDocsMutation
// guard ran, so a rejected mutation (no/invalid readHandle on the v2 HTTP
// runtime) still left a file behind in the user's Drive. This suite proves the
// guard now runs first on both the standard (public URL / local file via
// insertInlineImage) and Apps Script local-file paths, driving the real SDK v2
// facade (dist/mcpServer.js) the same way tests/readHandleIntegration.test.js
// does, with only dist/clients.js mocked.
import { describe, expect, it, jest, beforeAll, afterAll, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const WORKSPACE_ROOT = path.join(os.tmpdir(), `gt-mcp-insertimage-${process.pid}-${Date.now()}`);
process.env.GOOGLE_MCP_WORKSPACE_DIR = WORKSPACE_ROOT;

const TOKEN = 'insert-image-guard-token-aaaaaaaaaaaaaaaa';

let fakeDocs;
let fakeDrive;
let fakeScript;

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
    getScriptClient: async () => fakeScript,
    getSlidesClient: unusedClient,
    getTasksClient: unusedClient,
    resetClients: () => {},
    withAuthRetry: (fn) => fn(),
}));

const { createV2HttpHandler, prepareMcpServerFactory, MCP_PROTOCOL_VERSION } = await import('../dist/mcpServer.js');
const { register: registerReadDocument } = await import('../dist/tools/docs/readGoogleDoc.js');
const { register: registerInsertImage } = await import('../dist/tools/docs/insertImage.js');
const { resetHandleRuntimeState } = await import('../dist/handleRuntime.js');

const DOC_ID = 'insert-image-doc-1';
const REVISION = 'rev-read-1';

function docPayload(text = 'Hello world\n', revisionId = REVISION) {
    return {
        data: {
            revisionId,
            body: { content: [{ startIndex: 1, endIndex: text.length + 1, paragraph: { elements: [{ startIndex: 1, endIndex: text.length + 1, textRun: { content: text } }] } }] },
        },
    };
}

function setUpGoogleMocks() {
    const uploadCreate = jest.fn(async ({ media } = {}) => {
        if (media?.body) {
            await new Promise((resolve, reject) => {
                media.body.on('data', () => {});
                media.body.on('end', resolve);
                media.body.on('close', resolve);
                media.body.on('error', reject);
            });
        }
        return { data: { id: 'uploaded-file-id', webViewLink: 'https://drive/uploaded', webContentLink: 'https://drive/uploaded-content' } };
    });
    const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
    fakeDocs = { documents: { get: jest.fn(async () => docPayload()), batchUpdate } };
    fakeDrive = {
        files: {
            get: jest.fn(async () => ({ data: { modifiedTime: null, webContentLink: 'https://drive/uploaded-content' } })),
            create: uploadCreate,
        },
        // insertInlineImage's non-AppsScript path additionally sets sharing
        // permissions on the uploaded file before building the public URL.
        permissions: { create: jest.fn(async () => ({ data: {} })) },
    };
    fakeScript = { scripts: { run: jest.fn(async () => ({ data: { response: { result: { success: true } } } })) } };
    return { uploadCreate, batchUpdate };
}

async function buildFactory() {
    return prepareMcpServerFactory({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        registerTools: async (server) => {
            registerReadDocument(server);
            registerInsertImage(server);
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

const tmpImagePath = path.join(os.tmpdir(), `insert-image-guard-${process.pid}.png`);

beforeAll(() => {
    fsSync.writeFileSync(tmpImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterAll(async () => {
    fsSync.rmSync(tmpImagePath, { force: true });
    await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true }).catch(() => {});
});

afterEach(() => {
    resetHandleRuntimeState();
});

describe('insertImage guard-before-upload (#87 gap 1), standard path', () => {
    it('rejects without a readHandle on v2 HTTP before any Drive upload call', async () => {
        const { uploadCreate, batchUpdate } = setUpGoogleMocks();
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const result = await call(handler, 'insertImage', {
                documentId: DOC_ID,
                localImagePath: tmpImagePath,
                index: 1,
            });
            expect(result.isError).toBe(true);
            expect(textOf(result)).toMatch(/requires a readHandle/i);
            expect(uploadCreate).not.toHaveBeenCalled();
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally { await handler.close(); }
    });

    it('rejects a guessed/invalid readHandle on v2 HTTP before any Drive upload call', async () => {
        const { uploadCreate, batchUpdate } = setUpGoogleMocks();
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const result = await call(handler, 'insertImage', {
                documentId: DOC_ID,
                localImagePath: tmpImagePath,
                index: 1,
                readHandle: 'A'.repeat(43),
            });
            expect(result.isError).toBe(true);
            expect(uploadCreate).not.toHaveBeenCalled();
            expect(batchUpdate).not.toHaveBeenCalled();
        } finally { await handler.close(); }
    });

    it('uploads then writes once a valid readHandle authorizes the mutation', async () => {
        const { uploadCreate, batchUpdate } = setUpGoogleMocks();
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            expect(read.readHandle).toBeTruthy();

            const write = await call(handler, 'insertImage', {
                documentId: DOC_ID,
                localImagePath: tmpImagePath,
                index: 1,
                readHandle: read.readHandle,
            });
            expect(write.isError).toBeFalsy();
            expect(uploadCreate).toHaveBeenCalledTimes(1);
            expect(batchUpdate).toHaveBeenCalledTimes(1);
            // The upload must have happened strictly before the batchUpdate write.
            const uploadOrder = uploadCreate.mock.invocationCallOrder[0];
            const writeOrder = batchUpdate.mock.invocationCallOrder[0];
            expect(uploadOrder).toBeLessThan(writeOrder);
        } finally { await handler.close(); }
    });
});

describe('insertImage guard-before-upload (#87 gap 1), Apps Script local-file path', () => {
    beforeAll(() => {
        process.env.APPS_SCRIPT_DEPLOYMENT_ID = 'test-deployment-id';
    });
    afterAll(() => {
        delete process.env.APPS_SCRIPT_DEPLOYMENT_ID;
    });

    it('rejects without a readHandle on v2 HTTP before any Drive upload call', async () => {
        const { uploadCreate } = setUpGoogleMocks();
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const result = await call(handler, 'insertImage', {
                documentId: DOC_ID,
                localImagePath: tmpImagePath,
                index: 1,
            });
            expect(result.isError).toBe(true);
            expect(textOf(result)).toMatch(/requires a readHandle/i);
            expect(uploadCreate).not.toHaveBeenCalled();
        } finally { await handler.close(); }
    });

    it('uploads then inserts via Apps Script once a valid readHandle authorizes the mutation', async () => {
        const { uploadCreate } = setUpGoogleMocks();
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const write = await call(handler, 'insertImage', {
                documentId: DOC_ID,
                localImagePath: tmpImagePath,
                index: 1,
                readHandle: read.readHandle,
            });
            expect(write.isError).toBeFalsy();
            expect(uploadCreate).toHaveBeenCalledTimes(1);
            expect(fakeScript.scripts.run).toHaveBeenCalledTimes(1);
            const uploadOrder = uploadCreate.mock.invocationCallOrder[0];
            const scriptOrder = fakeScript.scripts.run.mock.invocationCallOrder[0];
            expect(uploadOrder).toBeLessThan(scriptOrder);
        } finally { await handler.close(); }
    });
});
