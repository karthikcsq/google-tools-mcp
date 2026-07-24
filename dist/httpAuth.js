// Application-level authentication and origin guarding for the shared HTTP
// transport (PR #36 review).
//
// The HTTP transport exposes the full authenticated Google Workspace tool
// surface (Gmail, Drive, Calendar, Docs, ...) over a local URL. Even bound to
// loopback, that URL is reachable by any other process on the machine and — via
// a browser POST or a DNS-rebinding attack — potentially by untrusted web
// content. Protocol-level session isolation does not authorize the caller.
//
// This module adds two gates, applied only in HTTP mode:
//   1. A bearer token. Required by default; auto-generated and logged if the
//      operator did not set one. This defeats untrusted local processes and any
//      browser-delivered request that lacks the token.
//   2. Origin validation. Browser-originated cross-site requests always carry
//      an Origin header; native MCP clients do not. Requests whose Origin is not
//      loopback (or explicitly allow-listed) are rejected — the MCP spec's
//      recommended DNS-rebinding protection.
//
// FastMCP's `authenticate(request)` runs before any tool executes and, in HTTP
// mode, a thrown error is turned into an HTTP 401 by the underlying transport.
// In stdio mode `authenticate` is invoked with no request, so these gates are
// inert there and the default transport is byte-for-byte unaffected.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

/**
 * Resolve HTTP auth configuration from the environment. Pure — no side effects.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveHttpAuthConfig(env = process.env) {
    const explicitToken = (env.GOOGLE_MCP_HTTP_TOKEN || '').trim();
    const noAuth = /^(1|true|yes|on)$/i.test((env.GOOGLE_MCP_HTTP_NO_AUTH || '').trim());
    const host = (env.GOOGLE_MCP_HTTP_HOST || '127.0.0.1').trim();
    const allowedOrigins = (env.GOOGLE_MCP_HTTP_ALLOWED_ORIGINS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return { explicitToken, noAuth, host, allowedOrigins };
}

/** Generate a high-entropy URL-safe token. */
export function generateToken() {
    return randomBytes(24).toString('base64url');
}

/** True if `hostname` is a loopback address. */
export function isLoopbackHost(hostname) {
    return (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '[::1]'
    );
}

/**
 * Decide whether a request's Origin header is acceptable.
 * Absent Origin (native, non-browser clients) is allowed. A present Origin must
 * be loopback or in the explicit allow-list.
 * @param {string|undefined|null} origin
 * @param {string[]} allowedOrigins
 */
export function isOriginAllowed(origin, allowedOrigins = []) {
    if (!origin) return true; // native MCP clients don't send Origin
    if (allowedOrigins.includes(origin)) return true;
    try {
        const u = new URL(origin);
        return isLoopbackHost(u.hostname);
    } catch {
        return false;
    }
}

function firstHeader(value) {
    return Array.isArray(value) ? value[0] : value;
}

/**
 * Pull a bearer token from an incoming request. Accepts
 * `Authorization: Bearer <token>` or an `X-MCP-Token: <token>` header.
 * @param {import('node:http').IncomingMessage} request
 * @returns {string|null}
 */
export function extractBearerToken(request) {
    const headers = request?.headers || {};
    const authHeader = firstHeader(headers['authorization'] ?? headers['Authorization']);
    if (typeof authHeader === 'string') {
        const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
        if (m) return m[1].trim();
    }
    const alt = firstHeader(headers['x-mcp-token']);
    if (typeof alt === 'string' && alt.trim()) return alt.trim();
    return null;
}

/** Constant-time string comparison that won't throw on length mismatch. */
export function tokensMatch(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0) return false;
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
}

/**
 * Build the FastMCP `authenticate(request)` function for HTTP mode.
 * Throws (→ HTTP 401) on a disallowed origin or a missing/invalid token.
 * Returns a session auth object on success.
 *
 * @param {{ token?: string, noAuth?: boolean, allowedOrigins?: string[] }} config
 * @param {{ warn?: Function }} [logger]
 */
