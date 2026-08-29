// Official MCP SDK v2 facade.  This file deliberately owns only the transport
// boundary: tool modules continue to use their established addTool shape.
import http from 'node:http';
import { createRequire } from 'node:module';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { registerAllTools } from './tools/index.js';
import { getArgumentShape, logger as defaultLogger, logToolCall } from './logger.js';
import { checkHttpAuth, extractBearerToken, isOriginAllowed } from './httpAuth.js';
import { getPublicErrorMessage, isPublicError, registerSecret, redactDiagnostic } from './errors.js';
import { createHttpRequestContext, createStdioConnectionContext, fingerprintCredential, runWithRequestContext, closeStdioConnection } from './requestContext.js';
import { applyResultAnnotations, runWithResultAnnotations, shutdownReadHandleRuntime } from './handleRuntime.js';
import { randomBytes } from 'node:crypto';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const MCP_INSTRUCTIONS = 'Google Workspace tools for Drive, Docs, Sheets, Gmail, Calendar, Forms, Slides, Tasks, and Maps.';
const require = createRequire(import.meta.url);
const DEFAULT_SERVER_INFO = Object.freeze({ name: 'google-tools-mcp', version: require('../package.json').version });
const CACHE_HINT = Object.freeze({ ttlMs: 60_000, cacheScope: 'private' });
const GENERIC_TOOL_FAILURE = 'The tool could not complete safely. Call troubleshoot for diagnostics.';
// The draft schema's HEADER_MISMATCH (SEP-2243) code, confirmed against the
// installed SDK's own emitter for every other header/body mismatch cell:
// node_modules/@modelcontextprotocol/server/dist/src-CX2iR2pK.mjs
// HEADER_MISMATCH_ERROR_CODE.
const HEADER_MISMATCH_ERROR_CODE = -32020;
// Wire meta keys the SDK stamps onto its own graceful subscriptions/listen
// close (node_modules/@modelcontextprotocol/server/dist/mcp-DXXb3Vv3.mjs
// SUBSCRIPTION_ID_META_KEY / SERVER_INFO_META_KEY, and the anchored
// SubscriptionsListenResultMetaSchema in src-CX2iR2pK.mjs). Not re-exported
// from the package's public entry points, so pinned here as literal wire
// strings rather than imported.
const SUBSCRIPTION_ID_META_KEY = 'io.modelcontextprotocol/subscriptionId';
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

let runtimeEpochCounter = 0;
let toolRequestCounter = 0;
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

function classifyToolError(error) {
    // Public errors can deliberately include caller-provided identifiers or
    // text. Keep the JSONL diagnostic useful without turning it into a copy of
    // the caller-visible response, which is persisted by default.
    if (isPublicError(error)) return { outcome: 'user_error', errCode: 'USER_ERROR', errMsg: 'caller-visible error' };
    const status = Number.isInteger(error?.status) ? error.status : undefined;
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_:-]{0,79}$/.test(error.code)
        ? error.code : status ? `HTTP_${status}` : 'INTERNAL_ERROR';
    return { outcome: 'error', errCode: code, errMsg: 'The tool could not complete safely.' };
}

function makeServer(definitions, { logger = defaultLogger, serverInfo = DEFAULT_SERVER_INFO, requestContext = null } = {}) {
    const server = new McpServer(serverInfo, {
        capabilities: { tools: { listChanged: false } },
        instructions: MCP_INSTRUCTIONS,
        cacheHints: { 'server/discover': CACHE_HINT, 'tools/list': CACHE_HINT },
    });
    for (const definition of definitions) {
        server.registerTool(definition.name, { description: definition.description, inputSchema: definition.parameters }, async (args) => {
            const startedAt = Date.now();
            const reqId = ++toolRequestCounter;
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
                const result = await (requestContext ? runWithRequestContext(requestContext, execute) : execute());
                logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: definition.name, reqId,
                    durationMs: Date.now() - startedAt, outcome: 'ok', errCode: null, errMsg: null, argShape: getArgumentShape(args) });
                return result;
            } catch (error) {
                logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: definition.name, reqId,
                    durationMs: Date.now() - startedAt, ...classifyToolError(error), argShape: getArgumentShape(args) });
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

