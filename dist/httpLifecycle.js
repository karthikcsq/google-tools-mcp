import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { isLoopbackHost, resolveHttpAuthConfig } from './httpAuth.js';
import { connectModernHttpClient } from './httpClient.js';
import {
    ensureHttpToken, getHttpStatePaths, isProcessAlive, publishHttpState,
    readHttpState, removeHttpState,
} from './httpState.js';
const packageVersion = createRequire(import.meta.url)('../package.json').version;

export const HTTP_OPERATIONS_DOC_URL = 'https://github.com/karthikcsq/google-tools-mcp/blob/main/docs/http-mode.md';
export const DEFAULT_HTTP_PORT = 3939;
export const DEFAULT_HTTP_ENDPOINT = '/mcp';

function validPort(value) {
    const port = Number(value || DEFAULT_HTTP_PORT);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error('GOOGLE_MCP_PORT must be an integer from 1 through 65535.');
    }
    return port;
}

function validEndpoint(value) {
    const endpoint = String(value || DEFAULT_HTTP_ENDPOINT).trim();
    if (!endpoint.startsWith('/') || endpoint.includes('?') || endpoint.includes('#')) {
        throw new Error('GOOGLE_MCP_ENDPOINT must be an absolute URL path without a query or fragment.');
    }
    return endpoint;
}

export function resolveHttpServiceConfig(env = process.env) {
    const auth = resolveHttpAuthConfig(env);
    if (!isLoopbackHost(auth.host)) {
        throw new Error('Refusing to start: shared HTTP service mode is loopback-only until TLS and remote deployment authentication are supported.');
    }
    const port = validPort(env.GOOGLE_MCP_PORT);
    const endpoint = validEndpoint(env.GOOGLE_MCP_ENDPOINT);
    const profile = String(env.GOOGLE_MCP_PROFILE || 'default').trim() || 'default';
    const urlHost = auth.host.includes(':') && !auth.host.startsWith('[') ? `[${auth.host}]` : auth.host;
    return Object.freeze({
        ...auth, port, endpoint, profile,
        url: `http://${urlHost}:${port}${endpoint}`,
    });
}

export async function probeMcpIdentity(url, token, { fetchImpl = globalThis.fetch, timeoutMs = 5_000 } = {}) {
    const client = await connectModernHttpClient(url, { token, fetchImpl, timeoutMs });
    try {
        const response = await client.discover({ timeout: timeoutMs, maxTotalTimeout: timeoutMs });
        const identity = response?._meta?.['io.modelcontextprotocol/serverInfo'];
        if (!identity || typeof identity.name !== 'string' || typeof identity.version !== 'string') {
            throw new Error('Authenticated MCP discovery did not return server identity metadata.');
        }
        return Object.freeze({ identity: { name: identity.name, version: identity.version }, discovery: response });
    } finally {
        await client.close();
    }
}

export async function probeHealth(url, token, { fetchImpl = globalThis.fetch, timeoutMs = 5_000 } = {}) {
    const healthUrl = new URL('/healthz', url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(healthUrl, {
            headers: token ? { authorization: `Bearer ${token}` } : {}, signal: controller.signal,
        });
        if (!response.ok) return Object.freeze({ ok: false, status: response.status });
        const body = await response.json();
        return Object.freeze({ ok: body?.status === 'ok', pid: Number(body?.pid), status: response.status });
    } finally { clearTimeout(timer); }
}

export async function getHttpServiceStatus({ configDir, env = process.env, fetchImpl = globalThis.fetch, kill = process.kill } = {}) {
    const authConfig = resolveHttpAuthConfig(env);
    const tokenInfo = authConfig.noAuth
        ? { token: null, source: 'disabled' }
        : await ensureHttpToken({ configDir, env, create: false });
    let state;
    try { state = await readHttpState({ configDir }); }
    catch {
        return Object.freeze({ healthy: false, state: null, tokenSource: tokenInfo.source, diagnostic: 'invalid-state' });
    }
    if (!state) return Object.freeze({ healthy: false, state: null, tokenSource: tokenInfo.source, diagnostic: 'not-running' });
    if (!isProcessAlive(state.pid, { kill })) {
        await removeHttpState({ configDir, expectedPid: state.pid });
        return Object.freeze({ healthy: false, state, tokenSource: tokenInfo.source, diagnostic: 'stale-state' });
    }
    if (!tokenInfo.token && !authConfig.noAuth) {
        return Object.freeze({ healthy: false, state, tokenSource: tokenInfo.source, diagnostic: 'token-missing' });
    }
    try {
        const [{ identity }, health] = await Promise.all([
            probeMcpIdentity(state.url, tokenInfo.token, { fetchImpl }),
            probeHealth(state.url, tokenInfo.token, { fetchImpl }),
        ]);
        const healthy = identity.name === 'google-tools-mcp' && health.ok && health.pid === state.pid;
        return Object.freeze({ healthy, state, identity, health, tokenSource: tokenInfo.source,
            diagnostic: healthy ? 'healthy' : 'unexpected-service' });
    } catch {
        return Object.freeze({ healthy: false, state, tokenSource: tokenInfo.source, diagnostic: 'unreachable-or-unauthorized' });
    }
}

