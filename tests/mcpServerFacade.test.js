import { describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { registerAllTools } from '../dist/tools/index.js';
import { createV2HttpHandler, prepareMcpServerFactory, startV2HttpServer, startV2Stdio, selectRuntimeKind, MCP_PROTOCOL_VERSION } from '../dist/mcpServer.js';
import { publicError, redactDiagnostic, registerSecret } from '../dist/errors.js';
import { getRequestContext } from '../dist/requestContext.js';

const TOKEN = 'facade-test-token-that-must-never-reach-a-client';

async function factoryWith(...definitions) {
    return prepareMcpServerFactory({ registerTools: async (server) => {
        for (const definition of definitions) server.addTool(definition);
    } });
}

function modern(method, params = {}, headers = {}) {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            'mcp-protocol-version': MCP_PROTOCOL_VERSION,
            'mcp-method': method,
            ...headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {
            ...params,
            _meta: {
                'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
                'io.modelcontextprotocol/clientCapabilities': {},
            },
        } }),
    });
}

function legacy(method, params = {}, id = 1) {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
}

async function legacyJson(response) {
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const line = (await response.text()).split(/\r?\n/).find((value) => value.startsWith('data: '));
    return JSON.parse(line.slice(6));
}

function stdioMessages(output) {
    let buffer = '';
    const pending = [];
    const messages = [];
    output.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const message = JSON.parse(line);
            const waiter = pending.shift();
            if (waiter) waiter(message); else messages.push(message);
        }
    });
    return () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => pending.push(resolve));
}