/**
 * Classify a POST as modern (2026-07-28+) traffic by its body's `_meta`
 * envelope claim, mirroring the SDK's own body-primary classifier
 * (node_modules/@modelcontextprotocol/server/dist/src-CX2iR2pK.mjs
 * classifyRequestBody / hasEnvelopeClaim). Also extracts the JSON-RPC id and
 * claimed protocol version so a header-mismatch response emitted before the
 * SDK ever sees the request can still address the pending request id,
 * exactly like a response the SDK itself would produce.
 */
async function classifyModernRequest(request) {
    if (request.method !== 'POST') return { modern: false, id: null };
    try {
        const body = await request.clone().json();
        const claimedVersion = body?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
        const id = typeof body?.id === 'string' || typeof body?.id === 'number' ? body.id : null;
        return { modern: Boolean(claimedVersion), id, claimedVersion };
    } catch { return { modern: false, id: null }; }
}

/**
 * The `-32020` (HeaderMismatch) response for a modern-classified request
 * whose `MCP-Protocol-Version` header is entirely absent
 * (typescript-sdk#2589) -- the one header/body mismatch cell the installed
 * @modelcontextprotocol/server@2.0.0 leaves unenforced (it only cross-checks
 * the header when present; see the "rejects modern POST header/body
 * mismatches" test in tests/mcpServerFacade.test.js, which pins every cell
 * the SDK *does* enforce natively). Built by hand to match the identical
 * shape the SDK emits for every other -32020 cell:
 * node_modules/@modelcontextprotocol/server/dist/index.mjs
 * jsonRpcErrorResponse/rejectionResponse -- `{jsonrpc, id, error:{code,
 * message, data}}` at HTTP 400 -- and the `data.mismatch` shape
 * node_modules/@modelcontextprotocol/server/dist/src-CX2iR2pK.mjs
 * crossCheckMismatch uses, including its "(missing)" sentinel for an absent
 * header value.
 */
function headerMismatchResponse(id, claimedVersion) {
    const body = `the request body claims protocol revision ${claimedVersion} but the required MCP-Protocol-Version header is absent`;
    return Response.json({
        jsonrpc: '2.0',
        id: id ?? null,
        error: {
            code: HEADER_MISMATCH_ERROR_CODE,
            message: `Bad Request: the request headers and body disagree: ${body}`,
            data: { mismatch: { header: '(missing)', body } },
        },
    }, { status: 400 });
}

/**
 * Access-Control-Allow-Origin + Vary: Origin to attach to every real
 * response on an allowed browser Origin -- CORS headers were previously only
 * emitted on the OPTIONS preflight (corsPreflight above), so a browser at an
 * allowed origin could complete a real POST and then be blocked from reading
 * the response. Returns null when no Origin header is present (native MCP
 * clients never send one) or the Origin is not allowed: never reflect a
 * disallowed origin, and never add the header to a native request.
 */
function corsResponseHeaders(request, allowedOrigins) {
    const origin = request.headers.get('origin');
    if (!origin || !isOriginAllowed(origin, allowedOrigins)) return null;
    return { 'access-control-allow-origin': origin, vary: 'Origin' };
}

/**
 * Attach CORS headers to a response without assuming its headers are
 * mutable. `handler.fetch()` (the SDK's own Response) may return a Response
 * whose Headers are not safe to mutate in place, so this always constructs a
 * new Response wrapping the same body/status rather than calling
 * `.headers.set()` on the original. Forwarding `response.body` (a
 * ReadableStream reference, never read here) keeps a streaming response
 * (subscriptions/listen) streaming.
 */
