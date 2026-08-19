// Official MCP SDK v2 facade.  This file deliberately owns only the transport
// boundary: tool modules continue to use their established addTool shape.
import http from 'node:http';
import { createRequire } from 'node:module';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { registerAllTools } from './tools/index.js';
import { logger as defaultLogger } from './logger.js';
import { checkHttpAuth, extractBearerToken, isOriginAllowed } from './httpAuth.js';
import { getPublicErrorMessage, registerSecret, redactDiagnostic } from './errors.js';
import { createHttpRequestContext, createStdioConnectionContext, fingerprintCredential, runWithRequestContext, closeStdioConnection } from './requestContext.js';
import { applyResultAnnotations, runWithResultAnnotations, shutdownReadHandleRuntime } from './handleRuntime.js';
import { randomBytes } from 'node:crypto';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const MCP_INSTRUCTIONS = 'Google Workspace tools for Drive, Docs, Sheets, Gmail, Calendar, Forms, Slides, Tasks, and Maps.';
const require = createRequire(import.meta.url);
const DEFAULT_SERVER_INFO = Object.freeze({ name: 'google-tools-mcp', version: require('../package.json').version });
const CACHE_HINT = Object.freeze({ ttlMs: 60_000, cacheScope: 'private' });
const GENERIC_TOOL_FAILURE = 'The tool could not complete safely. Call troubleshoot for diagnostics.';

let runtimeEpochCounter = 0;
/**
 * Mint a fresh read-handle invalidation epoch for each runtime start.
 *
 * This release has no runtime credential/profile rotation path: the bearer token
 * and `GOOGLE_MCP_PROFILE` are resolved once in dist/index.js and never reloaded,
 * so rotation means restarting the process. A per-start epoch makes that
 * restart an actual invalidation rather than an assumption — including a
 * start/close/restart inside one process, where the previous run's handles must
 * not survive into the next.
 */
function nextRuntimeEpoch() {
    runtimeEpochCounter += 1;
    return `epoch-${process.pid}-${runtimeEpochCounter}-${randomBytes(8).toString('base64url')}`;
}

function normalizeResult(result) {
    if (typeof result === 'string') return { content: [{ type: 'text', text: result }] };
    if (result && typeof result === 'object' && Array.isArray(result.content)) return result;
    if (result === undefined || result === null) return { content: [] };
    return { content: [{ type: 'text', text: String(result) }] };
}

function toolFailure(error, toolName, logger) {
    const publicMessage = getPublicErrorMessage(error);
    if (publicMessage !== undefined) {
        return { content: [{ type: 'text', text: String(redactDiagnostic(publicMessage)) }], isError: true };
    }
    logger?.error?.(`MCP tool ${toolName} failed.`, redactDiagnostic(error));
    return { content: [{ type: 'text', text: GENERIC_TOOL_FAILURE }], isError: true };
}

function makeServer(definitions, { logger = defaultLogger, serverInfo = DEFAULT_SERVER_INFO, requestContext = null } = {}) {
    const server = new McpServer(serverInfo, {
        capabilities: { tools: { listChanged: false } },
        instructions: MCP_INSTRUCTIONS,
        cacheHints: { 'server/discover': CACHE_HINT, 'tools/list': CACHE_HINT },
    });
    for (const definition of definitions) {
        server.registerTool(definition.name, { description: definition.description, inputSchema: definition.parameters }, async (args) => {
            try {
                // Tools reach the request context ambiently through
                // dist/requestContext.js rather than through a changed
                // execute() signature: 156 tools keep their exact
                // execute(args, { log }) contract, and a tool that never asks
                // for identity cannot accidentally be handed it.
                // runWithResultAnnotations gives each execution a private slot
                // a tool can drop a minted readHandle into, which is merged
                // back as a top-level result field below.
                const execute = () => runWithResultAnnotations(async () => (
                    applyResultAnnotations(normalizeResult(await definition.execute(args, { log: logger })))
                ));
                return await (requestContext ? runWithRequestContext(requestContext, execute) : execute());
            } catch (error) {
                return toolFailure(error, definition.name, logger);
            }
        });
    }
    return server;
}

