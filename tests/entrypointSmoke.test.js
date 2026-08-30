// Real-client smoke against the shipped entrypoint, `dist/index.js`.
//
// The PR 4 cutover gate is "the official SDK path is the default after real-client
// smoke succeeds". Every other facade test drives dist/mcpServer.js directly with
// a hand-built factory; nothing exercised the binary an MCP client actually
// launches, which is where the runtime selection, env resolution, tool preloading,
// startup diagnostics, and stdin-EOF shutdown all live.
//
// No Google credentials and no network: auth is deferred to the first tool call,
// and CI=true disables the background update check.
import { describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

jest.setTimeout(60_000);

const ENTRYPOINT = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const PROTOCOL_VERSION = '2026-07-28';

const modernBody = (id, method, params = {}) => JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: {
        ...params,
        _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientCapabilities': {},
        },
    },
});

function startServer(env) {
    const child = spawn(process.execPath, [ENTRYPOINT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CI: 'true', GOOGLE_MCP_TRANSPORT: undefined, ...env },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    // Memoized so exited() is safe to call more than once (e.g. once inside a
    // test body to assert the exit code, again from a finally-block cleanup):
    // 'exit' only ever fires once, so a fresh `once('exit', ...)` listener
    // registered after the process has already exited would never resolve.
    let exitedPromise = null;
    return {
        child,
        get stderr() { return stderr; },
        ready: (marker) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`server never logged ${marker}:\n${stderr}`)), 40_000);
            const check = () => {
                if (stderr.includes(marker)) { clearTimeout(timer); child.stderr.off('data', check); resolve(); }
            };
            child.stderr.on('data', check);
            check();
        }),
        exited: () => {
            if (!exitedPromise) {
                exitedPromise = new Promise((resolve, reject) => {
                    child.once('error', reject);
                    child.once('exit', resolve);
                });
            }
            return exitedPromise;
        },
    };
}

async function freePort() {
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

// freePort() binds port 0, closes it, and hands the number to a child spawned
// afterward — under parallel Jest workers another process (or another test in
// this same file) can grab that exact port in the gap between the close and
// the child's own listen(), which otherwise surfaces as a confusing
// ready-timeout instead of the real cause. startHttpServerWithRetry retries
// with a fresh port whenever the child demonstrably failed to bind, so a lost
// TOCTOU race fails the test with a clear message instead of a timeout.
async function startHttpServerWithRetry(envWithoutPort, { attempts = 3 } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const port = await freePort();
        const server = startServer({ ...envWithoutPort, GOOGLE_MCP_PORT: String(port) });
        const bindFailed = server.exited().then((code) => ({ bindFailed: true, code }));
        // ready() rejects via its own 40s internal timeout if the marker never
        // shows up; when bindFailed wins the race below that rejection would
        // otherwise fire later as an unhandled rejection, so it is swallowed
        // here and folded into the same "not ready" shape instead.
        const ready = server.ready('running over HTTP')
            .then(() => ({ bindFailed: false }))
            .catch((error) => ({ bindFailed: true, code: null, readyError: error }));
        // eslint-disable-next-line no-await-in-loop -- retries are inherently sequential
        const outcome = await Promise.race([ready, bindFailed]);
        if (!outcome.bindFailed) return { server, port };
        lastError = new Error(
            `Attempt ${attempt}/${attempts}: child exited with code ${outcome.code} before signaling HTTP ` +
            `readiness on port ${port} (likely a port conflict with another process). stderr:\n${server.stderr}` +
            (outcome.readyError ? `\nready() error: ${outcome.readyError.message}` : '')
        );
        // Only the ready()-timeout branch can still have a live child here;
        // the bindFailed branch means it already exited, and exited() is a
        // one-shot 'exit' listener that would never resolve a second time.
        if (server.child.exitCode === null && !server.child.killed) {
            server.child.kill('SIGTERM');
            // eslint-disable-next-line no-await-in-loop -- retries are inherently sequential
            await server.exited().catch(() => {});
        }
    }
    throw lastError;
}

