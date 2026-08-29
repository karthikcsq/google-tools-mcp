import { describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import {
    buildClientEntry, codexTokenEnvironmentCommand, createClientAdapters, reconcileClientEntry, entriesEqual, parseClientEntry,
} from '../dist/clientAdapters.js';
import { shellQuote } from '../dist/shellSafe.js';
import { checkLaunchTarget, inspectSetup, inspectToken } from '../dist/setupInspect.js';
import { persistTokenCredentials, SCOPES } from '../dist/auth.js';
import { backupClientEntry, backupEnvFile, configureTransport, mergeCredentialEnv, persistTransportSelection, registerClients, runSetup } from '../dist/setup.js';

jest.setTimeout(60_000);

const ENTRYPOINT = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const desired = { command: 'node', args: ['/installed/google-tools-mcp/dist/index.js'] };

// Launch the shipped entrypoint the way an MCP client would, with nothing in
// the process environment naming a transport, and report which one it chose.
function resolvedTransportInFreshProcess(xdgRoot) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [ENTRYPOINT], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, CI: 'true', XDG_CONFIG_HOME: xdgRoot, GOOGLE_MCP_TRANSPORT: undefined, GOOGLE_MCP_LOG_FILE: '0', GOOGLE_MCP_JSONL_FILE: '0' },
        });
        let stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`no transport banner:\n${stderr}`)); }, 40_000);
        const settle = (value) => { clearTimeout(timer); child.stdin.end(); child.kill('SIGTERM'); resolve(value); };
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
            if (stderr.includes('running using stdio')) settle('stdio');
            else if (stderr.includes('running over HTTP') || stderr.includes('Shared HTTP service is already healthy')) settle('http');
        });
    });
}

function adapter(entry, failures = {}) {
    const calls = [];
    return {
        name: 'Fake', calls,
        get: async () => entry === undefined ? { status: 'missing' } : { status: 'found', entry, raw: JSON.stringify(entry) },
        add: async value => { calls.push(['add', value]); if (failures.add && calls.filter(([name]) => name === 'add').length === 1) throw new Error('add failed'); if (failures.rollback) throw new Error('rollback failed'); },
        remove: async () => { calls.push(['remove']); if (failures.remove) throw new Error('remove failed'); },
        addCommand: value => `fake add ${JSON.stringify(value)}`,
        removeCommand: 'fake remove',
    };
}

