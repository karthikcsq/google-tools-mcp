// Issue #120: modifyText could not create or remove bullets/numbered-list
// items, so a mid-document insert into a live document (the only safe editor
// for one a human has open) could never match a parallel bulleted/numbered
// section elsewhere in the same doc — the result read fine but visibly did
// not match, and the mismatch had to be explained after the fact.
//
// paragraphStyle.bulletPreset maps onto the Docs API's createParagraphBullets
// / deleteParagraphBullets requests, applied over the same range the text
// edit touches, so the insert and its list marker land in one call.
//
// Driven through the real SDK v2 facade with only dist/clients.js mocked,
// the same way tests/modifyTextClearStyle.test.js does, so the guard, the
// handle runtime, and the request builder all run for real.
import { describe, expect, it, jest, afterEach, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const WORKSPACE_ROOT = path.join(os.tmpdir(), `gt-mcp-modifytext-bullet-${process.pid}-${Date.now()}`);
process.env.GOOGLE_MCP_WORKSPACE_DIR = WORKSPACE_ROOT;

const TOKEN = 'modifytext-bullet-token-aaaaaaaa';

let fakeDocs;

const unusedClient = async () => { throw new Error('client not used in this suite'); };
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => fakeDocs,
    getDriveClient: unusedClient,
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
const { register: registerModifyText } = await import('../dist/tools/docs/modifyText.js');
const { resetHandleRuntimeState } = await import('../dist/handleRuntime.js');

const DOC_ID = 'modifytext-bullet-doc-1';
const REVISION = 'rev-read-1';

// "Version B" placeholder: a bare paragraph where "Version A" (built via
// createDocument) has real bullets, exactly the mismatch from the issue.
const PLACEHOLDER = 'placeholder line\n';

function docPayload() {
    return {
        data: {
            revisionId: REVISION,
            namedStyles: { styles: [] },
            body: {
                content: [{
                    startIndex: 1,
                    endIndex: 1 + PLACEHOLDER.length,
                    paragraph: {
                        elements: [{
                            startIndex: 1,
                            endIndex: 1 + PLACEHOLDER.length,
                            textRun: { content: PLACEHOLDER },
                        }],
                    },
                }],
            },
        },
    };
}

function setUpGoogleMocks() {
    const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
    const get = jest.fn(async () => docPayload());
    fakeDocs = { documents: { get, batchUpdate } };
    return { batchUpdate, get };
}

async function buildFactory() {
    return prepareMcpServerFactory({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        registerTools: async (server) => {
            registerReadDocument(server);
            registerModifyText(server);
        },
    });
}

async function call(handler, name, args) {
    const response = await handler.fetch(new Request('http://localhost/mcp', {
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
    }));
    return (await response.json()).result;
}

const textOf = (result) => result.content.map((entry) => entry.text ?? '').join('');
const requestsOf = (batchUpdate) => batchUpdate.mock.calls.flatMap(([{ requestBody }]) => requestBody.requests);

afterEach(() => {
    resetHandleRuntimeState();
});

afterAll(async () => {
    await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('modifyText — bulletPreset list control (#120)', () => {
    it('turns a mid-document insert into a real bulleted list item', async () => {
        const { batchUpdate } = setUpGoogleMocks();
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const result = await call(handler, 'modifyText', {
                documentId: DOC_ID,
                target: { startIndex: 1, endIndex: 1 + PLACEHOLDER.length },
                text: 'Matches Version A\n',
                paragraphStyle: { bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' },
                readHandle: read.readHandle,
            });
            expect(result.isError).toBeFalsy();
            const output = textOf(result);
            expect(output).toMatch(/Successfully replaced text/);
            expect(output).toMatch(/list formatting \(BULLET_DISC_CIRCLE_SQUARE\)/);

            const requests = requestsOf(batchUpdate);
            const bulletRequest = requests.find((r) => r.createParagraphBullets);
            expect(bulletRequest).toBeTruthy();
            expect(bulletRequest.createParagraphBullets.bulletPreset).toBe('BULLET_DISC_CIRCLE_SQUARE');
            expect(bulletRequest.createParagraphBullets.range).toEqual({
                startIndex: 1,
                endIndex: 1 + 'Matches Version A\n'.length,
            });
            // The bullet request lands AFTER the insert in the same batchUpdate.
            const insertIdx = requests.findIndex((r) => r.insertText);
            const bulletIdx = requests.findIndex((r) => r.createParagraphBullets);
            expect(insertIdx).toBeGreaterThanOrEqual(0);
            expect(bulletIdx).toBeGreaterThan(insertIdx);
        } finally { await handler.close(); }
    });

    it('turns a mid-document insert into a real numbered list item', async () => {
        const { batchUpdate } = setUpGoogleMocks();
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const result = await call(handler, 'modifyText', {
                documentId: DOC_ID,
                target: { startIndex: 1, endIndex: 1 + PLACEHOLDER.length },
                text: 'First numbered step\n',
                paragraphStyle: { bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN' },
                readHandle: read.readHandle,
            });
            expect(result.isError).toBeFalsy();
            const bulletRequest = requestsOf(batchUpdate).find((r) => r.createParagraphBullets);
            expect(bulletRequest.createParagraphBullets.bulletPreset).toBe('NUMBERED_DECIMAL_ALPHA_ROMAN');
        } finally { await handler.close(); }
    });

    it('removes bullets from an existing list item with bulletPreset: null', async () => {
        const { batchUpdate } = setUpGoogleMocks();
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const result = await call(handler, 'modifyText', {
                documentId: DOC_ID,
                target: { startIndex: 1, endIndex: 1 + PLACEHOLDER.length },
                paragraphStyle: { bulletPreset: null },
                readHandle: read.readHandle,
            });
            expect(result.isError).toBeFalsy();
            const output = textOf(result);
            expect(output).toMatch(/removed list bullet/);
            const requests = requestsOf(batchUpdate);
            expect(requests).toContainEqual({
                deleteParagraphBullets: { range: { startIndex: 1, endIndex: 1 + PLACEHOLDER.length } },
            });
            expect(requests.some((r) => r.createParagraphBullets)).toBe(false);
        } finally { await handler.close(); }
    });

    it('rejects an unrecognized bulletPreset value', async () => {
        setUpGoogleMocks();
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const result = await call(handler, 'modifyText', {
                documentId: DOC_ID,
                target: { startIndex: 1, endIndex: 1 + PLACEHOLDER.length },
                text: 'x\n',
                paragraphStyle: { bulletPreset: 'NOT_A_REAL_PRESET' },
                readHandle: read.readHandle,
            });
            expect(result.isError).toBeTruthy();
        } finally { await handler.close(); }
    });
});