describe('dist/index.js entrypoint', () => {
    it('serves a modern stdio client and shuts down cleanly on stdin EOF', async () => {
        const server = startServer({});
        try {
            const messages = [];
            let buffer = '';
            server.child.stdout.on('data', (chunk) => {
                buffer += chunk.toString();
                let index;
                while ((index = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, index).trim();
                    buffer = buffer.slice(index + 1);
                    if (line) messages.push(JSON.parse(line));
                }
            });
            const nextMessage = async (id) => {
                const deadline = Date.now() + 20_000;
                while (Date.now() < deadline) {
                    const found = messages.find((message) => message.id === id);
                    if (found) return found;
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                throw new Error(`no reply for id ${id}. stderr:\n${server.stderr}`);
            };

            await server.ready('running using stdio');
            server.child.stdin.write(`${modernBody(1, 'server/discover')}\n`);
            const discover = await nextMessage(1);
            expect(discover.result.supportedVersions).toContain(PROTOCOL_VERSION);
            expect(discover.result.instructions).toContain('Google Workspace tools');

            server.child.stdin.write(`${modernBody(2, 'tools/list')}\n`);
            const list = await nextMessage(2);
            expect(list.result.tools).toHaveLength(160);
            // Deterministic registration order, which is what makes the catalog
            // cacheable by a client.
            const names = list.result.tools.map(({ name }) => name);
            expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));

            // The stdin-EOF shutdown path the SDK's own stdio transport does not
            // provide, retained through the cutover.
            server.child.stdin.end();
            expect(await server.exited()).toBe(0);
        } finally {
            server.child.kill('SIGTERM');
            await server.exited();
        }
    });

    it('serves stateless authenticated HTTP and 404s every removed session route', async () => {
        const token = 'entrypoint-smoke-token';
        const { server, port } = await startHttpServerWithRetry({
            GOOGLE_MCP_TRANSPORT: 'http',
            GOOGLE_MCP_HTTP_TOKEN: token,
        });
        const base = `http://127.0.0.1:${port}`;
        const auth = { authorization: `Bearer ${token}` };

        try {
            expect((await fetch(`${base}/healthz`, { headers: auth })).status).toBe(200);
            expect((await fetch(`${base}/healthz`)).status).toBe(401);

            // Removed with the session era. Authenticated so this is a real 404
            // and not the auth rejection.
            for (const path of ['/sse', '/messages', '/ping']) {
                expect((await fetch(`${base}${path}`, { headers: auth })).status).toBe(404);
            }

            const response = await fetch(`${base}/mcp`, {
                method: 'POST',
                headers: {
                    ...auth,
                    'content-type': 'application/json',
                    'mcp-protocol-version': PROTOCOL_VERSION,
                    'mcp-method': 'tools/list',
                },
                body: modernBody(1, 'tools/list'),
            });
            expect(response.status).toBe(200);
            expect(response.headers.get('mcp-session-id')).toBeNull();
            expect((await response.json()).result.tools).toHaveLength(160);

            // The startup banner names the breaking change, and never prints the
            // configured token.
            expect(server.stderr).toContain('HTTP is stateless (MCP 2026-07-28)');
            expect(server.stderr).not.toContain(token);
        } finally {
            server.child.kill('SIGTERM');
            await server.exited();
        }
    });

    it('refuses an unauthenticated non-loopback binding instead of starting', async () => {
        const server = startServer({
            GOOGLE_MCP_TRANSPORT: 'http',
            GOOGLE_MCP_PORT: String(await freePort()),
            GOOGLE_MCP_HTTP_HOST: '0.0.0.0',
            GOOGLE_MCP_HTTP_NO_AUTH: '1',
        });
        try {
            expect(await server.exited()).toBe(1);
            expect(server.stderr).toContain('Refusing to start');
        } finally {
            server.child.kill('SIGTERM');
            await server.exited();
        }
    });
});
