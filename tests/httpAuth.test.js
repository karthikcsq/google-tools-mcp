// Tests for the shared HTTP transport's application-level auth + origin guard
// (PR #36 review). These exercise the pure auth helpers and the authenticate()
// function FastMCP invokes before any tool runs — no network or Google APIs.
import { describe, it, expect } from '@jest/globals';
import {
    resolveHttpAuthConfig,
    assertSafeHttpBinding,
    generateToken,
    isLoopbackHost,
    isOriginAllowed,
    extractBearerToken,
    tokensMatch,
    createHttpAuthenticate,
    createHttpRequestGuard,
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

    describe('createHttpAuthenticate', () => {
        const token = 'correct-horse-battery-staple';

        it('is inert for stdio (no request)', async () => {
            const authenticate = createHttpAuthenticate({ token });
            await expect(authenticate(undefined)).resolves.toEqual({});
        });

        it('accepts a request with the correct bearer token', async () => {
            const authenticate = createHttpAuthenticate({ token });
            await expect(
                authenticate(req({ authorization: `Bearer ${token}` })),
            ).resolves.toEqual({ authenticated: true });
        });

        it('rejects a request with a missing token', async () => {
            const authenticate = createHttpAuthenticate({ token });
            await expect(authenticate(req({}))).rejects.toThrow(/Unauthorized/);
        });

        it('rejects a request with a wrong token', async () => {
            const authenticate = createHttpAuthenticate({ token });
            await expect(
                authenticate(req({ authorization: 'Bearer wrong' })),
            ).rejects.toThrow(/Unauthorized/);
        });

        it('rejects a foreign browser Origin even with a valid token', async () => {
            const authenticate = createHttpAuthenticate({ token });
            await expect(
                authenticate(req({ authorization: `Bearer ${token}`, origin: 'https://evil.example' })),
            ).rejects.toThrow(/Origin/);
        });

        it('allows a loopback Origin with a valid token', async () => {
            const authenticate = createHttpAuthenticate({ token });
            await expect(
                authenticate(req({ authorization: `Bearer ${token}`, origin: 'http://localhost:5173' })),
            ).resolves.toEqual({ authenticated: true });
        });

        it('skips the token check when noAuth is set but still guards Origin', async () => {
            const authenticate = createHttpAuthenticate({ noAuth: true });
            await expect(authenticate(req({}))).resolves.toEqual({ authenticated: true });
            await expect(
                authenticate(req({ origin: 'https://evil.example' })),
            ).rejects.toThrow(/Origin/);
        });
    });

    // --- request guard: every method, not just POST -------------------------
    // FastMCP's authenticate() only runs on session creation (POST). GET
    // (stream attach) and DELETE (session kill) are dispatched on the
    // Mcp-Session-Id header alone, so they need their own gate.
    describe('createHttpRequestGuard', () => {
        const token = 'guard-token';
        const guardReq = (method, headers = {}, url = '/mcp') => ({ method, url, headers });
        const fakeRes = () => {
            const res = { statusCode: null, body: null, headers: {} };
            res.setHeader = (k, v) => { res.headers[k] = v; };
            res.writeHead = (code) => { res.statusCode = code; return res; };
            res.end = (body) => { res.body = body; return res; };
            return res;
        };

        it.each(['GET', 'DELETE', 'POST'])('rejects %s with no token', (method) => {
            const guard = createHttpRequestGuard({ token }, undefined);
            const res = fakeRes();
            expect(guard(guardReq(method, { 'mcp-session-id': 'leaked' }), res)).toBe(true);
            expect(res.statusCode).toBe(401);
        });

        it.each(['GET', 'DELETE'])('lets %s through with a valid token', (method) => {
            const guard = createHttpRequestGuard({ token }, undefined);
            const res = fakeRes();
            expect(guard(guardReq(method, { authorization: `Bearer ${token}` }), res)).toBe(false);
            expect(res.statusCode).toBeNull();
        });

        it('rejects a disallowed Origin with 403 even when the token is right', () => {
            const guard = createHttpRequestGuard({ token }, undefined);
            const res = fakeRes();
            expect(guard(guardReq('GET', {
                authorization: `Bearer ${token}`,
                origin: 'https://evil.example',
            }), res)).toBe(true);
            expect(res.statusCode).toBe(403);
        });

        it('leaves OPTIONS preflight alone (browsers never send Authorization on it)', () => {
            const guard = createHttpRequestGuard({ token }, undefined);
            const res = fakeRes();
            expect(guard(guardReq('OPTIONS'), res)).toBe(false);
        });

        it('leaves GET /ping alone, so the health check stays reachable', () => {
            const guard = createHttpRequestGuard({ token }, undefined);
            const res = fakeRes();
            expect(guard(guardReq('GET', {}, '/ping'), res)).toBe(false);
        });

        it('does not exempt POST /ping (mcp-proxy itself only special-cases GET)', () => {
            const guard = createHttpRequestGuard({ token }, undefined);
            const res = fakeRes();
            expect(guard(guardReq('POST', {}, '/ping'), res)).toBe(true);
            expect(res.statusCode).toBe(401);
        });

        // Regression coverage for the merge-blocking finding on PR #59: FastMCP's
        // call into mcp-proxy's startHTTPServer never passes `sseEndpoint`, so
        // mcp-proxy's default `/sse` GET route and its companion `/messages`
        // POST route are live alongside the configured streamable endpoint no
        // matter what GOOGLE_MCP_ENDPOINT is set to. A guard that only matched
        // one configured endpoint would leave those two completely open.
        it('guards the legacy SSE endpoint (GET /sse) exactly like the streamable endpoint', () => {
            const guard = createHttpRequestGuard({ token }, undefined);
            const rejected = fakeRes();
            expect(guard(guardReq('GET', {}, '/sse'), rejected)).toBe(true);
            expect(rejected.statusCode).toBe(401);

            const allowed = fakeRes();
            expect(guard(guardReq('GET', { authorization: `Bearer ${token}` }, '/sse'), allowed)).toBe(false);
        });

        it('guards the legacy SSE message endpoint (POST /messages)', () => {
            const guard = createHttpRequestGuard({ token }, undefined);
            const rejected = fakeRes();
            expect(guard(guardReq('POST', {}, '/messages?sessionId=leaked'), rejected)).toBe(true);
            expect(rejected.statusCode).toBe(401);

            const allowed = fakeRes();
            expect(guard(guardReq(
                'POST',
                { authorization: `Bearer ${token}` },
                '/messages?sessionId=leaked',
            ), allowed)).toBe(false);
        });

        it('guards the configured endpoint even when it differs from the /mcp default', () => {
            const guard = createHttpRequestGuard({ token }, undefined);
            const res = fakeRes();
            expect(guard(guardReq('GET', {}, '/custom'), res)).toBe(true);
            expect(res.statusCode).toBe(401);
        });

        it('skips the token check when noAuth is set but still guards Origin', () => {
            const guard = createHttpRequestGuard({ noAuth: true }, undefined);
            expect(guard(guardReq('DELETE', {}), fakeRes())).toBe(false);
            const res = fakeRes();
            expect(guard(guardReq('DELETE', { origin: 'https://evil.example' }), res)).toBe(true);
            expect(res.statusCode).toBe(403);
        });
    });
});