/** Preload the legacy addTool registry once, then create side-effect-free SDK instances on demand. */
export async function prepareMcpServerFactory({ registerTools = registerAllTools, logger = defaultLogger, serverInfo } = {}) {
    const definitions = [];
    const names = new Set();
    await registerTools({ addTool(definition) {
        const name = typeof definition?.name === 'string' ? definition.name.trim() : '';
        if (!name) throw new TypeError('MCP tool names must be non-empty strings.');
        if (names.has(name)) throw new TypeError(`Duplicate MCP tool name: ${name}`);
        names.add(name);
        definitions.push(Object.freeze({ ...definition, name }));
    } });
    definitions.sort((left, right) => left.name.localeCompare(right.name));
    const factory = () => makeServer(definitions, { logger, serverInfo });
    factory.withRequestContext = (requestContext) => () => makeServer(definitions, { logger, serverInfo, requestContext });
    return factory;
}

function json(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const CORS_HEADERS = new Set([
    'accept', 'authorization', 'content-type', 'mcp-method', 'mcp-name',
    'mcp-protocol-version', 'x-mcp-token',
]);

function corsPreflight(request, { endpoint, allowedOrigins = [] }) {
    const path = new URL(request.url).pathname;
    if (path !== endpoint && path !== '/healthz') return json(404, { error: 'Not found' });
    const origin = request.headers.get('origin');
    if (!origin || !isOriginAllowed(origin, allowedOrigins)) return json(403, { error: 'Forbidden: request Origin is not allowed' });
    const requestedMethod = (request.headers.get('access-control-request-method') || '').toUpperCase();
    const permittedMethod = path === endpoint ? 'POST' : 'GET';
    if (requestedMethod !== permittedMethod) return json(403, { error: 'Forbidden: requested method is not allowed' });
    const requestedHeaders = (request.headers.get('access-control-request-headers') || '')
        .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (requestedHeaders.some((header) => !CORS_HEADERS.has(header))) {
        return json(403, { error: 'Forbidden: requested header is not allowed' });
    }
    return new Response(null, { status: 204, headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': permittedMethod,
        'access-control-allow-headers': requestedHeaders.join(', '),
        vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
    } });
}

async function isModernRequest(request) {
    if (request.method !== 'POST') return false;
    try {
        const body = await request.clone().json();
        return Boolean(body?.params?._meta?.['io.modelcontextprotocol/protocolVersion']);
    } catch { return false; }
}

async function closeListenResponse(response) {
    if (!response.body) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream({
        async start(controller) {
            try {
                const first = await reader.read();
                if (!first.done) controller.enqueue(first.value);
            } finally {
                await reader.cancel().catch(() => {});
                controller.close();
            }
        },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Build an authenticated stateless HTTP Fetch handler. It intentionally does not expose /sse. */
export function createV2HttpHandler(factory, {
    auth, profile = 'default', epoch = nextRuntimeEpoch(), endpoint = '/mcp', logger = defaultLogger,
} = {}) {
    const handler = createMcpHandler(factory);
    const unregisterSecret = auth?.token ? registerSecret(auth.token) : () => {};
    let closed = false;
    async function fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === 'OPTIONS') return corsPreflight(request, { endpoint, allowedOrigins: auth?.allowedOrigins });
        const result = checkHttpAuth(Object.fromEntries(request.headers), auth);
        if (!result.ok) {
            logger?.warn?.(result.reason);
            return json(result.status, { error: result.message });
        }
        if (path === '/healthz' && request.method === 'GET') return json(200, { status: 'ok' });
        if (path !== endpoint) return json(404, { error: 'Not found' });
        if (closed) return json(503, { error: 'Service unavailable' });
        const modern = await isModernRequest(request);
        if (modern && !request.headers.get('mcp-protocol-version')) {
            return json(400, { error: 'MCP-Protocol-Version is required for modern MCP requests' });
        }
        const token = auth?.noAuth ? 'http-no-auth' : (extractBearerToken({ headers: Object.fromEntries(request.headers) }) || '');
        const context = createHttpRequestContext({ principalFingerprint: fingerprintCredential(token), profile, epoch });
        const response = await runWithRequestContext(context, () => handler.fetch(request));
        if (modern && request.headers.get('mcp-method') === 'subscriptions/listen') return closeListenResponse(response);
        return response;
    }
    return Object.freeze({ fetch, async close() {
        closed = true;
        unregisterSecret();
        await handler.close();
        // Reclaim clean per-handle workspaces and report any dirty file that
        // must survive shutdown (plan §3).
        await shutdownReadHandleRuntime({ logger });
    } });
}

export async function startV2HttpServer(factory, options = {}) {
    const handler = createV2HttpHandler(factory, options);
    const nodeHandler = toNodeHandler(handler, { onerror: (error) => options.logger?.error?.('MCP HTTP handler failed.', redactDiagnostic(error)) });
    const server = http.createServer((req, res) => { void nodeHandler(req, res); });
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(options.port, options.host, resolve);
        });
    } catch (error) {
        await handler.close();
        if (server.listening) await new Promise((resolve) => server.close(resolve));
        throw error;
    }
    return Object.freeze({
        server,
        handler,
        async close() { await handler.close(); await new Promise((resolve) => server.close(resolve)); },
    });
}

