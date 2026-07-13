// Tests for the shared HTTP transport's application-level auth + origin guard
// (PR #36 review). These exercise the pure auth helpers and the authenticate()
// function FastMCP invokes before any tool runs — no network or Google APIs.
import { describe, it, expect } from '@jest/globals';
import {
    resolveHttpAuthConfig,
    generateToken,
    isLoopbackHost,
    isOriginAllowed,
    extractBearerToken,
    tokensMatch,
    createHttpAuthenticate,
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
});
