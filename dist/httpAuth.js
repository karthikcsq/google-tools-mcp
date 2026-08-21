// Application-level authentication and origin guarding for the shared HTTP
// transport (PR #36 review).
//
// The HTTP transport exposes the full authenticated Google Workspace tool
// surface (Gmail, Drive, Calendar, Docs, ...) over a local URL. Even bound to
// loopback, that URL is reachable by any other process on the machine and — via
// a browser POST or a DNS-rebinding attack — potentially by untrusted web
// content. Reaching the endpoint is not the same as being authorized to use it.
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
// These are pure helpers. The only caller that applies them is the HTTP
// facade in dist/mcpServer.js, which runs `checkHttpAuth` as middleware ahead
// of the SDK handler, `/healthz`, and the 404 for every other path — so one
// gate covers every method and every route. stdio never reaches this module.
//
// The session era's `createHttpRequestGuard` / `startWithRequestGuard`
// `http.createServer` monkey-patch is gone with the FastMCP/mcp-proxy runtime
// it existed to reach inside: there is no `Mcp-Session-Id`-dispatched GET or
// DELETE branch left to bypass an auth hook, and no unremovable `/sse` or
// `/messages` route standing itself up alongside the configured endpoint.
import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Resolve HTTP auth configuration from the environment. Pure — no side effects.
 * Does not validate the combination of `noAuth` and `host` — call
 * `assertSafeHttpBinding` on the result before starting the HTTP transport.
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

/**
 * Refuse configurations that would expose the authenticated Google Workspace
 * tool surface (Gmail, Drive, Calendar, Docs, ...) with no way to keep out an
 * unauthenticated remote caller.
 *
 * Shared service operation is loopback-only until the project provides TLS
 * and a supported remote-deployment authentication boundary. A non-loopback
 * bind therefore stops startup in every token mode.
 * An empty or whitespace-only host after trimming is also refused. `env.HOST || '...'`
 *      treats a whitespace string as truthy, so `GOOGLE_MCP_HTTP_HOST="  "`
 *      previously resolved to `''`, which Node's http server can bind as "all
 *      interfaces" instead of the intended loopback default.
 *
 * @param {{ host: string, noAuth: boolean }} config result of resolveHttpAuthConfig
 * @throws {Error} with an operator-facing message if the combination is unsafe
 */
export function assertSafeHttpBinding({ host }) {
    const trimmedHost = typeof host === 'string' ? host.trim() : '';
    if (!trimmedHost) {
        throw new Error(
            'GOOGLE_MCP_HTTP_HOST resolved to an empty value after trimming. Refusing to start: ' +
            'an empty host can make the HTTP server bind to all interfaces instead of loopback. ' +
            'Unset GOOGLE_MCP_HTTP_HOST to use the 127.0.0.1 default, or set it to a real host.'
        );
    }
    if (!isLoopbackHost(trimmedHost)) {
        throw new Error(
            `Refusing to start: GOOGLE_MCP_HTTP_HOST is '${trimmedHost}', which is not loopback. ` +
            'Shared HTTP service mode is loopback-only until TLS and supported remote deployment ' +
            'authentication exist. Bind to 127.0.0.1, localhost, or ::1.'
        );
    }
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
 * Apply the origin and token gates to a plain headers object.
 *
 * The single definition of what an acceptable HTTP request looks like. The
 * facade calls it once per request, before routing, so `/healthz`, `/mcp`, and
 * the 404 for everything else are all gated identically.
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