/** Start a connection-pinned stdio server and retain EOF cleanup missing from SDK 2.0.0. */
export function startV2Stdio(factory, { profile = 'default', epoch = nextRuntimeEpoch(), logger = defaultLogger, input = process.stdin, output = process.stdout } = {}) {
    const context = createStdioConnectionContext({ principalFingerprint: fingerprintCredential('stdio'), profile, epoch });
    const connectionFactory = typeof factory.withRequestContext === 'function'
        ? factory.withRequestContext(context)
        : factory;
    const handle = serveStdio(connectionFactory, {
        transport: new StdioServerTransport(input, output),
        onerror: (error) => logger?.error?.('MCP stdio transport failed.', redactDiagnostic(error)),
    });
    let closePromise = null;
    const close = () => {
        if (closePromise) return closePromise;
        closePromise = (async () => {
            input.removeListener('end', onEnd);
            input.removeListener('close', onClose);
            closeStdioConnection(context);
            await handle.close();
            await shutdownReadHandleRuntime({ logger });
        })();
        return closePromise;
    };
    const onEnd = () => { void close(); };
    const onClose = () => { void close(); };
    input.once('end', onEnd);
    input.once('close', onClose);
    return Object.freeze({ close, context, output });
}

export function selectRuntimeKind(env = process.env) {
    return /^(1|true|yes|on)$/i.test(env.GOOGLE_MCP_USE_SDK_V2 || '') ? 'sdk-v2' : 'fastmcp';
}

/** Install one lifecycle owner. Every exit path awaits runtime.close first. */
export function installRuntimeLifecycle(runtime, {
    processRef = process, input = process.stdin, useStdio = true, logger = defaultLogger,
    exit = (code) => processRef.exit(code),
} = {}) {
    let shuttingDown = false;
    const cleanup = () => {
        processRef.removeListener('SIGINT', onSigint);
        processRef.removeListener('SIGTERM', onSigterm);
        if (useStdio) {
            input.removeListener('end', onEof);
            input.removeListener('close', onEof);
        }
    };
    const shutdown = async (code = 0) => {
        if (shuttingDown) return;
        shuttingDown = true;
        cleanup();
        try { await runtime.close(); }
        catch (error) { logger?.error?.('MCP runtime shutdown failed.', redactDiagnostic(error)); }
        exit(code);
    };
    const onSigint = () => { void shutdown(0); };
    const onSigterm = () => { void shutdown(0); };
    const onEof = () => { void shutdown(0); };
    processRef.once('SIGINT', onSigint);
    processRef.once('SIGTERM', onSigterm);
    if (useStdio) {
        input.once('end', onEof);
        input.once('close', onEof);
    }
    return Object.freeze({ shutdown, cleanup });
}