describe('official SDK v2 facade', () => {
    it('registers the current 156-tool catalog through the production facade', async () => {
        const factory = await prepareMcpServerFactory({ registerTools: registerAllTools });
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const list = await (await handler.fetch(modern('tools/list'))).json();
            expect(list.result.tools).toHaveLength(156);
            expect(new Set(list.result.tools.map((tool) => tool.name)).size).toBe(156);
        } finally { await handler.close(); }
    });

    it('registers sorted addTool definitions with truthful discovery and cache hints', async () => {
        const factory = await factoryWith(
            { name: 'zeta', description: 'z', parameters: z.object({}), execute: async () => 'z' },
            { name: 'alpha', description: 'a', parameters: z.object({}), execute: async () => 'a' },
        );
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const discover = await (await handler.fetch(modern('server/discover'))).json();
            expect(discover.result.capabilities.tools.listChanged).toBe(false);
            expect(discover.result.instructions).toContain('Google Workspace tools');
            expect(discover.result._meta['io.modelcontextprotocol/serverInfo']).toEqual({ name: 'google-tools-mcp', version: '2.0.0' });
            expect(discover.result.cacheScope).toBe('private');
            const list = await (await handler.fetch(modern('tools/list'))).json();
            expect(list.result.tools.map((tool) => tool.name)).toEqual(['alpha', 'zeta']);
            expect(list.result.ttlMs).toBe(60_000);
        } finally { await handler.close(); }
    });

    it('rejects missing and duplicate tool names before constructing an SDK server', async () => {
        await expect(factoryWith({ name: ' ', parameters: z.object({}), execute: async () => {} })).rejects.toThrow(/non-empty/);
        await expect(factoryWith(
            { name: 'same', parameters: z.object({}), execute: async () => {} },
            { name: 'same', parameters: z.object({}), execute: async () => {} },
        )).rejects.toThrow(/Duplicate/);
    });

    it('authenticates before health or MCP and health has an exact minimal response', async () => {
        const factory = await factoryWith({ name: 'noop', description: 'n', parameters: z.object({}), execute: async () => 'ok' });
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            expect((await handler.fetch(new Request('http://localhost/healthz'))).status).toBe(401);
            const response = await handler.fetch(new Request('http://localhost/healthz', { headers: { authorization: `Bearer ${TOKEN}` } }));
            expect(await response.json()).toEqual({ status: 'ok' });
            expect((await handler.fetch(new Request('http://localhost/sse', { headers: { authorization: `Bearer ${TOKEN}` } }))).status).toBe(404);
        } finally { await handler.close(); }
    });

    it('permits validated CORS preflight without credentials while keeping real endpoints authenticated', async () => {
        const factory = await factoryWith({ name: 'noop', parameters: z.object({}), execute: async () => 'ok' });
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN, allowedOrigins: ['https://allowed.example'] } });
        try {
            const valid = await handler.fetch(new Request('http://localhost/mcp', { method: 'OPTIONS', headers: {
                origin: 'https://allowed.example',
                'access-control-request-method': 'POST',
                'access-control-request-headers': 'Authorization, Content-Type, MCP-Method',
            } }));
            expect(valid.status).toBe(204);
            expect(valid.headers.get('access-control-allow-origin')).toBe('https://allowed.example');
            expect((await handler.fetch(new Request('http://localhost/mcp', { method: 'OPTIONS', headers: {
                origin: 'https://evil.example', 'access-control-request-method': 'POST',
            } }))).status).toBe(403);
            expect((await handler.fetch(new Request('http://localhost/mcp', { method: 'OPTIONS', headers: {
                origin: 'https://allowed.example', 'access-control-request-method': 'DELETE',
            } }))).status).toBe(403);
            expect((await handler.fetch(new Request('http://localhost/mcp', { method: 'OPTIONS', headers: {
                origin: 'https://allowed.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'X-Evil',
            } }))).status).toBe(403);
            expect((await handler.fetch(new Request('http://localhost/healthz'))).status).toBe(401);
        } finally { await handler.close(); }
    });

    it('keeps legacy stateless HTTP supported but rejects an unheadered modern request', async () => {
        const factory = await factoryWith({ name: 'noop', description: 'n', parameters: z.object({}), execute: async () => 'ok' });
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const missingHeader = modern('tools/list');
            missingHeader.headers.delete('mcp-protocol-version');
            expect((await handler.fetch(missingHeader)).status).toBe(400);
            const initialized = await legacyJson(await handler.fetch(legacy('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })));
            expect(initialized.result.protocolVersion).toBe('2025-11-25');
            const listed = await legacyJson(await handler.fetch(legacy('tools/list', {}, 2)));
            expect(listed.result.tools.map(({ name }) => name)).toEqual(['noop']);
            const called = await legacyJson(await handler.fetch(legacy('tools/call', { name: 'noop', arguments: {} }, 3)));
            expect(called.result.content).toEqual([{ type: 'text', text: 'ok' }]);
        } finally { await handler.close(); }
    });

    it('derives the same canonical principal fingerprint from every accepted bearer spelling', async () => {
        const factory = await factoryWith({ name: 'identity', parameters: z.object({}), execute: async () => getRequestContext().principalFingerprint });
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        const call = async (headers) => {
            const response = await handler.fetch(modern('tools/call', { name: 'identity', arguments: {} }, { 'mcp-name': 'identity', ...headers }));
            return (await response.json()).result.content[0].text;
        };
        try {
            const normal = await call({ authorization: `Bearer ${TOKEN}` });
            expect(await call({ authorization: `bearer   ${TOKEN}` })).toBe(normal);
            expect(await call({ authorization: '', 'x-mcp-token': TOKEN })).toBe(normal);
            expect(normal).toMatch(/^hmac-sha256:[A-Za-z0-9_-]{43}$/);
        } finally { await handler.close(); }
    });

    it('acknowledges subscriptions/listen and promptly closes the otherwise-open SDK stream', async () => {
        const factory = await factoryWith({ name: 'noop', description: 'n', parameters: z.object({}), execute: async () => 'ok' });
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const response = await handler.fetch(modern('subscriptions/listen', { notifications: {} }));
            expect(response.headers.get('content-type')).toContain('text/event-stream');
            const reader = response.body.getReader();
            const first = await reader.read();
            expect(new TextDecoder().decode(first.value)).toContain('notifications/subscriptions/acknowledged');
            await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
        } finally { await handler.close(); }
    });

    it('passes only immutable public errors to callers and redacts internal failures', async () => {
        const logger = { error: jest.fn(), warn: jest.fn() };
        const remove = registerSecret(TOKEN);
        const factory = await factoryWith(
            { name: 'public', description: 'p', parameters: z.object({}), execute: async () => { throw publicError(`Caller-safe wrapper token=${TOKEN}&access_token=query-secret`); } },
            { name: 'internal', description: 'i', parameters: z.object({}), execute: async () => { throw new Error(`upstream leaked ${TOKEN}`); } },
        );
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN }, logger });
        try {
            const publicResult = await (await handler.fetch(modern('tools/call', { name: 'public', arguments: {} }, { 'mcp-name': 'public' }))).json();
            expect(publicResult.result.content[0].text).not.toContain(TOKEN);
            expect(publicResult.result.content[0].text).not.toContain('query-secret');
            const internalResult = await (await handler.fetch(modern('tools/call', { name: 'internal', arguments: {} }, { 'mcp-name': 'internal' }))).json();
            expect(internalResult.result.content[0].text).not.toContain(TOKEN);
            expect(JSON.stringify(logger.error.mock.calls)).not.toContain(TOKEN);
        } finally { remove(); await handler.close(); }
    });

    it('preserves exact execute(args,{log}) and normalizes undefined, content, and structured results', async () => {
        const log = { info: jest.fn(), error: jest.fn() };
        const execute = jest.fn(async (args, context) => { context.log.info('used'); return undefined; });
        const definitions = [
            { name: 'empty', parameters: z.object({ value: z.string() }), execute },
            { name: 'content', parameters: z.object({}), execute: async () => ({ content: [{ type: 'text', text: 'kept' }] }) },
            { name: 'structured', parameters: z.object({}), execute: async () => ({ content: [{ type: 'text', text: 'display' }], structuredContent: { answer: 42 } }) },
        ];
        const factory = await prepareMcpServerFactory({ logger: log, registerTools: async (server) => definitions.forEach((definition) => server.addTool(definition)) });
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN }, logger: log });
        const call = async (name, args = {}) => (await (await handler.fetch(modern('tools/call', { name, arguments: args }, { 'mcp-name': name }))).json()).result;
        try {
            expect(await call('empty', { value: 'x' })).toEqual(expect.objectContaining({ content: [] }));
            expect(execute).toHaveBeenCalledWith({ value: 'x' }, { log });
            expect((await call('content')).content[0].text).toBe('kept');
            expect((await call('structured')).structuredContent).toEqual({ answer: 42 });
        } finally { await handler.close(); }
    });

    it('owns a stdio connection lifecycle and closes on EOF without writing diagnostics to stdout', async () => {
        const factory = await factoryWith({ name: 'noop', description: 'n', parameters: z.object({}), execute: async () => 'ok' });
        const input = new PassThrough();
        const output = new PassThrough();
        const runtime = startV2Stdio(factory, { input, output, logger: { error: jest.fn() } });
        input.end();
        await new Promise((resolve) => setImmediate(resolve));
        await runtime.close();
        expect(output.read()).toBeNull();
    });

    it('serves production stdio discover, list, and call framing with protocol-only stdout', async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        const logger = { info: jest.fn(), error: jest.fn() };
        const factory = await prepareMcpServerFactory({ logger, registerTools: async (server) => server.addTool({ name: 'echo', description: 'e', parameters: z.object({ text: z.string() }), execute: async ({ text }, { log }) => { log.info('stderr only'); return text; } }) });
        const runtime = startV2Stdio(factory, { input, output, logger });
        const next = stdioMessages(output);
        const meta = { 'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} };
        const send = (id, method, params = {}) => input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } })}\n`);
        try {
            send(1, 'server/discover');
            expect((await next()).result._meta['io.modelcontextprotocol/serverInfo'].version).toBe('2.0.0');
            send(2, 'tools/list');
            expect((await next()).result.tools.map(({ name }) => name)).toEqual(['echo']);
            send(3, 'tools/call', { name: 'echo', arguments: { text: 'wire' } });
            expect((await next()).result.content[0].text).toBe('wire');
            expect(logger.info).toHaveBeenCalledWith('stderr only');
        } finally { await runtime.close(); }
    });

    it('removes named stdio EOF listeners on close and does not leak them across restarts', async () => {
        const factory = await factoryWith({ name: 'noop', parameters: z.object({}), execute: async () => 'ok' });
        const input = new PassThrough();
        const baselineEnd = input.listenerCount('end');
        const baselineClose = input.listenerCount('close');
        for (let index = 0; index < 3; index += 1) {
            const runtime = startV2Stdio(factory, { input, output: new PassThrough(), logger: { error: jest.fn() } });
            expect(input.listenerCount('end')).toBeGreaterThan(baselineEnd);
            await runtime.close();
            expect(input.listenerCount('end')).toBe(baselineEnd);
            expect(input.listenerCount('close')).toBe(baselineClose);
        }
    });

    it.each(['eof', 'SIGINT', 'SIGTERM'])('closes the selected runtime before child-process exit on %s', async (mode) => {
        const child = spawn(process.execPath, ['tests/fixtures/runtimeLifecycleChild.js', mode], {
            cwd: process.cwd(), stdio: ['pipe', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        if (mode === 'eof') child.stdin.end();
        const code = await new Promise((resolve, reject) => {
            child.once('error', reject); child.once('exit', resolve);
        });
        expect(code).toBe(0);
        expect(stderr).toContain('ready');
        expect(stderr).toContain('closed-before-exit');
    });

    it('cleans up the handler and registered bearer if HTTP binding fails', async () => {
        const occupied = http.createServer();
        await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
        const port = occupied.address().port;
        const startupToken = 'startup-only-secret-token';
        const factory = await factoryWith({ name: 'noop', parameters: z.object({}), execute: async () => 'ok' });
        try {
            await expect(startV2HttpServer(factory, { host: '127.0.0.1', port, auth: { token: startupToken } })).rejects.toMatchObject({ code: 'EADDRINUSE' });
            expect(redactDiagnostic(startupToken)).toBe(startupToken);
        } finally { await new Promise((resolve) => occupied.close(resolve)); }
    });

    it('selects exactly one runtime and keeps FastMCP as the default', () => {
        expect(selectRuntimeKind({})).toBe('fastmcp');
        expect(selectRuntimeKind({ GOOGLE_MCP_USE_SDK_V2: 'false' })).toBe('fastmcp');
        expect(selectRuntimeKind({ GOOGLE_MCP_USE_SDK_V2: 'true' })).toBe('sdk-v2');
        expect(['fastmcp', 'sdk-v2']).toContain(selectRuntimeKind({ GOOGLE_MCP_USE_SDK_V2: '1' }));
    });
});
