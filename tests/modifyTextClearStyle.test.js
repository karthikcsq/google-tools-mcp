// Issue #121: modifyText replacement text silently inherited the character
// style of the text it replaced. Replacing a one-line italic placeholder with a
// 2,500-character section made the entire section italic, and the result read
// "Successfully replaced text at range 2934-3110" with nothing to suggest it.
//
// Two fixes, both covered here:
//   * `clearStyle: true` makes inserted text land as plain body text.
//   * When clearStyle is not set, the result NAMES the non-default formatting
//     the new text inherited, so the mistake is visible without opening the doc.
//
// Driven through the real SDK v2 facade with only dist/clients.js mocked, the
// same way tests/modifyTextNoOpLeaseRelease.test.js does, so the guard, the
// handle runtime and the request builder all run for real.
import { describe, expect, it, jest, afterEach, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const WORKSPACE_ROOT = path.join(os.tmpdir(), `gt-mcp-modifytext-clearstyle-${process.pid}-${Date.now()}`);
process.env.GOOGLE_MCP_WORKSPACE_DIR = WORKSPACE_ROOT;

const TOKEN = 'modifytext-clearstyle-token-aaaaaaaa';

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
const { register: registerModifyText, buildModifyTextRequests } = await import('../dist/tools/docs/modifyText.js');
const { resetHandleRuntimeState } = await import('../dist/handleRuntime.js');

const DOC_ID = 'modifytext-clearstyle-doc-1';
const REVISION = 'rev-read-1';

// One italic placeholder paragraph, exactly the shape from the issue.
const PLACEHOLDER = 'Not drafted yet.\n';

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
                            textRun: { content: PLACEHOLDER, textStyle: { italic: true } },
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
const styleRequests = (batchUpdate) => batchUpdate.mock.calls
    .flatMap(([{ requestBody }]) => requestBody.requests)
    .filter((request) => request.updateTextStyle);

afterEach(() => {
    resetHandleRuntimeState();
});

afterAll(async () => {
    await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('modifyText — inherited character style (#121)', () => {
    it('names the formatting the replacement inherited instead of reporting a bare success', async () => {
        const { batchUpdate } = setUpGoogleMocks();
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const result = await call(handler, 'modifyText', {
                documentId: DOC_ID,
                target: { startIndex: 1, endIndex: 1 + PLACEHOLDER.length },
                text: 'A much longer drafted section that replaces the placeholder.',
                readHandle: read.readHandle,
            });
            expect(result.isError).toBeFalsy();
            const output = textOf(result);
            expect(output).toMatch(/Successfully replaced text/);
            expect(output).toMatch(/inherited italic/);
            expect(output).toMatch(/clearStyle:true/);
            // Nothing was cleared: the caller did not ask for it.
            expect(styleRequests(batchUpdate).some((r) => r.updateTextStyle.fields.includes('smallCaps'))).toBe(false);
        } finally { await handler.close(); }
    });

    it('clearStyle:true emits a reset over exactly the inserted range and says so', async () => {
        const { batchUpdate } = setUpGoogleMocks();
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        const replacement = 'A much longer drafted section that replaces the placeholder.';
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const result = await call(handler, 'modifyText', {
                documentId: DOC_ID,
                target: { startIndex: 1, endIndex: 1 + PLACEHOLDER.length },
                text: replacement,
                clearStyle: true,
                readHandle: read.readHandle,
            });
            expect(result.isError).toBeFalsy();
            const output = textOf(result);
            expect(output).toMatch(/formatting was cleared/i);
            // With the inherit suppressed there is nothing to warn about.
            expect(output).not.toMatch(/inherited/);

            const reset = styleRequests(batchUpdate).find((r) => r.updateTextStyle.textStyle
                && Object.keys(r.updateTextStyle.textStyle).length === 0);
            expect(reset).toBeTruthy();
            expect(reset.updateTextStyle.range).toEqual({ startIndex: 1, endIndex: 1 + replacement.length });
            for (const field of ['bold', 'italic', 'underline', 'strikethrough', 'link']) {
                expect(reset.updateTextStyle.fields).toContain(field);
            }
        } finally { await handler.close(); }
    });

    it('says nothing about inheritance when the surrounding text is plain', async () => {
        const { get } = setUpGoogleMocks();
        get.mockImplementation(async () => {
            const payload = docPayload();
            delete payload.data.body.content[0].paragraph.elements[0].textRun.textStyle;
            return payload;
        });
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            const result = await call(handler, 'modifyText', {
                documentId: DOC_ID,
                target: { startIndex: 1, endIndex: 1 + PLACEHOLDER.length },
                text: 'Plain replacement.',
                readHandle: read.readHandle,
            });
            expect(textOf(result)).not.toMatch(/inherited/);
        } finally { await handler.close(); }
    });
});

describe('buildModifyTextRequests — clearStyle ordering (#121)', () => {
    const kindsOf = (requests) => requests.map((request) => Object.keys(request)[0]);

    it('clears before the default color and before caller-supplied style, so both still win', () => {
        const requests = buildModifyTextRequests({
            startIndex: 5,
            endIndex: 10,
            text: 'Hello',
            clearStyle: true,
            defaultColor: { red: 0, green: 0, blue: 0 },
            style: { bold: true },
        });
        expect(kindsOf(requests)).toEqual([
            'deleteContentRange', 'insertText', 'updateTextStyle', 'updateTextStyle', 'updateTextStyle',
        ]);
        // [2] is the clear (empty payload), [3] paints the default color,
        // [4] applies the caller's bold. Order is the whole contract.
        expect(requests[2].updateTextStyle.textStyle).toEqual({});
        expect(requests[3].updateTextStyle.fields).toBe('foregroundColor');
        expect(requests[4].updateTextStyle.textStyle).toEqual({ bold: true });
    });

    it('emits no clear request when no text is inserted', () => {
        const requests = buildModifyTextRequests({
            startIndex: 5,
            endIndex: 10,
            text: '',
            clearStyle: true,
        });
        expect(kindsOf(requests)).toEqual(['deleteContentRange']);
    });

    it('clears the inserted range for a pure insertion too', () => {
        const requests = buildModifyTextRequests({
            startIndex: 5,
            text: 'New text',
            clearStyle: true,
        });
        expect(kindsOf(requests)).toEqual(['insertText', 'updateTextStyle']);
        expect(requests[1].updateTextStyle.range).toEqual({ startIndex: 5, endIndex: 13 });
    });

    it('carries tabId onto the clear request', () => {
        const requests = buildModifyTextRequests({
            startIndex: 5,
            text: 'New text',
            clearStyle: true,
            tabId: 'tab-7',
        });
        expect(requests[1].updateTextStyle.range.tabId).toBe('tab-7');
    });
});
