import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalizeOrigins, isLoopbackHost, resolveHttpAuthConfig } from './httpAuth.js';
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
    // The HTTP facade routes by comparing an incoming request's *parsed*
    // pathname (new URL(request.url).pathname, which every real HTTP client
    // -- including this project's own probeMcpIdentity/waitForHttpService --
    // already normalizes before the request ever hits the wire) against this
    // configured endpoint used raw. A value that isn't already in its own
    // canonical form (dot-segments like "/a/../mcp", internal whitespace,
    // double slashes, ...) would route and probe against two different
    // strings that happen to describe the same resource on paper but never
    // match at request time: the service would bind the port successfully
    // and then fail its own readiness probe with a 404, or a real client
    // could get routed to the wrong place. Reject anything that doesn't
    // already equal its own canonical URL pathname instead of silently
    // rewriting it, so an accepted value is guaranteed to work end to end
    // (finding 23).
    const canonical = new URL(endpoint, 'http://placeholder').pathname;
    if (canonical !== endpoint) {
        throw new Error(`GOOGLE_MCP_ENDPOINT '${endpoint}' does not match its own canonical URL path ('${canonical}'). Use the canonical form directly (no dot-segments, internal whitespace, or repeated slashes).`);
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
    // The live process may keep answering requests either way -- a no-auth
    // server ignores a bearer token instead of rejecting it -- so this can
    // only be caught by comparing the published, non-secret auth mode, not by
    // a request outcome. See finding 12.
    if (Boolean(existing.state?.noAuth) !== Boolean(config.noAuth)) {
        differences.push(`auth mode: running ${existing.state?.noAuth ? 'no-auth' : 'bearer-token'}, requested ${config.noAuth ? 'no-auth' : 'bearer-token'}`);
    }
    // The live handler's browser-Origin allowlist is applied once at
    // startup and never reread; a request outcome can't reveal it (a
    // no-auth or still-correctly-authenticated server answers the
    // readiness probe either way), so only comparing the persisted,
    // canonicalized list catches a stale origin policy still being
    // enforced by an otherwise-healthy running process (finding 18).
    const existingOrigins = canonicalizeOrigins(existing.state?.allowedOrigins);
    const requestedOrigins = canonicalizeOrigins(config.allowedOrigins);
    if (existingOrigins.join(' ') !== requestedOrigins.join(' ')) {
        differences.push(`allowed origins: running [${existingOrigins.join(', ') || '(none)'}], requested [${requestedOrigins.join(', ') || '(none)'}]`);
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

const STARTUP_DIAGNOSTIC_MAX_BYTES = 8 * 1024;

function readStartupDiagnostic(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        return content ? content.slice(-STARTUP_DIAGNOSTIC_MAX_BYTES) : '';
    } catch {
        return '';
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
    // stdio: 'ignore' used to discard the detached child's own startup
    // diagnostics entirely -- including the actionable "FATAL: Port ... Set
    // GOOGLE_MCP_PORT ..." message dist/index.js writes straight to stderr on
    // EADDRINUSE -- so a port collision only ever surfaced here as a generic
    // readiness-timeout error with no indication of why (finding 21).
    // Redirect the child's stderr to a private, per-attempt temp file
    // instead. The OS duplicates the file descriptor into the child at spawn
    // time, so this process can close its own copy immediately afterward
    // without touching the child's ability to keep writing to it -- which
    // matters once the child is unref()'d and expected to keep running as a
    // long-lived detached service after this process exits.
    const startupLogPath = path.join(os.tmpdir(), `google-tools-mcp-start-${process.pid}-${randomBytes(6).toString('hex')}.log`);
    const startupLogFd = fs.openSync(startupLogPath, 'w');
    let child;
    try {
        child = spawnImpl(command, args, {
            detached: true,
            windowsHide: true,
            stdio: ['ignore', 'ignore', startupLogFd],
            env: {
                ...env,
                GOOGLE_MCP_TRANSPORT: 'http',
                GOOGLE_MCP_PORT: String(config.port),
                GOOGLE_MCP_ENDPOINT: config.endpoint,
                GOOGLE_MCP_HTTP_HOST: config.host,
            },
        });
    } finally {
        fs.closeSync(startupLogFd);
    }
    const status = await waitForHttpService({ configDir, env, fetchImpl, timeoutMs });
    if (!status.healthy) {
        if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
        const diagnostic = readStartupDiagnostic(startupLogPath);
        try { fs.unlinkSync(startupLogPath); } catch { /* best-effort cleanup */ }
        throw new Error(`Shared HTTP service did not become healthy (${status.diagnostic}).` +
            (diagnostic ? ` ${diagnostic}` : '') + ` See ${HTTP_OPERATIONS_DOC_URL}`);
    }
    try { fs.unlinkSync(startupLogPath); } catch { /* best-effort cleanup */ }
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
    // A live, still-recorded process whose *authenticated* probe fails --
    // as opposed to one we never had any credential to try -- is most likely
    // our own managed server still running under a bearer token that changed
    // underneath it (rotation), not a foreign process. Deleting the state
    // record here would strand a healthy process with no PID/URL record left
    // to stop or restart it by. Preserve the record instead so the operator
    // can retry with the right token. See finding 8; contrast with the
    // 'never signals a live foreign or unauthenticated pid' test below, which
    // has no token at all (diagnostic 'token-missing') and keeps the original
    // deletion behavior because there is nothing to indicate the process is ours.
    if (!ownership.healthy && ownership.diagnostic === 'unreachable-or-unauthorized' && ownership.state?.pid === state.pid) {
        return Object.freeze({ status: 'auth-mismatch', state, diagnostic: ownership.diagnostic });
    }
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

const CONFIRMED_STOPPED_STATUSES = new Set(['stopped', 'stale-state-removed', 'not-running']);

export async function restartHttpService(options = {}) {
    const stopped = await stopHttpService(options);
    // Only start a replacement once the previous process is confirmed gone.
    // 'auth-mismatch' and 'foreign-or-unverified' both mean the requested stop
    // did not happen (see finding 8); starting anyway on top of an
    // unconfirmed stop could spawn a second instance or silently attach to
    // the wrong one. Preserve the well-known 'stop-timeout' status for that
    // specific case and use 'stop-incomplete' for the others.
    if (!CONFIRMED_STOPPED_STATUSES.has(stopped.status)) {
        return Object.freeze({ status: stopped.status === 'stop-timeout' ? 'stop-timeout' : 'stop-incomplete', stopped });
    }
    const started = await startHttpService(options);
    return Object.freeze({ status: 'restarted', stopped, started });
}

export function createPublishedState(config, { pid = process.pid, version, startedAt = new Date().toISOString() } = {}) {
    return {
        pid, port: config.port, host: config.host, endpoint: config.endpoint, startedAt, version, profile: config.profile,
        noAuth: Boolean(config.noAuth), allowedOrigins: canonicalizeOrigins(config.allowedOrigins),
    };
}

export { getHttpStatePaths, publishHttpState };
