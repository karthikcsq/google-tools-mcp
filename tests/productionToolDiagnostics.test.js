import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const TOKEN = 'production-tool-diagnostics-token';

let driveList;
let docsGet;
let gmailList;
let gmailBatchModify;

jest.unstable_mockModule('../dist/auth.js', () => ({
    authorize: async () => ({ setCredentials() {}, on() {} }),
    getTokenPath: () => 'C:/test-config/token.json',
    SCOPES: [],
}));

jest.unstable_mockModule('@googleapis/drive', () => ({
    drive: () => ({ files: { list: (...args) => driveList(...args) } }),
}));
jest.unstable_mockModule('@googleapis/docs', () => ({
    docs: () => ({ documents: { get: (...args) => docsGet(...args) } }),
}));
jest.unstable_mockModule('@googleapis/gmail', () => ({
    gmail: () => ({ users: { messages: {
        list: (...args) => gmailList(...args),
        batchModify: (...args) => gmailBatchModify(...args),
    } } }),
}));
jest.unstable_mockModule('@googleapis/calendar', () => ({ calendar: () => ({}) }));
jest.unstable_mockModule('@googleapis/forms', () => ({ forms: () => ({}) }));
jest.unstable_mockModule('@googleapis/script', () => ({ script: () => ({}) }));
jest.unstable_mockModule('@googleapis/sheets', () => ({ sheets: () => ({}) }));
jest.unstable_mockModule('@googleapis/slides', () => ({ slides: () => ({}) }));
jest.unstable_mockModule('@googleapis/tasks', () => ({ tasks: () => ({}) }));

const { registerAllTools } = await import('../dist/tools/index.js');
const { createV2HttpHandler, MCP_PROTOCOL_VERSION, prepareMcpServerFactory } = await import('../dist/mcpServer.js');
const { resetClients } = await import('../dist/clients.js');

function apiError(status, reason, detail) {
    return Object.assign(new Error(detail), {
        code: status,
        response: { status, data: { error: { code: status, message: detail, errors: [{ reason }] } } },
    });
}

function toolRequest(name, args = {}) {
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

async function createProductionHandler() {
    const factory = await prepareMcpServerFactory({ registerTools: registerAllTools });
    return createV2HttpHandler(factory, { auth: { token: TOKEN } });
}

beforeEach(() => {
    resetClients();
    driveList = async () => ({ data: { files: [] } });
    docsGet = async () => ({ data: { title: 'Document', tabs: [] } });
    gmailList = async () => ({ data: { messages: [] } });
    gmailBatchModify = async () => ({ data: {} });
});

afterEach(() => {
    resetClients();
});

describe('production registered tool diagnostics', () => {
    it.each([
        ['listDriveFiles', {}, (fn) => { driveList = fn; }],
        ['listTabs', { documentId: 'doc-1' }, (fn) => { docsGet = fn; }],
        ['listMessages', {}, (fn) => { gmailList = fn; }],
    ])('retries the real %s read handler and returns a private rate-limit contract', async (toolName, args, setApi) => {
        let calls = 0;
        const privateDetail = `rate limit at C:/private/${toolName}/token.json`;
        setApi(async () => {
            calls += 1;
            throw apiError(403, 'userRateLimitExceeded', privateDetail);
        });
        const handler = await createProductionHandler();
        try {
            const response = await (await handler.fetch(toolRequest(toolName, args))).json();
            expect(calls).toBe(3);
            expect(response.result.structuredContent.error).toEqual({
                code: 'RATE_LIMITED', status: 403, retryable: true, reason: 'rate-limit',
            });
            expect(response.result.content[0].text).toContain('Retry with exponential backoff');
            expect(JSON.stringify(response.result)).not.toContain(privateDetail);
        } finally {
            await handler.close();
        }
    });

    it('retries a real Drive read after a closed Node transport error without exposing its cause', async () => {
        let calls = 0;
        const privateDetail = 'socket reset at C:/private/drive/token.json';
        driveList = async () => {
            calls += 1;
            throw Object.assign(new Error(privateDetail), { code: 'ECONNRESET' });
        };
        const handler = await createProductionHandler();
        try {
            const response = await (await handler.fetch(toolRequest('listDriveFiles'))).json();
            expect(calls).toBe(3);
            expect(response.result.structuredContent.error).toEqual({
                code: 'SERVICE_UNAVAILABLE', status: 503, retryable: true, reason: 'service-unavailable',
            });
            expect(response.result.content[0].text).toContain('temporarily unavailable');
            expect(JSON.stringify(response.result)).not.toContain(privateDetail);
        } finally {
            await handler.close();
        }
    });

    it.each([
        ['a 503 API response', () => apiError(503, 'backendError', 'backend unavailable at C:/private/gmail/token.json')],
        ['a closed Node transport', () => Object.assign(new Error('socket reset at C:/private/gmail/token.json'), { code: 'ECONNRESET' })],
    ])('marks a real registered Gmail mutation with %s as outcome-unknown', async (_label, makeError) => {
        let calls = 0;
        const privateDetail = 'C:/private/gmail/token.json';
        gmailBatchModify = async () => {
            calls += 1;
            throw makeError();
        };
        const handler = await createProductionHandler();
        try {
            const response = await (await handler.fetch(toolRequest('modifyMessage', { ids: ['message-1'] }))).json();
            expect(calls).toBe(1);
            expect(response.result.structuredContent.error).toEqual({
                code: 'SERVICE_UNAVAILABLE', status: 503, retryable: false, reason: 'outcome-unknown',
            });
            expect(response.result.content[0].text).toContain('did not confirm whether this change completed');
            expect(JSON.stringify(response.result)).not.toContain(privateDetail);
        } finally {
            await handler.close();
        }
    });
});