export function createHttpAuthenticate(config, logger) {
    return async function authenticate(request) {
        // stdio transport calls authenticate() with no request — nothing to guard.
        if (!request) return {};

        const result = checkHttpAuth(request.headers, config);
        if (!result.ok) {
            logger?.warn?.(result.reason);
            throw new Error(result.message);
        }

        return { authenticated: true };
    };
}

/**
 * Apply the origin and token gates to a plain headers object.
 *
 * Both the FastMCP `authenticate` hook and the transport middleware call this,
 * so there is one definition of what an acceptable request looks like and the
 * two cannot drift apart.
 *
 * @param {Record<string, string|string[]|undefined>} headers
 * @param {{ token?: string, noAuth?: boolean, allowedOrigins?: string[] }} config
 * @returns {{ok: true} | {ok: false, status: number, message: string, reason: string}}
 */
export function checkHttpAuth(headers, config) {
    const { token, noAuth = false, allowedOrigins = [] } = config || {};

    const origin = firstHeader(headers?.origin ?? headers?.Origin);
    if (!isOriginAllowed(origin, allowedOrigins)) {
        return {
            ok: false,
            status: 403,
            message: 'Forbidden: request Origin is not allowed',
            reason: `Rejected HTTP request from disallowed Origin: ${origin}`,
        };
    }

    if (!noAuth) {
        const provided = extractBearerToken({ headers });
        if (!tokensMatch(provided, token)) {
            return {
                ok: false,
                status: 401,
                message: 'Unauthorized: missing or invalid authentication token',
                reason: 'Rejected HTTP request: missing or invalid authentication token.',
            };
        }
    }

    return { ok: true };
}

/**
 * Build a request guard that applies the same gates to every HTTP method.
 *
 * FastMCP's `authenticate` hook is only reached on session creation. In the
 * pinned mcp-proxy that means POST: its GET branch (attaching to a session's
 * event stream) and DELETE branch (terminating a session) dispatch on the
 * Mcp-Session-Id header alone and never call the hook. Anyone who learned a
 * session id could read from or kill that session without presenting a token,
 * while the README promises every request is bearer-protected.
 *
 * Returns true when it has already written a rejection, false to let the
 * request continue.
 *
 * OPTIONS is let through: browsers never attach Authorization to a preflight,
 * and the real request behind it is still gated. Paths other than the MCP
 * endpoint (mcp-proxy's own /ping, for one) are left alone.
 *
 * @param {{ token?: string, noAuth?: boolean, allowedOrigins?: string[] }} config
 * @param {{ warn?: Function }} [logger]
 * @param {string} endpoint the MCP endpoint path, e.g. '/mcp'
 */
export function createHttpRequestGuard(config, logger, endpoint) {
    return function guardRequest(req, res) {
        if (req.method === 'OPTIONS') return false;

        let pathname;
        try {
            pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        } catch {
            return false;
        }
        if (pathname !== endpoint) return false;

        const result = checkHttpAuth(req.headers, config);
        if (result.ok) return false;

        logger?.warn?.(`${result.reason} (${req.method} ${pathname})`);
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(result.status).end(JSON.stringify({ error: result.message }));
        return true;
    };
}

/**
 * Run `start` with every HTTP server it creates wrapped in `guard`.
 *
 * There is no supported way to reach mcp-proxy's request listener: FastMCP does
 * not accept middleware for the stream transport, its Hono app is not what
 * serves this endpoint, and startHTTPServer returns only a close function. So
 * we substitute http.createServer for the duration of startup, wrap whatever
 * listener gets handed to it, and put the original back before returning. The
 * substitution is confined to that window and never touches anything the caller
 * creates before or after.
 *
 * @param {() => Promise<void>} start
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean} guard
 */
export async function startWithRequestGuard(start, guard) {
    const originalCreateServer = http.createServer;
    http.createServer = function patchedCreateServer(...args) {
        const listenerIndex = args.findIndex((arg) => typeof arg === 'function');
        if (listenerIndex !== -1) {
            const listener = args[listenerIndex];
            args[listenerIndex] = function guardedListener(req, res) {
                if (guard(req, res)) return undefined;
                return listener.call(this, req, res);
            };
        }
        return originalCreateServer.apply(this, args);
    };
    try {
        return await start();
    } finally {
        http.createServer = originalCreateServer;
    }
}
