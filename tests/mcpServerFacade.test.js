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

    it('answers server/discover well-formed and inside a strict time bound (Claude Code stalls 30s on a slow/malformed reply)', async () => {
        const factory = await factoryWith({ name: 'noop', description: 'n', parameters: z.object({}), execute: async () => 'ok' });
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const start = Date.now();
            const response = await handler.fetch(modern('server/discover'));
            const discover = await response.json();
            const elapsedMs = Date.now() - start;
            expect(elapsedMs).toBeLessThan(2000);
            expect(discover.result.supportedVersions).toContain(MCP_PROTOCOL_VERSION);
            expect(discover.result.capabilities.tools.listChanged).toBe(false);
            expect(discover.result._meta['io.modelcontextprotocol/serverInfo']).toEqual({ name: 'google-tools-mcp', version: '2.0.0' });
            expect(discover.result.instructions).toContain('Google Workspace tools');
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

    // Gap #1 (docs/plans/mcp-2026-07-28-migration.md §4): modern POSTs must carry
    // MCP-Protocol-Version, Mcp-Method, and Mcp-Name in agreement with the body, or
    // fail 400/-32020 (HeaderMismatch). Per the plan, the facade is only required
    // to add a check the SDK itself does not already enforce (historically
    // typescript-sdk#2589: a modern POST with an absent MCP-Protocol-Version header).
    // Exercising the installed @modelcontextprotocol/server@2.0.0 directly (see
    // node_modules/@modelcontextprotocol/server/dist/src-CX2iR2pK.mjs
    // classifyRequestBody/validateStandardRequestHeaders) shows this snapshot
    // already rejects Mcp-Method/Mcp-Name mismatches and absences with 400/-32020
    // on its own; only the MCP-Protocol-Version *absence* case is left unenforced
    // by the SDK (the classifier only cross-checks the header when it is present),
    // which is exactly what the facade's existing pre-SDK check above (missingHeader)
    // covers. This test pins the SDK's native -32020 behavior for the header/method/
    // name cells so an SDK upgrade that changes it is caught here, and confirms
    // legacy POSTs (which carry none of these headers) are never affected.
    it('rejects modern POST header/body mismatches with 400 and -32020, leaving legacy POSTs unaffected', async () => {
        const factory = await factoryWith({ name: 'noop', description: 'n', parameters: z.object({}), execute: async () => 'ok' });
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        const expectHeaderMismatch = async (request) => {
            const response = await handler.fetch(request);
            expect(response.status).toBe(400);
            const body = await response.json();
            expect(body.error.code).toBe(-32020);
        };
        try {
            // Mcp-Method header disagrees with the body's method.
            await expectHeaderMismatch(modern('tools/list', {}, { 'mcp-method': 'tools/call' }));

            // Mcp-Method header absent entirely.
            const noMethod = modern('tools/list');
            noMethod.headers.delete('mcp-method');
            await expectHeaderMismatch(noMethod);

            // Mcp-Name header disagrees with params.name on tools/call.
            await expectHeaderMismatch(modern('tools/call', { name: 'noop', arguments: {} }, { 'mcp-name': 'not-noop' }));

            // Mcp-Name header absent while the body names params.name on tools/call.
            const noName = modern('tools/call', { name: 'noop', arguments: {} }, { 'mcp-name': 'noop' });
            noName.headers.delete('mcp-name');
            await expectHeaderMismatch(noName);

            // A correctly-headered modern call still succeeds (the checks are not overzealous).
            const okCall = await (await handler.fetch(modern('tools/call', { name: 'noop', arguments: {} }, { 'mcp-name': 'noop' }))).json();
            expect(okCall.result.content).toEqual([{ type: 'text', text: 'ok' }]);

            // Legacy POSTs carry none of these headers and must keep working unchanged.
            const initialized = await legacyJson(await handler.fetch(legacy('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })));
            expect(initialized.result.protocolVersion).toBe('2025-11-25');
            const called = await legacyJson(await handler.fetch(legacy('tools/call', { name: 'noop', arguments: {} }, 2)));
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

    it('treats modern _meta client identity as non-authoritative observability data', async () => {
        const factory = await factoryWith({ name: 'identity', parameters: z.object({}), execute: async () => getRequestContext().principalFingerprint });
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        const spoofedMeta = {
            'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'admin-console', version: 'root', role: 'administrator', privileged: true },
        };
        const buildRequest = ({ authorized }) => new Request('http://localhost/mcp', {
            method: 'POST',
            headers: {
                ...(authorized ? { authorization: `Bearer ${TOKEN}` } : {}),
                'content-type': 'application/json',
                'mcp-protocol-version': MCP_PROTOCOL_VERSION,
                'mcp-method': 'tools/call',
                'mcp-name': 'identity',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'identity', arguments: {}, _meta: spoofedMeta } }),
        });
        try {
            const spoofedResponse = await handler.fetch(buildRequest({ authorized: true }));
            const spoofedResult = await spoofedResponse.json();
            const normalResponse = await handler.fetch(modern('tools/call', { name: 'identity', arguments: {} }, { 'mcp-name': 'identity' }));
            const normalResult = await normalResponse.json();
            // Spoofed client identity gets the exact same non-privileged fingerprint as an
            // ordinary call authenticated with the same bearer token -- it grants nothing.
            expect(spoofedResult.result.content[0].text).toBe(normalResult.result.content[0].text);
            expect(spoofedResult.result.content[0].text).toMatch(/^hmac-sha256:[A-Za-z0-9_-]{43}$/);
            // The spoofed identity claim never leaks into any response payload.
            const serialized = JSON.stringify(spoofedResult);
            expect(serialized).not.toContain('admin-console');
            expect(serialized).not.toContain('administrator');
            expect(serialized).not.toContain('privileged');

            // The same spoofed _meta grants no bypass of authentication.
            const unauthenticated = await handler.fetch(buildRequest({ authorized: false }));
            expect(unauthenticated.status).toBe(401);
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

    it('serves a legacy (pre-2026-07-28) stdio client through its supported initialize handshake and a tool call', async () => {
        // The installed @modelcontextprotocol/server@2.0.0 stdio entry (see
        // node_modules/@modelcontextprotocol/server/dist/stdio.mjs serveStdio,
        // default options.legacy === 'serve') classifies an opening message with
        // no per-request _meta envelope claim as "legacy" and pins the connection
        // to a legacy-era server instance for its lifetime -- observed real support,
        // not a fake pin.
        const input = new PassThrough();
        const output = new PassThrough();
        const logger = { info: jest.fn(), error: jest.fn() };
        const factory = await prepareMcpServerFactory({ logger, registerTools: async (server) => server.addTool({ name: 'echo', description: 'e', parameters: z.object({ text: z.string() }), execute: async ({ text }) => text }) });
        const runtime = startV2Stdio(factory, { input, output, logger });
        const next = stdioMessages(output);
        const send = (id, method, params = {}) => input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        try {
            send(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1' } });
            const initialized = await next();
            expect(initialized.result.protocolVersion).toBe('2025-11-25');
            input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
            send(2, 'tools/list');
            expect((await next()).result.tools.map(({ name }) => name)).toEqual(['echo']);
            send(3, 'tools/call', { name: 'echo', arguments: { text: 'legacy-wire' } });
            expect((await next()).result.content[0].text).toBe('legacy-wire');
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