describe('setup client reconciliation', () => {
    it('writes the modern protocol env block into generated Codex stdio registration', () => {
        const launch = { command: 'node', args: ['/installed/index.js'] };
        const entry = buildClientEntry('Codex', { transport: 'stdio', launch });
        const codex = createClientAdapters({ run: async () => '' })[0];
        expect(entry).toEqual({
            command: 'node', args: ['/installed/index.js'],
            env: { CODEX_MCP_PROTOCOL_VERSION: '2026-07-28' },
        });
        expect(codex.addCommand(entry)).toBe(
            'codex mcp add google --env CODEX_MCP_PROTOCOL_VERSION=2026-07-28 -- node /installed/index.js',
        );
    });

    it('generates the native and different Claude Code and Codex HTTP shapes', () => {
        const url = 'http://127.0.0.1:3939/mcp';
        const token = 'private-token';
        const [codex, claude] = createClientAdapters({ run: async () => '' });
        const codexEntry = buildClientEntry('Codex', { transport: 'http', url, token });
        const claudeEntry = buildClientEntry('Claude Code', { transport: 'http', url, token });
        expect(codexEntry).toEqual({ url, bearer_token_env_var: 'GOOGLE_MCP_HTTP_TOKEN' });
        expect(codex.addCommand(codexEntry)).toBe(
            `codex mcp add google --url ${url} --bearer-token-env-var GOOGLE_MCP_HTTP_TOKEN`,
        );
        expect(claudeEntry).toEqual({ type: 'http', url, headers: { Authorization: `Bearer ${token}` } });
        expect(claude.addCommand(claudeEntry)).toContain('--transport http');
        expect(claude.addCommand(claudeEntry, { redact: true })).not.toContain(token);
    });

    it('establishes a healthy lifecycle before returning any shared registration material', async () => {
        const token = 'stable-token';
        const events = [];
        const result = await configureTransport({ command: 'node', args: ['index.js'] }, {
            select: async () => 'http',
            ensureToken: async () => { events.push('token'); return { token, source: 'file' }; },
            startService: async () => { events.push('service'); return { healthy: true, status: 'started', state: { url: 'http://127.0.0.1:3939/mcp' } }; },
            persistTransport: async () => { events.push('persist'); },
            env: {},
        });
        expect(events).toEqual(['token', 'service', 'persist']);
        expect(result).toMatchObject({ transport: 'http', token, serviceStatus: 'started' });
        await expect(configureTransport({ command: 'node', args: ['index.js'] }, {
            select: async () => 'http', ensureToken: async () => ({ token, source: 'file' }),
            startService: async () => { throw new Error('dead endpoint'); }, env: {},
        })).rejects.toThrow(/dead endpoint/);
    });

    it('persists an HTTP setup selection for a fresh process', async () => {
        const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-http-selection-'));
        try {
            await persistTransportSelection('http', { configDir });
            expect(await fs.readFile(path.join(configDir, '.env'), 'utf8')).toBe('GOOGLE_MCP_TRANSPORT=http\n');
        } finally { await fs.rm(configDir, { recursive: true, force: true }); }
    });

    it('persists a stdio selection over a previously persisted HTTP one, down to a fresh process', async () => {
        const xdgRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-stdio-selection-'));
        const configDir = path.join(xdgRoot, 'google-tools-mcp');
        try {
            // The state a previous "shared HTTP" setup run leaves behind.
            await fs.mkdir(configDir, { recursive: true });
            await fs.writeFile(path.join(configDir, '.env'), 'GOOGLE_MCP_TRANSPORT=http\n');
            expect(await resolvedTransportInFreshProcess(xdgRoot)).toBe('http');

            const env = { GOOGLE_MCP_TRANSPORT: 'http' };
            const result = await configureTransport({ command: 'node', args: ['index.js'] }, {
                select: async () => 'stdio', configDir, env,
                ensureToken: async () => { throw new Error('stdio must not mint an HTTP token'); },
                startService: async () => { throw new Error('stdio must not start a shared service'); },
            });

            expect(result).toEqual({ transport: 'stdio' });
            // Written, not deleted: a lower-priority cwd or package .env could
            // otherwise reactivate HTTP on the next launch.
            expect(await fs.readFile(path.join(configDir, '.env'), 'utf8')).toBe('GOOGLE_MCP_TRANSPORT=stdio\n');
            expect(env.GOOGLE_MCP_TRANSPORT).toBe('stdio');
            expect(await resolvedTransportInFreshProcess(xdgRoot)).toBe('stdio');
        } finally { await fs.rm(xdgRoot, { recursive: true, force: true }); }
    });

    it('adds a missing entry', async () => {
        const client = adapter();
        await expect(reconcileClientEntry(client, desired)).resolves.toMatchObject({ ok: true, status: 'added' });
        expect(client.calls).toEqual([['add', desired]]);
    });

    it('leaves an identical full entry alone', async () => {
        const client = adapter({ ...desired, env: { PROFILE: 'work' } });
        await expect(reconcileClientEntry(client, { ...desired, env: { PROFILE: 'work' } })).resolves.toMatchObject({ status: 'unchanged' });
        expect(client.calls).toEqual([]);
    });

    it('treats nested object key order as equal and skips repair', async () => {
        const actual = { command: 'node', args: ['server.js'], env: { B: '2', A: '1' }, headers: { Z: 'last', A: 'first' } };
        const expected = { headers: { A: 'first', Z: 'last' }, env: { A: '1', B: '2' }, args: ['server.js'], command: 'node' };
        const client = adapter(actual);
        expect(entriesEqual(actual, expected)).toBe(true);
        await expect(reconcileClientEntry(client, expected)).resolves.toMatchObject({ ok: true, status: 'unchanged' });
        expect(client.calls).toEqual([]);
    });

    it('replaces a different entry after confirmation', async () => {
        const client = adapter({ command: 'npx', args: ['-y', 'google-tools-mcp@latest'] });
        const result = await reconcileClientEntry(client, desired, { confirm: async () => true });
        expect(result).toMatchObject({ ok: true, status: 'replaced' });
        expect(client.calls).toEqual([['remove'], ['add', desired]]);
    });

    it('leaves a different entry untouched when repair is declined', async () => {
        const client = adapter({ command: 'old-node', args: ['server.js'] });
        const result = await reconcileClientEntry(client, desired, { confirm: async () => false });
        expect(result).toMatchObject({ ok: false, status: 'declined' });
        expect(result.manualCommand).toBe(`fake remove\nfake add ${JSON.stringify(desired)}`);
        expect(client.calls).toEqual([]);
    });

    it('refuses unsupported Codex HTTP auth without printing the bearer token', async () => {
        const [codex] = createClientAdapters({ run: async () => '' });
        const tokenPath = path.join(os.tmpdir(), 'google-tools-mcp-config', 'http-token');
        const result = await reconcileClientEntry({ ...codex, get: async () => ({ status: 'missing' }) },
            { url: 'http://127.0.0.1:3939/mcp', bearer_token_env_var: 'GOOGLE_MCP_HTTP_TOKEN' }, { tokenPath });
        expect(result).toMatchObject({ ok: false, status: 'unsupported-http-auth' });
        expect(result.manualCommand).toContain('GOOGLE_MCP_HTTP_TOKEN');
        // Issue #83: the persisted token is stored privately and never printed.
        // The instruction names the file it lives in instead.
        expect(result.manualCommand).toContain(tokenPath);
        expect(result.manualCommand).not.toContain(' --env ');
    });

    it('never renders the bearer token anywhere in the Codex completion instructions', async () => {
        const token = 'private-token-that-must-not-appear';
        const tokenPath = path.join(os.tmpdir(), 'google-tools-mcp-config', 'http-token');
        const [codex] = createClientAdapters({ run: async () => '' });
        const desiredHttp = { url: 'http://127.0.0.1:3939/mcp', bearer_token_env_var: 'GOOGLE_MCP_HTTP_TOKEN' };
        for (const current of [{ status: 'missing' }, { status: 'found', entry: { url: 'http://127.0.0.1:9999/mcp' } }]) {
            const result = await reconcileClientEntry({ ...codex, get: async () => current }, desiredHttp, { tokenPath });
            expect(result.manualCommand).not.toContain(token);
            expect(result.manualCommand.split('\n')[0]).toMatch(/^(export GOOGLE_MCP_HTTP_TOKEN=|setx GOOGLE_MCP_HTTP_TOKEN )/);
        }
        for (const platform of ['linux', 'darwin', 'win32']) {
            expect(codexTokenEnvironmentCommand({ tokenPath, platform })).toContain(tokenPath);
            expect(codexTokenEnvironmentCommand({ tokenPath, platform })).not.toContain(token);
            // No stored path (the token came from the environment): say so,
            // still without a value.
            const noPath = codexTokenEnvironmentCommand({ tokenPath: null, platform });
            expect(noPath).toMatch(/^(#|REM) /);
            expect(noPath).toContain('GOOGLE_MCP_HTTP_TOKEN');
        }
    });

    it('registers Codex directly for a no-auth loopback HTTP service', async () => {
        const url = 'http://127.0.0.1:3939/mcp';
        const codexEntry = buildClientEntry('Codex', { transport: 'http', url, noAuth: true });
        const claudeEntry = buildClientEntry('Claude Code', { transport: 'http', url, noAuth: true });
        expect(codexEntry).toEqual({ url });
        // No token in the environment, and none needed.
        expect(claudeEntry).toEqual({ type: 'http', url });

        const [base] = createClientAdapters({ run: async () => '' });
        const calls = [];
        const missing = { ...base, get: async () => ({ status: 'missing' }), add: async value => { calls.push(value); } };
        await expect(reconcileClientEntry(missing, codexEntry, { noAuth: true })).resolves.toMatchObject({ ok: true, status: 'added' });
        expect(calls).toEqual([codexEntry]);
        expect(base.addCommand(codexEntry)).toBe(`codex mcp add google --url ${url}`);
        expect(base.addCommand(codexEntry)).not.toContain('--bearer-token-env-var');

        // An already-correct no-auth entry converges instead of being re-added.
        const correct = { ...base, get: async () => ({ status: 'found', entry: { name: 'google', enabled: true, transport: { type: 'streamable_http', url, bearer_token_env_var: null } } }) };
        await expect(reconcileClientEntry(correct, codexEntry, { noAuth: true })).resolves.toMatchObject({ ok: true, status: 'unchanged' });
    });

    it('recognizes the real codex mcp get --json transport shapes for both transports', async () => {
        // inspectSetup runs checkLaunchTarget() with the real filesystem, so the
        // absolute paths here must actually exist on every platform this suite
        // runs on: the current interpreter and this test file itself stand in
        // for the real launch command and installed entry point.
        const launch = { command: process.execPath, args: [fileURLToPath(import.meta.url)] };
        const stdioJson = JSON.stringify({
            name: 'google',
            enabled: true,
            transport: {
                type: 'stdio',
                command: launch.command,
                args: launch.args,
                env: { CODEX_MCP_PROTOCOL_VERSION: '2026-07-28' },
            },
            startup_timeout_sec: 10,
            tool_timeout_sec: 60,
            enabled_tools: null,
            disabled_tools: null,
        });
        const parsedStdio = parseClientEntry(stdioJson);
        expect(parsedStdio.status).toBe('found');
        // Codex bookkeeping is dropped; only the registration fields survive.
        expect(parsedStdio.entry).toEqual({ command: launch.command, args: launch.args, env: { CODEX_MCP_PROTOCOL_VERSION: '2026-07-28' } });

        const desiredStdio = buildClientEntry('Codex', { transport: 'stdio', launch });
        expect(entriesEqual(parsedStdio.entry, desiredStdio)).toBe(true);

        const url = 'http://127.0.0.1:3939/mcp';
        const httpJson = JSON.stringify({
            name: 'google',
            enabled: true,
            transport: { type: 'streamable_http', url, bearer_token_env_var: 'GOOGLE_MCP_HTTP_TOKEN', http_headers: null },
            startup_timeout_sec: 10,
        });
        const parsedHttp = parseClientEntry(httpJson);
        expect(parsedHttp.entry).toEqual({ url, bearer_token_env_var: 'GOOGLE_MCP_HTTP_TOKEN' });
        expect(entriesEqual(parsedHttp.entry, buildClientEntry('Codex', { transport: 'http', url, token: 'irrelevant' }))).toBe(true);

        // End to end through the adapter: setup converges instead of offering
        // to remove and re-add a correct entry on every run.
        const [codex] = createClientAdapters({ run: async () => stdioJson });
        await expect(reconcileClientEntry(codex, desiredStdio, { backup: async () => { throw new Error('must not back up a correct entry'); } }))
            .resolves.toMatchObject({ ok: true, status: 'unchanged' });

        // ... and doctor calls it configured.
        const report = await inspectSetup({
            adapters: [{ name: 'Codex', detect: async () => true, get: async () => parsedStdio }],
            desiredEntry: desiredStdio, inspectHttp: async () => ({ healthy: true }),
            credentialsCheck: async () => ({ configured: true }), tokenCheck: async () => ({ status: 'valid' }), configWarnings: [],
        });
        expect(report.clients[0]).toMatchObject({ client: 'Codex', status: 'configured', matchesRecommended: true });
        expect(report.healthy).toBe(true);
    });

    it('executes client commands as argv, never as a shell string', async () => {
        const calls = [];
        const [codex, claude] = createClientAdapters({ run: async (argv) => { calls.push(argv); return ''; } });
        // An endpoint validEndpoint() allows, and an install path carrying shell
        // metacharacters: both must survive as single literal argv elements.
        const url = 'http://127.0.0.1:3939/mcp;id;:';
        const launch = { command: '/opt/my $tools & co/bin/node', args: ['/opt/my $tools & co/dist/index.js'] };

        await codex.add(buildClientEntry('Codex', { transport: 'http', url, token: 't' }));
        expect(calls.at(-1)).toEqual(['codex', 'mcp', 'add', 'google', '--url', url, '--bearer-token-env-var', 'GOOGLE_MCP_HTTP_TOKEN']);
        expect(calls.at(-1).filter(value => value === url)).toHaveLength(1);

        await codex.add(buildClientEntry('Codex', { transport: 'stdio', launch }));
        expect(calls.at(-1)).toEqual(['codex', 'mcp', 'add', 'google', '--env', 'CODEX_MCP_PROTOCOL_VERSION=2026-07-28', '--', launch.command, launch.args[0]]);

        await claude.add(buildClientEntry('Claude Code', { transport: 'stdio', launch }));
        expect(calls.at(-1)).toEqual(['claude', 'mcp', 'add', '-s', 'user', 'google', '--', launch.command, launch.args[0]]);

        await claude.add(buildClientEntry('Claude Code', { transport: 'http', url, token: 'tok;id' }));
        expect(calls.at(-1)).toEqual(['claude', 'mcp', 'add', '-s', 'user', '--transport', 'http', 'google', url, '--header', 'Authorization: Bearer tok;id']);

        // Nothing anywhere is a joined command string.
        expect(calls.every(argv => Array.isArray(argv) && argv.every(value => typeof value === 'string'))).toBe(true);
        // The display rendering quotes what a shell would otherwise split.
        const display = codex.addCommand(buildClientEntry('Codex', { transport: 'http', url, token: 't' }));
        expect(display).toContain(shellQuote(url));
        expect(display).not.toBe(`codex mcp add google --url ${url} --bearer-token-env-var GOOGLE_MCP_HTTP_TOKEN`);
    });

    it('accepts an already-correct Codex HTTP registration and gives state-specific manual commands otherwise', async () => {
        const desiredHttp = { url: 'http://127.0.0.1:3939/mcp', bearer_token_env_var: 'GOOGLE_MCP_HTTP_TOKEN' };
        const [base] = createClientAdapters({ run: async () => '' });
        await expect(reconcileClientEntry({ ...base, get: async () => ({ status: 'found', entry: desiredHttp }) }, desiredHttp,
            { token: 'private-token' })).resolves.toMatchObject({ ok: true, status: 'unchanged' });

        const differing = await reconcileClientEntry({ ...base, get: async () => ({ status: 'found', entry: { url: 'http://127.0.0.1:9999/mcp' } }) }, desiredHttp,
            { token: 'private-token' });
        expect(differing.explanation).toMatch(/cannot store.*value/i);
        expect(differing.manualCommand).toContain(base.removeCommand);
        expect(differing.manualCommand.indexOf(base.removeCommand)).toBeLessThan(differing.manualCommand.indexOf('codex mcp add'));

        const missing = await reconcileClientEntry({ ...base, get: async () => ({ status: 'missing' }) }, desiredHttp,
            { token: 'private-token' });
        expect(missing.manualCommand).not.toContain(base.removeCommand);
    });

    it('does not mutate or back up an unknown client entry', async () => {
        const calls = [];
        const client = { name: 'Fake', get: async () => ({ status: 'unknown', raw: 'unexpected' }),
            add: async () => calls.push('add'), remove: async () => calls.push('remove'), addCommand: () => 'manual' };
        const result = await reconcileClientEntry(client, desired, { backup: async () => calls.push('backup') });
        expect(result).toMatchObject({ ok: false, status: 'unknown' });
        expect(calls).toEqual([]);
    });

    it('treats a thrown CLI inspection as unknown even when its message contains valid entry JSON', async () => {
        const run = jest.fn(async () => { throw new Error('{"command":"foreign","args":[]}'); });
        const [client] = createClientAdapters({ run });
        await expect(client.get()).resolves.toMatchObject({ status: 'unknown', raw: expect.stringContaining('foreign') });
        const result = await reconcileClientEntry(client, desired, { backup: async () => { throw new Error('must not back up'); } });
        expect(result).toMatchObject({ ok: false, status: 'unknown' });
        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls.every(([argv]) => Array.isArray(argv))).toBe(true);
        expect(run.mock.calls.every(([argv]) => argv.join(' ') === client.getCommand)).toBe(true);
    });

    it('propagates a declined repair through runSetup without printing completion', async () => {
        const messages = [];
        const ui = {
            intro: value => messages.push(String(value)), outro: value => messages.push(String(value)),
            confirm: async () => false, isCancel: () => false,
            log: Object.fromEntries(['message', 'error', 'success', 'step'].map(name => [name, value => messages.push(String(value))])),
        };
        const client = { ...adapter({ command: 'old-node', args: ['server.js'] }), name: 'Fake', detect: async () => true };
        await expect(runSetup({
            checkCredentialsImpl: async () => ({ configured: true }), inspectTokenImpl: async () => ({ status: 'valid' }),
            existingLaunchTargetImpl: async () => desired, configureTransportImpl: async () => ({ transport: 'stdio' }),
            registerClientsImpl: (launch, transport, options) => registerClients(launch, transport, { ...options, adapters: [client] }),
            ui, clear: () => {},
        })).rejects.toThrow(/declined/);
        const output = messages.join('\n');
        expect(output).toMatch(/left unconfigured.*Setup is incomplete/i);
        expect(output).toContain('fake remove');
        expect(output).toContain(`fake add ${JSON.stringify(desired)}`);
        expect(output).not.toContain('Setup complete');
        expect(client.calls).toEqual([]);
    });

    it('reports remove failure instead of declaring success', async () => {
        const client = adapter({ command: 'old-node', args: [] }, { remove: true });
        await expect(reconcileClientEntry(client, desired)).resolves.toMatchObject({
            ok: false, status: 'remove-failed', manualCommand: `fake remove\nfake add ${JSON.stringify(desired)}`,
        });
    });

    it('rolls back the captured old entry when replacement add fails', async () => {
        const old = { command: 'old-node', args: ['server.js'] };
        const client = adapter(old, { add: true });
        await expect(reconcileClientEntry(client, desired)).resolves.toMatchObject({ ok: false, status: 'add-failed-rolled-back' });
        expect(client.calls).toEqual([['remove'], ['add', desired], ['add', old]]);
    });

    it('prints the exact desired replacement commands when rollback fails', async () => {
        const client = adapter({ command: 'old-node', args: [] }, { add: true, rollback: true });
        await expect(reconcileClientEntry(client, desired)).resolves.toMatchObject({
            ok: false, status: 'rollback-failed', manualCommand: `fake remove\nfake add ${JSON.stringify(desired)}`,
        });
    });

    it('treats env and unknown transport fields as meaningful differences', () => {
        expect(entriesEqual({ ...desired, env: { A: '1' } }, desired)).toBe(false);
        expect(entriesEqual({ ...desired, headers: { Authorization: 'Bearer x' } }, desired)).toBe(false);
    });
});

describe('setup inspection', () => {
    it('inspects a valid token without rewriting it', async () => {
        const original = JSON.stringify({ refresh_token: 'refresh', scopes: SCOPES });
        class OAuth2 { setCredentials() {} async refreshAccessToken() { return { credentials: {} }; } }
        const result = await inspectToken({ tokenPath: 'token.json', readFile: async () => original, OAuth2, credentialsLoader: async () => ({ client_id: 'id', client_secret: 'secret' }) });
        expect(result.status).toBe('valid');
        expect(original).toContain('refresh');
    });

    it('reports refresh failure and scope mismatch without calling a mutating auth flow', async () => {
        const token = JSON.stringify({ refresh_token: 'refresh', scopes: SCOPES });
        class OAuth2 { setCredentials() {} async refreshAccessToken() { throw new Error('revoked'); } }
        await expect(inspectToken({ tokenPath: 'token.json', readFile: async () => token, OAuth2, credentialsLoader: async () => ({}) })).resolves.toMatchObject({ status: 'refresh-failed' });
        await expect(inspectToken({ tokenPath: 'token.json', readFile: async () => JSON.stringify({ refresh_token: 'x', scopes: [] }) })).resolves.toMatchObject({ status: 'scope-mismatch' });
    });

    it('flags moving npx targets and missing absolute paths', async () => {
        expect(checkLaunchTarget({ command: 'npx', args: ['-y', 'google-tools-mcp@latest'] })).toMatchObject({ healthy: false });
        await expect(checkLaunchTarget({ command: 'node', args: ['/missing/index.js'] }, { exists: async () => false })).resolves.toMatchObject({ healthy: false, problem: expect.stringContaining('missing') });
    });

    it('parses JSON client output and preserves unparseable output for review', () => {
        expect(parseClientEntry('{"name":"google","command":"node","args":["x"]}')).toMatchObject({ status: 'found', entry: { command: 'node', args: ['x'] } });
        expect(parseClientEntry('unrecognized cli output')).toMatchObject({ status: 'unknown', raw: 'unrecognized cli output' });
    });
});

describe('setup backups', () => {
    it('merges credentials after a final line without a newline using an atomic same-directory 0600 file', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-env-'));
        try {
            const envPath = path.join(root, '.env');
            await fs.writeFile(envPath, 'GOOGLE_MCP_PORT=3939');
            let renameCalled = false;
            await mergeCredentialEnv(envPath, { GOOGLE_CLIENT_ID: 'new', GOOGLE_CLIENT_SECRET: 'secret' }, {
                rename: async (from, to) => {
                    renameCalled = true;
                    expect(path.dirname(from)).toBe(path.dirname(to));
                    expect(to).toBe(envPath);
                    return fs.rename(from, to);
                },
            });
            const text = await fs.readFile(envPath, 'utf8');
            expect(text).toContain('GOOGLE_MCP_PORT=3939\nGOOGLE_CLIENT_ID=new\n');
            expect(text).toContain('GOOGLE_CLIENT_ID=new');
            expect(text).toContain('GOOGLE_CLIENT_SECRET=secret');
            expect(renameCalled).toBe(true);
            if (process.platform !== 'win32') {
                expect((await fs.stat(envPath)).mode & 0o777).toBe(0o600);
                expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
            }
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    });

    it('refuses a symlinked credential env without changing its target or renaming a temp file', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-env-link-'));
        try {
            const target = path.join(root, 'target.env');
            const envPath = path.join(root, '.env');
            await fs.writeFile(target, 'UNCHANGED=yes\n');
            try { await fs.symlink(target, envPath, 'file'); }
            catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) return; throw error; }
            const rename = jest.fn();
            await expect(mergeCredentialEnv(envPath, { GOOGLE_CLIENT_SECRET: 'secret' }, { rename })).rejects.toThrow(/unsafe credential.*path/i);
            expect(await fs.readFile(target, 'utf8')).toBe('UNCHANGED=yes\n');
            expect(rename).not.toHaveBeenCalled();
            expect((await fs.readdir(root)).filter(name => name.includes('.tmp-'))).toEqual([]);
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    });
    it('keeps two recoverable credential backups and redacts client secrets', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-setup-backup-'));
        try {
            const envPath = path.join(root, '.env');
            await fs.writeFile(envPath, 'GOOGLE_CLIENT_SECRET=old');
            const creationModes = [];
            const open = async (target, flags, mode) => { creationModes.push({ target, flags, mode }); return fs.open(target, flags, mode); };
            await backupEnvFile(envPath, { open });
            await backupEnvFile(envPath, { open });
            await backupEnvFile(envPath, { open });
            expect(creationModes).toHaveLength(3);
            expect(creationModes.every(({ flags, mode }) => flags === 'wx' && mode === 0o600)).toBe(true);
            const backups = (await fs.readdir(root)).filter(name => name.startsWith('.env.bak.'));
            expect(backups).toHaveLength(2);
            if (process.platform !== 'win32') {
                for (const backup of backups) expect((await fs.stat(path.join(root, backup))).mode & 0o777).toBe(0o600);
            }
            await backupClientEntry({ name: 'Fake' }, {
                command: 'node', env: { API_TOKEN: 'secret-value' },
                headers: { Authorization: 'Bearer http-secret-value' },
            }, { configDir: root });
            const log = await fs.readFile(path.join(root, 'client-config-backups.log'), 'utf8');
            expect(log).toContain('[REDACTED]');
            expect(log).not.toContain('secret-value');
            expect(log).not.toContain('http-secret-value');
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    });

    it('redacts every env/header value regardless of key name and repairs a pre-existing loose config directory', async () => {
        // GOOGLE_MAPS_API_KEY and API_KEY do not match /token|secret|password|
        // authorization/, so the old key-name heuristic let them through. And a
        // config directory created before this fix (or by another tool) can
        // still be 0755; a returning stdio setup must not leave the backup
        // file world-readable inside it.
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-backup-secrets-'));
        try {
            if (process.platform !== 'win32') await fs.chmod(root, 0o755);
            await backupClientEntry({ name: 'Fake' }, {
                command: 'node', args: ['server.js'],
                env: { GOOGLE_MAPS_API_KEY: 'maps-secret-value', API_KEY: 'plain-secret-value' },
            }, { configDir: root });
            const log = await fs.readFile(path.join(root, 'client-config-backups.log'), 'utf8');
            expect(log).toContain('[REDACTED]');
            expect(log).not.toContain('maps-secret-value');
            expect(log).not.toContain('plain-secret-value');
            const parsed = JSON.parse(log.trim());
            expect(parsed.entry).toMatchObject({
                command: 'node', args: ['server.js'],
                env: { GOOGLE_MAPS_API_KEY: '[REDACTED]', API_KEY: '[REDACTED]' },
            });
            if (process.platform !== 'win32') {
                expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
                expect((await fs.stat(path.join(root, 'client-config-backups.log'))).mode & 0o777).toBe(0o600);
            }
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    });

    it('creates token.json and its config directory privately without OAuth or home access', async () => {
        const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-token-mode-'));
        const configDir = path.join(parent, 'config');
        const openModes = [];
        const mkdirModes = [];
        try {
            const tokenPath = await persistTokenCredentials({ clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' }, {
                configDir,
                mkdir: async (target, options) => { mkdirModes.push({ target, options }); return fs.mkdir(target, options); },
                open: async (target, flags, mode) => { openModes.push({ target, flags, mode }); return fs.open(target, flags, mode); },
            });
            expect(tokenPath).toBe(path.join(configDir, 'token.json'));
            expect(mkdirModes).toContainEqual({ target: configDir, options: { recursive: true, mode: 0o700 } });
            expect(openModes).toHaveLength(1);
            expect(openModes[0]).toMatchObject({ flags: 'wx', mode: 0o600 });
            expect(path.dirname(openModes[0].target)).toBe(configDir);
            expect(JSON.parse(await fs.readFile(tokenPath, 'utf8'))).toMatchObject({ client_id: 'id', client_secret: 'secret', refresh_token: 'refresh' });
            if (process.platform !== 'win32') {
                expect((await fs.stat(configDir)).mode & 0o777).toBe(0o700);
                expect((await fs.stat(tokenPath)).mode & 0o777).toBe(0o600);
            }
        } finally { await fs.rm(parent, { recursive: true, force: true }); }
    });
});
