// Tests for the shared HTTP transport's application-level auth + origin guard
// (PR #36 review). These exercise the pure auth helpers and `checkHttpAuth`,
// the single gate the facade in dist/mcpServer.js runs ahead of routing — no
// network or Google APIs.
//
// The session era's two extra entry points are gone with the FastMCP runtime:
// `createHttpAuthenticate` (the hook FastMCP called on session creation) and
// `createHttpRequestGuard` / `startWithRequestGuard` (the http.createServer
// monkey-patch that covered the Mcp-Session-Id-dispatched GET/DELETE branches
// and mcp-proxy's unremovable /sse and /messages routes). Their coverage lives
// on here as `checkHttpAuth` cases, plus the facade's own wire tests in
// tests/mcpServerFacade.test.js, which assert the gate runs before /healthz,
// before /mcp, and before the 404 that former session routes now get.
import { describe, it, expect } from '@jest/globals';
import {
    resolveHttpAuthConfig,
    assertSafeHttpBinding,
    generateToken,
    isLoopbackHost,
    isOriginAllowed,
    extractBearerToken,
    tokensMatch,
    checkHttpAuth,
} from '../dist/httpAuth.js';

// Minimal http.IncomingMessage stand-in: only headers are read.
const req = (headers = {}) => ({ headers });