export async function waitForHttpService({ configDir, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- readiness polling is sequential by definition.
        last = await getHttpServiceStatus({ configDir, env, fetchImpl });
        if (last.healthy) return last;
        // eslint-disable-next-line no-await-in-loop -- avoid a hot poll loop.
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return last || Object.freeze({ healthy: false, diagnostic: 'startup-timeout' });
}

export function getHttpServiceConfigurationDifferences(existing, config, expectedVersion = packageVersion) {
    const differences = [];
    for (const key of ['host', 'port', 'endpoint', 'profile']) {
        if (existing.state?.[key] !== config[key]) {
            differences.push(`${key}: running ${existing.state?.[key] ?? 'unknown'}, requested ${config[key]}`);
        }
    }
    if (existing.identity?.name !== 'google-tools-mcp') {
        differences.push(`identity: running ${existing.identity?.name || 'unknown'}`);
    }
    if (existing.state?.version !== expectedVersion || existing.identity?.version !== expectedVersion) {
        differences.push(`version: running ${existing.state?.version || 'unknown'}/${existing.identity?.version || 'unknown'}, requested ${expectedVersion}`);
    }
    return differences;
}

export function assertHttpServiceConfigurationMatch(existing, config, expectedVersion = packageVersion) {
    const differences = getHttpServiceConfigurationDifferences(existing, config, expectedVersion);
    if (differences.length) {
        throw new Error(`Running shared HTTP service does not match requested configuration (${differences.join('; ')}). Stop/restart it explicitly.`);
    }
}

export async function startHttpService({
    configDir, env = process.env, launch, spawnImpl = spawn, fetchImpl = globalThis.fetch, timeoutMs = 15_000, expectedVersion = packageVersion,
} = {}) {
    const config = resolveHttpServiceConfig(env);
    const existing = await getHttpServiceStatus({ configDir, env, fetchImpl });
    if (existing.healthy) {
        assertHttpServiceConfigurationMatch(existing, config, expectedVersion);
        return Object.freeze({ status: 'attached', ...existing });
    }
    await ensureHttpToken({ configDir, env });
    const command = launch?.command || process.execPath;
    const args = [...(launch?.args || []), 'serve'];
    const child = spawnImpl(command, args, {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: {
            ...env,
            GOOGLE_MCP_TRANSPORT: 'http',
            GOOGLE_MCP_PORT: String(config.port),
            GOOGLE_MCP_ENDPOINT: config.endpoint,
            GOOGLE_MCP_HTTP_HOST: config.host,
        },
    });
    const status = await waitForHttpService({ configDir, env, fetchImpl, timeoutMs });
    if (!status.healthy) {
        if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
        throw new Error(`Shared HTTP service did not become healthy (${status.diagnostic}). See ${HTTP_OPERATIONS_DOC_URL}`);
    }
    child.unref?.();
    return Object.freeze({ status: 'started', ...status });
}

export async function stopHttpService({ configDir, env = process.env, fetchImpl = globalThis.fetch, kill = process.kill, timeoutMs = 10_000 } = {}) {
    const state = await readHttpState({ configDir }).catch(() => null);
    if (!state) return Object.freeze({ status: 'not-running' });
    if (!isProcessAlive(state.pid, { kill })) {
        await removeHttpState({ configDir, expectedPid: state.pid });
        return Object.freeze({ status: 'stale-state-removed', state });
    }
    const ownership = await getHttpServiceStatus({ configDir, env, fetchImpl, kill });
    if (!ownership.healthy || ownership.state?.pid !== state.pid) {
        await removeHttpState({ configDir, expectedPid: state.pid });
        return Object.freeze({ status: 'foreign-or-unverified', state, diagnostic: ownership.diagnostic });
    }
    try { kill(state.pid, 'SIGTERM'); }
    catch (error) {
        if (error?.code !== 'ESRCH') throw error;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && isProcessAlive(state.pid, { kill })) {
        // eslint-disable-next-line no-await-in-loop -- process termination polling is sequential.
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const stopped = !isProcessAlive(state.pid, { kill });
    if (stopped) await removeHttpState({ configDir, expectedPid: state.pid });
    return Object.freeze({ status: stopped ? 'stopped' : 'stop-timeout', state });
}

export async function restartHttpService(options = {}) {
    const stopped = await stopHttpService(options);
    if (stopped.status === 'stop-timeout') return Object.freeze({ status: 'stop-timeout', stopped });
    const started = await startHttpService(options);
    return Object.freeze({ status: 'restarted', stopped, started });
}

export function createPublishedState(config, { pid = process.pid, version, startedAt = new Date().toISOString() } = {}) {
    return { pid, port: config.port, host: config.host, endpoint: config.endpoint, startedAt, version, profile: config.profile };
}

export { getHttpStatePaths, publishHttpState };
