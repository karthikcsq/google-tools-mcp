// Fix 3: modifyText's early `return 'No operations to perform.'` (when
// {target, style: {}} parses but builds zero requests) used to exit without
// settling the mutation lease, leaving the v2 handle-runtime record stuck
// RESERVED. A subsequent mutation against the same handle was then rejected
// as an in-flight operation even though nothing was ever written. The fix
// calls `lease.abort()` before that early return, which releases the
// reservation without consuming the handle.
//
// Driving the real SDK v2 facade (dist/mcpServer.js) the same way
// tests/insertImageGuardBeforeUpload.test.js and
// tests/readHandleIntegration.test.js do, with only dist/clients.js mocked,
// is what makes the RESERVED-state bug observable: the legacy/stdio implicit
// read-tracker path has no such state to get stuck in.
import { describe, expect, it, jest, afterEach, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const WORKSPACE_ROOT = path.join(os.tmpdir(), `gt-mcp-modifytext-noop-${process.pid}-${Date.now()}`);
process.env.GOOGLE_MCP_WORKSPACE_DIR = WORKSPACE_ROOT;

const TOKEN = 'modifytext-noop-token-aaaaaaaaaaaaaaaa';

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

const DOC_ID = 'modifytext-noop-doc-1';
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
    const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
    fakeDocs = { documents: { get: jest.fn(async () => docPayload()), batchUpdate } };
    return { batchUpdate };
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

afterEach(() => {
    resetHandleRuntimeState();
});

afterAll(async () => {
    await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('modifyText releases the lease on a zero-request no-op (#fix3)', () => {
    it('a call that produces zero requests leaves the SAME readHandle usable for a follow-up mutation', async () => {
        const { batchUpdate } = setUpGoogleMocks();
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            expect(read.readHandle).toBeTruthy();

            // target + style: {} parses (at least one of text/style/paragraphStyle
            // is present) but builds zero requests, since style has no set fields.
            const noOp = await call(handler, 'modifyText', {
                documentId: DOC_ID,
                target: { startIndex: 1, endIndex: 5 },
                style: {},
                readHandle: read.readHandle,
            });
            expect(noOp.isError).toBeFalsy();
            expect(textOf(noOp)).toMatch(/No operations to perform/);
            expect(batchUpdate).not.toHaveBeenCalled();

            // The SAME handle, never consumed by a write, must still work.
            const followUp = await call(handler, 'modifyText', {
                documentId: DOC_ID,
                target: { insertionIndex: 1 },
                text: 'inserted',
                readHandle: read.readHandle,
            });
            expect(followUp.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalledTimes(1);
        } finally { await handler.close(); }
    });
});