describe('httpAuth', () => {
    describe('resolveHttpAuthConfig', () => {
        it('defaults to loopback host, auth enabled, no explicit token', () => {
            const cfg = resolveHttpAuthConfig({});
            expect(cfg.host).toBe('127.0.0.1');
            expect(cfg.noAuth).toBe(false);
            expect(cfg.explicitToken).toBe('');
            expect(cfg.allowedOrigins).toEqual([]);
        });

        it('reads explicit token, host, and allow-listed origins', () => {
            const cfg = resolveHttpAuthConfig({
                GOOGLE_MCP_HTTP_TOKEN: '  secret123  ',
                GOOGLE_MCP_HTTP_HOST: '0.0.0.0',
                GOOGLE_MCP_HTTP_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
            });
            expect(cfg.explicitToken).toBe('secret123');
            expect(cfg.host).toBe('0.0.0.0');
            expect(cfg.allowedOrigins).toEqual(['https://a.example', 'https://b.example']);
        });

        it('parses the no-auth opt-out flag', () => {
            expect(resolveHttpAuthConfig({ GOOGLE_MCP_HTTP_NO_AUTH: '1' }).noAuth).toBe(true);
            expect(resolveHttpAuthConfig({ GOOGLE_MCP_HTTP_NO_AUTH: 'true' }).noAuth).toBe(true);
            expect(resolveHttpAuthConfig({ GOOGLE_MCP_HTTP_NO_AUTH: 'no' }).noAuth).toBe(false);
            expect(resolveHttpAuthConfig({ GOOGLE_MCP_HTTP_NO_AUTH: '' }).noAuth).toBe(false);
        });

        it('resolves a whitespace-only host down to an empty string', () => {
            // `env.HOST || '127.0.0.1'` treats a whitespace-only string as truthy,
            // so it is never replaced by the loopback default; only the
            // subsequent .trim() empties it. assertSafeHttpBinding is what
            // actually rejects this, not resolveHttpAuthConfig itself.
            expect(resolveHttpAuthConfig({ GOOGLE_MCP_HTTP_HOST: '   ' }).host).toBe('');
        });

        it('feeds a remote-exposure combination straight into assertSafeHttpBinding', () => {
            const cfg = resolveHttpAuthConfig({
                GOOGLE_MCP_HTTP_NO_AUTH: '1',
                GOOGLE_MCP_HTTP_HOST: '0.0.0.0',
            });
            expect(() => assertSafeHttpBinding(cfg)).toThrow(/Refusing to start/);
        });
    });

    // Merge-blocking finding on PR #59: GOOGLE_MCP_HTTP_NO_AUTH=1 combined with
    // a non-loopback GOOGLE_MCP_HTTP_HOST (e.g. 0.0.0.0) started a remotely
    // reachable, completely unauthenticated server. A log line after binding
    // is not a safeguard for that credential boundary — startup must refuse.
    describe('assertSafeHttpBinding', () => {
        it('allows noAuth with a loopback host', () => {
            expect(() => assertSafeHttpBinding({ host: '127.0.0.1', noAuth: true })).not.toThrow();
            expect(() => assertSafeHttpBinding({ host: 'localhost', noAuth: true })).not.toThrow();
            expect(() => assertSafeHttpBinding({ host: '::1', noAuth: true })).not.toThrow();
        });

        it('allows a non-loopback host when auth is required', () => {
            expect(() => assertSafeHttpBinding({ host: '0.0.0.0', noAuth: false })).not.toThrow();
        });

        it('rejects noAuth combined with a non-loopback IPv4 host', () => {
            expect(() => assertSafeHttpBinding({ host: '0.0.0.0', noAuth: true })).toThrow(/Refusing to start/);
        });

        it('rejects noAuth combined with the IPv6 unspecified host', () => {
            expect(() => assertSafeHttpBinding({ host: '::', noAuth: true })).toThrow(/Refusing to start/);
        });

        it('rejects noAuth combined with a LAN/hostname host', () => {
            expect(() => assertSafeHttpBinding({ host: '192.168.1.50', noAuth: true })).toThrow(/Refusing to start/);
            expect(() => assertSafeHttpBinding({ host: 'my-machine.local', noAuth: true })).toThrow(/Refusing to start/);
        });

        it('rejects an empty host after trimming regardless of noAuth', () => {
            expect(() => assertSafeHttpBinding({ host: '', noAuth: false })).toThrow(/empty/);
            expect(() => assertSafeHttpBinding({ host: '   ', noAuth: false })).toThrow(/empty/);
            expect(() => assertSafeHttpBinding({ host: '   ', noAuth: true })).toThrow(/empty/);
        });
    });

    describe('generateToken', () => {
        it('produces a high-entropy, URL-safe, non-repeating token', () => {
            const a = generateToken();
            const b = generateToken();
            expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
            expect(a.length).toBeGreaterThanOrEqual(24);
            expect(a).not.toBe(b);
        });
    });

    describe('isLoopbackHost', () => {
        it('recognizes loopback addresses', () => {
            expect(isLoopbackHost('localhost')).toBe(true);
            expect(isLoopbackHost('127.0.0.1')).toBe(true);
            expect(isLoopbackHost('::1')).toBe(true);
        });
        it('rejects non-loopback addresses', () => {
            expect(isLoopbackHost('evil.example')).toBe(false);
            expect(isLoopbackHost('10.0.0.5')).toBe(false);
        });
    });

    describe('isOriginAllowed', () => {
        it('allows requests with no Origin (native MCP clients)', () => {
            expect(isOriginAllowed(undefined, [])).toBe(true);
            expect(isOriginAllowed('', [])).toBe(true);
        });
        it('allows loopback origins', () => {
            expect(isOriginAllowed('http://localhost:3000', [])).toBe(true);
            expect(isOriginAllowed('http://127.0.0.1:9999', [])).toBe(true);
        });
        it('rejects foreign browser origins', () => {
            expect(isOriginAllowed('https://evil.example', [])).toBe(false);
        });
        it('honors the explicit allow-list', () => {
            expect(isOriginAllowed('https://trusted.example', ['https://trusted.example'])).toBe(true);
        });
        it('rejects malformed origins', () => {
            expect(isOriginAllowed('not a url', [])).toBe(false);
        });
    });

    describe('extractBearerToken', () => {
        it('parses a Bearer Authorization header', () => {
            expect(extractBearerToken(req({ authorization: 'Bearer abc.def' }))).toBe('abc.def');
            expect(extractBearerToken(req({ authorization: 'bearer XYZ' }))).toBe('XYZ');
        });
        it('falls back to X-MCP-Token', () => {
            expect(extractBearerToken(req({ 'x-mcp-token': 'tok' }))).toBe('tok');
        });
        it('returns null when absent', () => {
            expect(extractBearerToken(req({}))).toBeNull();
            expect(extractBearerToken(req({ authorization: 'Basic zzz' }))).toBeNull();
        });
    });

    describe('tokensMatch', () => {
        it('matches identical tokens', () => {
            expect(tokensMatch('s3cret', 's3cret')).toBe(true);
        });
        it('rejects mismatches, length differences, empties, and non-strings', () => {
            expect(tokensMatch('s3cret', 'other')).toBe(false);
            expect(tokensMatch('s3cret', 's3cre')).toBe(false);
            expect(tokensMatch('', '')).toBe(false);
            expect(tokensMatch(null, 's3cret')).toBe(false);
            expect(tokensMatch(undefined, undefined)).toBe(false);
        });
    });

    // The gate the facade applies to every HTTP request before it routes.
    // Ported from the removed createHttpAuthenticate/createHttpRequestGuard
    // suites: same accept/reject matrix, now asserted on the one function that
    // survived the cutover.
    describe('checkHttpAuth', () => {
        const token = 'correct-horse-battery-staple';
        const headers = (h = {}) => h;

        it('accepts a request with the correct bearer token', () => {
            expect(checkHttpAuth(headers({ authorization: `Bearer ${token}` }), { token })).toEqual({ ok: true });
        });

        it('accepts the X-MCP-Token alternative header', () => {
            expect(checkHttpAuth(headers({ 'x-mcp-token': token }), { token })).toEqual({ ok: true });
        });

        it('rejects a missing token with 401', () => {
            const result = checkHttpAuth(headers({}), { token });
            expect(result.ok).toBe(false);
            expect(result.status).toBe(401);
            expect(result.message).toMatch(/Unauthorized/);
        });

        it('rejects a wrong token with 401', () => {
            const result = checkHttpAuth(headers({ authorization: 'Bearer wrong' }), { token });
            expect(result.ok).toBe(false);
            expect(result.status).toBe(401);
        });

        it('rejects a foreign browser Origin with 403 even when the token is right', () => {
            const result = checkHttpAuth(
                headers({ authorization: `Bearer ${token}`, origin: 'https://evil.example' }),
                { token },
            );
            expect(result.ok).toBe(false);
            expect(result.status).toBe(403);
            expect(result.message).toMatch(/Origin/);
        });

        it('checks Origin before the token, so a disallowed Origin is 403 and not 401', () => {
            const result = checkHttpAuth(headers({ origin: 'https://evil.example' }), { token });
            expect(result.status).toBe(403);
        });

        it('allows a loopback Origin with a valid token', () => {
            expect(checkHttpAuth(
                headers({ authorization: `Bearer ${token}`, origin: 'http://localhost:5173' }),
                { token },
            )).toEqual({ ok: true });
        });

        it('honors the explicit Origin allow-list', () => {
            expect(checkHttpAuth(
                headers({ authorization: `Bearer ${token}`, origin: 'https://trusted.example' }),
                { token, allowedOrigins: ['https://trusted.example'] },
            )).toEqual({ ok: true });
        });

        it('skips the token check when noAuth is set but still guards Origin', () => {
            expect(checkHttpAuth(headers({}), { noAuth: true })).toEqual({ ok: true });
            const rejected = checkHttpAuth(headers({ origin: 'https://evil.example' }), { noAuth: true });
            expect(rejected.ok).toBe(false);
            expect(rejected.status).toBe(403);
        });

        it('carries a server-side reason distinct from the caller-facing message', () => {
            const result = checkHttpAuth(headers({}), { token });
            expect(result.reason).toMatch(/Rejected HTTP request/);
            expect(result.reason).not.toBe(result.message);
        });

        it('does not leak the configured token in either string', () => {
            const result = checkHttpAuth(headers({ authorization: 'Bearer wrong' }), { token });
            expect(result.message).not.toContain(token);
            expect(result.reason).not.toContain(token);
        });
    });
});
