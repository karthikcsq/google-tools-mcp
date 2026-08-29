import { describe, expect, it, jest } from '@jest/globals';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getHttpServiceStatus, restartHttpService, startHttpService, stopHttpService } from '../dist/httpLifecycle.js';
import { ensureHttpToken, publishHttpState, readHttpState } from '../dist/httpState.js';
import { prepareMcpServerFactory, startV2HttpServer } from '../dist/mcpServer.js';

jest.setTimeout(60_000);
const execFileAsync = promisify(execFile);
const ENTRYPOINT = fileURLToPath(new URL('../dist/index.js', import.meta.url));

async function tempConfig() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-http-ops-'));
}

async function freePort() {
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

async function testRuntime(configDir, profile = 'default') {
    const tokenInfo = await ensureHttpToken({ configDir, env: {} });
    const factory = await prepareMcpServerFactory({
        registerTools: async (server) => server.addTool({
            name: 'noop', description: 'noop', parameters: z.object({}), execute: async () => 'ok',
        }),
    });
    const runtime = await startV2HttpServer(factory, {
        auth: { token: tokenInfo.token }, host: '127.0.0.1', port: 0, profile,
    });
    const port = runtime.server.address().port;
    await publishHttpState({
        pid: process.pid, port, host: '127.0.0.1', endpoint: '/mcp', profile,
        version: '2.0.0', startedAt: new Date().toISOString(),
    }, { configDir });
    return { runtime, token: tokenInfo.token, port };
}

describe('shared HTTP lifecycle operations', () => {
    it('status authenticates a modern SDK client and trusts identity only from discovery _meta', async () => {
        const configDir = await tempConfig();
        const { runtime, token } = await testRuntime(configDir);
        const requests = [];
        const fetchImpl = async (input, init) => {
            const url = String(input);
            requests.push({ url, init });
            if (url.endsWith('/healthz')) {
                return new Response(JSON.stringify({ status: 'ok', pid: process.pid, identity: { name: 'spoofed-health' } }), {
                    status: 200, headers: { 'content-type': 'application/json' },
                });
            }
            return fetch(input, init);
        };
        try {
            const report = await getHttpServiceStatus({ configDir, env: {}, fetchImpl });
            expect(report).toMatchObject({
                healthy: true,
                identity: { name: 'google-tools-mcp', version: '2.0.0' },
                health: { ok: true },
                tokenSource: 'file',
            });
            const discovery = requests.find(({ url }) => url.endsWith('/mcp'));
            expect(discovery.init.headers.authorization).toBe(`Bearer ${token}`);
            expect(discovery.init.headers['mcp-method']).toBe('server/discover');
            expect(JSON.parse(discovery.init.body).params._meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');
            expect(JSON.stringify(report)).not.toContain(token);
            expect(report.identity.name).not.toBe('spoofed-health');
        } finally {
            await runtime.close();
            await fs.rm(configDir, { recursive: true, force: true });
        }
    });

    it('attaches to an already-running healthy managed instance without spawning', async () => {
        const configDir = await tempConfig();
        const { runtime, port } = await testRuntime(configDir);
        const spawnImpl = jest.fn();
        try {
            const result = await startHttpService({
                configDir, env: { GOOGLE_MCP_PORT: String(port) }, spawnImpl,
            });
            expect(result.status).toBe('attached');
            expect(spawnImpl).not.toHaveBeenCalled();
        } finally {
            await runtime.close();
            await fs.rm(configDir, { recursive: true, force: true });
        }
    });

    it('refuses to attach a different profile to an occupied managed service', async () => {
        const configDir = await tempConfig();
        const { runtime, port } = await testRuntime(configDir, 'work');
        try {
            await expect(startHttpService({
                configDir,
                env: { GOOGLE_MCP_PORT: String(port), GOOGLE_MCP_PROFILE: 'personal' },
                spawnImpl: jest.fn(),
            })).rejects.toThrow(/profile: running work/);
        } finally {
            await runtime.close();
            await fs.rm(configDir, { recursive: true, force: true });
        }
    });

    it.each([
        ['host', 'localhost', /host: running 127\.0\.0\.1/],
        ['port', '3940', /port: running/],
        ['endpoint', '/other', /endpoint: running \/mcp/],
        ['profile', 'personal', /profile: running work/],
    ])('refuses attach when %s differs and does not spawn', async (field, value, expected) => {
        const configDir = await tempConfig();
        const { runtime, port } = await testRuntime(configDir, field === 'profile' ? 'work' : 'default');
        const env = { GOOGLE_MCP_PORT: String(field === 'port' ? value : port), ...(field === 'host' ? { GOOGLE_MCP_HTTP_HOST: value } : {}), ...(field === 'endpoint' ? { GOOGLE_MCP_ENDPOINT: value } : {}), ...(field === 'profile' ? { GOOGLE_MCP_PROFILE: value } : {}) };
        const spawnImpl = jest.fn();
        try { await expect(startHttpService({ configDir, env, spawnImpl })).rejects.toThrow(expected); expect(spawnImpl).not.toHaveBeenCalled(); }
        finally { await runtime.close(); await fs.rm(configDir, { recursive: true, force: true }); }
    });

    it('refuses attach when the expected version differs', async () => {
        const configDir = await tempConfig(); const { runtime, port } = await testRuntime(configDir);
        const spawnImpl = jest.fn();
        try { await expect(startHttpService({ configDir, env: { GOOGLE_MCP_PORT: String(port) }, expectedVersion: 'different-version', spawnImpl })).rejects.toThrow(/version: running/); expect(spawnImpl).not.toHaveBeenCalled(); }
        finally { await runtime.close(); await fs.rm(configDir, { recursive: true, force: true }); }
    });

    it('direct serve refuses to attach a healthy service with different resolved configuration', async () => {
        const xdgRoot = await tempConfig();
        const configDir = path.join(xdgRoot, 'google-tools-mcp');
        await fs.mkdir(configDir, { recursive: true });
        const { runtime, port } = await testRuntime(configDir);
        const env = {
            ...process.env, CI: 'true', XDG_CONFIG_HOME: xdgRoot,
            GOOGLE_MCP_TRANSPORT: undefined, GOOGLE_MCP_PORT: String(port),
            GOOGLE_MCP_HTTP_HOST: 'localhost', GOOGLE_MCP_HTTP_TOKEN: undefined,
        };
        try {
            await expect(execFileAsync(process.execPath, [ENTRYPOINT, 'serve'], { env, timeout: 40_000 }))
                .rejects.toMatchObject({
                    code: 1,
                    stdout: '',
                    stderr: expect.stringMatching(/does not match requested configuration.*host: running 127\.0\.0\.1.*Stop\/restart it explicitly/is),
                });
        } finally {
            await runtime.close();
            await fs.rm(xdgRoot, { recursive: true, force: true });
        }
    });

    it('runs start, authenticated status, restart, and stop against one detached service', async () => {
        const configDir = await tempConfig();
        const port = await freePort();
        const env = {
            ...process.env, CI: 'true', XDG_CONFIG_HOME: configDir,
            GOOGLE_MCP_PORT: String(port), GOOGLE_MCP_TRANSPORT: undefined,
            GOOGLE_MCP_HTTP_TOKEN: undefined,
        };
        const run = async (...args) => {
            const { stdout, stderr } = await execFileAsync(process.execPath, [ENTRYPOINT, ...args], { env, timeout: 40_000 });
            expect(stderr).not.toContain('Token:');
            return JSON.parse(stdout);
        };
        try {
            const started = await run('start', '--json');
            expect(started).toMatchObject({ status: 'started', healthy: true, tokenSource: 'file' });
            const status = await run('status', '--json');
            expect(status).toMatchObject({ healthy: true, identity: { name: 'google-tools-mcp' } });
            expect(status.state.pid).toBe(started.state.pid);
            const restarted = await run('restart', '--json');
            expect(restarted.status).toBe('restarted');
            expect(restarted.started.state.pid).not.toBe(started.state.pid);
            const stopped = await run('stop', '--json');
            expect(stopped.status).toBe('stopped');
            await expect(execFileAsync(process.execPath, [ENTRYPOINT, 'status', '--json'], { env, timeout: 40_000 }))
                .rejects.toMatchObject({ code: 1 });
        } finally {
            await execFileAsync(process.execPath, [ENTRYPOINT, 'stop', '--json'], { env, timeout: 40_000 }).catch(() => {});
            await fs.rm(configDir, { recursive: true, force: true });
        }
    });

    it('makes a foreign port collision actionable without negotiating a hidden URL', async () => {
        const configDir = await tempConfig();
        const occupied = http.createServer((_req, res) => { res.writeHead(200); res.end('foreign'); });
        await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
        const { port } = occupied.address();
        const env = {
            ...process.env, CI: 'true', XDG_CONFIG_HOME: configDir,
            GOOGLE_MCP_PORT: String(port), GOOGLE_MCP_HTTP_TOKEN: 'collision-token',
        };
        try {
            await expect(execFileAsync(process.execPath, [ENTRYPOINT, 'serve'], { env, timeout: 40_000 }))
                .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('GOOGLE_MCP_PORT') });
        } finally {
            await new Promise((resolve) => occupied.close(resolve));
            await fs.rm(configDir, { recursive: true, force: true });
        }
    });

    it('treats an already-dead recorded pid as stale cleanup, not a stop failure', async () => {
        const configDir = await tempConfig();
        await publishHttpState({
            pid: 999999, port: 3939, host: '127.0.0.1', endpoint: '/mcp', profile: 'default',
            version: '2.0.0', startedAt: new Date().toISOString(),
        }, { configDir });
        try {
            const result = await stopHttpService({
                configDir,
                kill: () => { const error = new Error('gone'); error.code = 'ESRCH'; throw error; },
            });
            expect(result.status).toBe('stale-state-removed');
        } finally { await fs.rm(configDir, { recursive: true, force: true }); }
    });

    it('never signals a live foreign or unauthenticated pid', async () => {
        const configDir = await tempConfig();
        await publishHttpState({ pid: process.pid, port: 3939, host: '127.0.0.1', endpoint: '/mcp', profile: 'default', version: '2.0.0', startedAt: new Date().toISOString() }, { configDir });
        const kill = jest.fn((pid, signal) => { if (signal === 0) return true; });
        const fetchImpl = async () => new Response('', { status: 401 });
        try { await expect(stopHttpService({ configDir, kill, fetchImpl, env: {} })).resolves.toMatchObject({ status: 'foreign-or-unverified' });
            expect(kill).not.toHaveBeenCalledWith(process.pid, 'SIGTERM');
        } finally { await fs.rm(configDir, { recursive: true, force: true }); }
    });

    it('preserves a live managed instance instead of orphaning it when its bearer token has rotated', async () => {
        // Finding 8: unlike the unauthenticated case above (diagnostic
        // 'token-missing', no credential to try at all), a token IS present
        // here -- just the wrong one -- so the authenticated probes reach the
        // still-running server and are rejected (diagnostic
        // 'unreachable-or-unauthorized'). That is a rotation, not a foreign
        // process, and must not delete the only record of how to stop it.
        const configDir = await tempConfig();
        await publishHttpState({ pid: process.pid, port: 3939, host: '127.0.0.1', endpoint: '/mcp', profile: 'default', version: '2.0.0', startedAt: new Date().toISOString(), noAuth: false }, { configDir });
        const kill = jest.fn((pid, signal) => { if (signal === 0) return true; });
        const fetchImpl = async () => new Response('', { status: 401 });
        try {
            const result = await stopHttpService({ configDir, kill, fetchImpl, env: { GOOGLE_MCP_HTTP_TOKEN: 'wrong-rotated-token' } });
            expect(result).toMatchObject({ status: 'auth-mismatch', diagnostic: 'unreachable-or-unauthorized' });
            expect(kill).not.toHaveBeenCalledWith(process.pid, 'SIGTERM');
            await expect(readHttpState({ configDir })).resolves.toMatchObject({ pid: process.pid });
        } finally { await fs.rm(configDir, { recursive: true, force: true }); }
    });

    it('does not spawn a replacement process on restart when the previous stop could not be confirmed', async () => {
        const configDir = await tempConfig();
        await publishHttpState({ pid: process.pid, port: 3939, host: '127.0.0.1', endpoint: '/mcp', profile: 'default', version: '2.0.0', startedAt: new Date().toISOString(), noAuth: false }, { configDir });
        const kill = jest.fn((pid, signal) => { if (signal === 0) return true; });
        const fetchImpl = async () => new Response('', { status: 401 });
        const spawnImpl = jest.fn();
        try {
            const result = await restartHttpService({ configDir, kill, fetchImpl, spawnImpl, env: { GOOGLE_MCP_HTTP_TOKEN: 'wrong-rotated-token' } });
            expect(result).toMatchObject({ status: 'stop-incomplete', stopped: { status: 'auth-mismatch' } });
            expect(spawnImpl).not.toHaveBeenCalled();
            await expect(readHttpState({ configDir })).resolves.toMatchObject({ pid: process.pid });
        } finally { await fs.rm(configDir, { recursive: true, force: true }); }
    });

    it('exits non-zero from the stop subcommand when the recorded process was not actually stopped', async () => {
        // Finding 11: 'foreign-or-unverified' means the requested stop did not
        // happen. A shell script or service manager reading only the exit code
        // must be able to tell that apart from a real stop.
        const xdgRoot = await tempConfig();
        const configDir = path.join(xdgRoot, 'google-tools-mcp');
        await fs.mkdir(configDir, { recursive: true });
        await publishHttpState({ pid: process.pid, port: 3939, host: '127.0.0.1', endpoint: '/mcp', profile: 'default', version: '2.0.0', startedAt: new Date().toISOString() }, { configDir });
        const env = { ...process.env, CI: 'true', XDG_CONFIG_HOME: xdgRoot, GOOGLE_MCP_TRANSPORT: undefined, GOOGLE_MCP_HTTP_TOKEN: undefined };
        try {
            await expect(execFileAsync(process.execPath, [ENTRYPOINT, 'stop', '--json'], { env, timeout: 40_000 }))
                .rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('foreign-or-unverified') });
        } finally { await fs.rm(xdgRoot, { recursive: true, force: true }); }
    });

    it('refuses to attach in authenticated mode while a no-auth managed instance is still running', async () => {
        // Finding 12, matching its exact scenario: a live no-auth server
        // ignores a bearer token instead of rejecting it, so an authenticated
        // probe against it still reports healthy. Only comparing the
        // published, non-secret noAuth flag -- not request outcome -- can
        // catch that the live process's auth mode no longer matches the
        // now-authenticated request, and the hardening must actually be
        // refused rather than silently skipped.
        const configDir = await tempConfig();
        const factory = await prepareMcpServerFactory({
            registerTools: async (server) => server.addTool({
                name: 'noop', description: 'noop', parameters: z.object({}), execute: async () => 'ok',
            }),
        });
        const runtime = await startV2HttpServer(factory, { auth: { noAuth: true }, host: '127.0.0.1', port: 0, profile: 'default' });
        const port = runtime.server.address().port;
        await publishHttpState({
            pid: process.pid, port, host: '127.0.0.1', endpoint: '/mcp', profile: 'default',
            version: '2.0.0', startedAt: new Date().toISOString(), noAuth: true,
        }, { configDir });
        const spawnImpl = jest.fn();
        try {
            // No GOOGLE_MCP_HTTP_NO_AUTH here, and an explicit bearer token:
            // this requests the ordinary authenticated mode, exactly as an
            // operator would when turning auth back on.
            await expect(startHttpService({
                configDir, env: { GOOGLE_MCP_PORT: String(port), GOOGLE_MCP_HTTP_TOKEN: 'newly-required-token' }, spawnImpl,
            })).rejects.toThrow(/auth mode: running no-auth, requested bearer-token/);
            expect(spawnImpl).not.toHaveBeenCalled();
            // Confirms the mismatch was caught by comparing state, not by the
            // live server actually starting to reject requests -- it still
            // answers with no token at all, exactly as before.
            const health = await fetch(new URL('/healthz', `http://127.0.0.1:${port}`));
            expect(health.ok).toBe(true);
        } finally {
            await runtime.close();
            await fs.rm(configDir, { recursive: true, force: true });
        }
    });
});