function withCors(response, corsHeaders) {
    if (!corsHeaders) return response;
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Close subscriptions/listen gracefully instead of dropping the connection.
 *
 * This server never has anything to notify (plan §4: no dynamic tool/resource
 * list, so the honored notification subset is always {}), and the installed
 * SDK's own listenRouter (node_modules/@modelcontextprotocol/server/dist/
 * mcp-DXXb3Vv3.mjs createListenRouter) holds such a subscription's SSE stream
 * open indefinitely: confirmed live against this build (see
 * scratch-inspect-raw-listen.mjs, run against createMcpHandler directly with
 * no facade wrapping) -- after the acknowledgement frame the raw SDK stream
 * never emits again and only closes when the whole handler shuts down
 * (typescript-sdk#2650).
 *
 * A supported SDK API was investigated first: `handler.close()` does call
 * `listenRouter.closeAll()`, which tears down every open subscription
 * gracefully, writing the exact terminal frame this function builds by hand
 * (createListenRouter's internal `teardown(graceful=true)`). But that closes
 * the ENTIRE handler for every in-flight request, not this one request's
 * subscription -- and the object createMcpHandler returns exposes only
 * `fetch`/`notify`/`bus`/`close`, no per-subscription handle to call teardown
 * on selectively. There is no supported API to gracefully end a single empty
 * subscription without shutting the whole handler down, so this is the
 * narrow wrapper the plan calls for, to be deleted once #2650 lands
 * upstream.
 *
 * The terminal frame is built byte-for-byte to match the SDK's own graceful
 * close: an `event: message` SSE frame carrying
 * `{jsonrpc:'2.0', id, result:{resultType:'complete', _meta:{...}}}` for the
 * original subscriptions/listen request id (the wire shape pinned by
 * SubscriptionsListenResultSchema / SubscriptionsListenResultMetaSchema in
 * node_modules/@modelcontextprotocol/server/dist/src-CX2iR2pK.mjs), so a
 * client that already recognizes that shape (Claude Code's own #2650
 * workaround) reads this close as graceful rather than an unexpected remote
 * disconnect.
 */
/**
 * True only when the SDK's response to a subscriptions/listen POST is an
 * actual SSE stream. createListenRouter returns a plain application/json
 * JSON-RPC error Response -- not SSE -- for invalid or missing
 * params.notifications (-32602) and for subscription-capacity rejection
 * (-32603). closeListenResponse appends an SSE terminal frame to whatever
 * body it is given, which would corrupt those JSON error bodies, so only a
 * genuine text/event-stream response gets the graceful-close treatment.
 */
function isEventStreamResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    return /^\s*text\/event-stream\s*(;.*)?$/i.test(contentType);
}

async function closeListenResponse(response, { id, serverInfo } = {}) {
    if (!response.body) return response;
    const reader = response.body.getReader();
    const encoder = new TextEncoder();
    const body = new ReadableStream({
        async start(controller) {
            try {
                const first = await reader.read();
                if (!first.done) controller.enqueue(first.value);
                if (id !== undefined && id !== null) {
                    const frame = `event: message\ndata: ${JSON.stringify({
                        jsonrpc: '2.0',
                        id,
                        result: {
                            resultType: 'complete',
                            _meta: {
                                [SUBSCRIPTION_ID_META_KEY]: id,
                                ...(serverInfo ? { [SERVER_INFO_META_KEY]: serverInfo } : {}),
                            },
                        },
                    })}\n\n`;
                    controller.enqueue(encoder.encode(frame));
                }
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
        // Computed once per request, on the Origin header alone, so it applies
        // identically to every response below -- success, auth failure, 404,
        // 503, and the header-mismatch/listen-close paths -- without
        // reflecting a disallowed origin (corsResponseHeaders returns null for
        // that case, matching checkHttpAuth's own origin gate below).
        const corsHeaders = corsResponseHeaders(request, auth?.allowedOrigins);
        const respond = (res) => withCors(res, corsHeaders);
        const result = checkHttpAuth(Object.fromEntries(request.headers), auth);
        if (!result.ok) {
            logger?.warn?.(result.reason);
            return respond(json(result.status, { error: result.message }));
        }
        if (path === '/healthz' && request.method === 'GET') return respond(json(200, { status: 'ok', pid: process.pid }));
        if (path !== endpoint) return respond(json(404, { error: 'Not found' }));
        if (closed) return respond(json(503, { error: 'Service unavailable' }));
        const requestInfo = await classifyModernRequest(request);
        if (requestInfo.modern && !request.headers.get('mcp-protocol-version')) {
            return respond(headerMismatchResponse(requestInfo.id, requestInfo.claimedVersion));
        }
        const token = auth?.noAuth ? 'http-no-auth' : (extractBearerToken({ headers: Object.fromEntries(request.headers) }) || '');
        const context = createHttpRequestContext({ principalFingerprint: fingerprintCredential(token), profile, epoch });
        const response = await runWithRequestContext(context, () => handler.fetch(request));
        if (requestInfo.modern && request.headers.get('mcp-method') === 'subscriptions/listen' && isEventStreamResponse(response)) {
            return respond(await closeListenResponse(response, { id: requestInfo.id, serverInfo: DEFAULT_SERVER_INFO }));
        }
        return respond(response);
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
