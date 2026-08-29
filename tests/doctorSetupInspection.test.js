import { describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDoctorDesiredEntryResolver, formatDoctorReport, resolveDoctorTransport } from '../dist/doctor.js';
import { loadEnvFile } from '../dist/config.js';
import { registerSecret } from '../dist/errors.js';
import { checkCredentials, inspectSetup, inspectToken, resolveAuthSource } from '../dist/setupInspect.js';
import { runSetup } from '../dist/setup.js';
import { registerAllTools } from '../dist/tools/index.js';

const desired = { command: 'node', args: ['server.js'], env: { CODEX_MCP_PROTOCOL_VERSION: '2026-07-28' } };
const adapter = (name, current) => ({ name, async detect() { return true; }, async get() { return current; } });

describe('doctor report and setup inspection', () => {
    it('uses the HTTP transport persisted by setup for a fresh doctor invocation without a transport environment variable', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-doctor-transport-'));
        try {
            const envPath = path.join(root, '.env');
            await fs.writeFile(envPath, 'GOOGLE_MCP_TRANSPORT=http\n');
            const persisted = Object.fromEntries((await fs.readFile(envPath, 'utf8')).trim().split('\n').map(line => line.split('=')));
            expect(await resolveDoctorTransport({ env: persisted, getHttpStatus: async () => ({ healthy: false }) })).toBe('http');
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    });

    it('uses a healthy managed HTTP service when no transport was persisted', async () => {
        expect(await resolveDoctorTransport({ env: {}, getHttpStatus: async () => ({ healthy: true }) })).toBe('http');
    });
    it('redacts entry Authorization values, unknown raw output, and registered secrets in JSON and human output', () => {
        const unregister = registerSecret('registered-doctor-secret');
        try {
            const report = { healthy: false, problems: ['registered-doctor-secret'], clients: [
                { client: 'entry', status: 'problem', entry: { headers: { Authorization: 'Bearer planted-entry-token' } } },
                { client: 'raw', status: 'unknown', raw: 'Authorization: Bearer planted-raw-token' },
            ] };
            for (const json of [true, false]) {
                const output = formatDoctorReport(report, json);
                expect(output).not.toMatch(/planted-entry-token|planted-raw-token|registered-doctor-secret/);
                expect(output).toContain('[REDACTED]');
            }
        } finally { unregister(); }
    });

    it.each([
        ['wrong URL', { url: 'http://127.0.0.1:9999/mcp', bearer_token_env_var: 'GOOGLE_MCP_HTTP_TOKEN' }, { url: 'http://127.0.0.1:3939/mcp', bearer_token_env_var: 'GOOGLE_MCP_HTTP_TOKEN' }],
        ['wrong transport', { url: 'http://127.0.0.1:3939/mcp' }, desired],
        ['missing env block', { command: 'node', args: ['server.js'] }, desired],
        ['missing Codex protocol version', { command: 'node', args: ['server.js'], env: {} }, desired],
    ])('reports %s as unhealthy', async (_label, currentEntry, recommended) => {
        const report = await inspectSetup({ adapters: [adapter('Codex', { status: 'found', entry: currentEntry })], desiredEntry: recommended,
            inspectHttp: async () => ({ healthy: true }), credentialsCheck: async () => ({ configured: true }),
            tokenCheck: async () => ({ status: 'valid' }), configWarnings: [] });
        expect(report.healthy).toBe(false);
        expect(report.clients[0]).toMatchObject({ status: 'problem', matchesRecommended: false });
    });

    it('reads the persisted HTTP token without filesystem mutation for exact Claude comparison', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-doctor-token-'));
        const tokenPath = path.join(root, 'http-token');
        const token = 'persisted-doctor-token-value';
        try {
            await fs.writeFile(tokenPath, `${token}\n`);
            const lstat = jest.fn(fs.lstat);
            const readFile = jest.fn(fs.readFile);
            const resolver = await createDoctorDesiredEntryResolver({
                launch: { command: 'node', args: ['server.js'] }, transport: { transport: 'http', url: 'http://127.0.0.1:3939/mcp' },
                env: {}, configDir: root, lstat, readFile,
            });
            const desiredClaude = { type: 'http', url: 'http://127.0.0.1:3939/mcp', headers: { Authorization: `Bearer ${token}` } };
            expect(resolver({ name: 'Claude Code' })).toEqual({ desiredEntry: desiredClaude, problem: undefined });
            expect(lstat).toHaveBeenCalledWith(tokenPath);
            expect(readFile).toHaveBeenCalledWith(tokenPath, 'utf8');

            const correct = await inspectSetup({ adapters: [adapter('Claude Code', { status: 'found', entry: desiredClaude })], desiredEntries: resolver,
                inspectHttp: async () => ({ healthy: true }), credentialsCheck: async () => ({ configured: true }), tokenCheck: async () => ({ status: 'valid' }), configWarnings: [] });
            expect(correct.clients[0].status).toBe('configured');
            const mismatch = await inspectSetup({ adapters: [adapter('Claude Code', { status: 'found', entry: { ...desiredClaude, url: 'http://127.0.0.1:9999/mcp' } })], desiredEntries: resolver,
                inspectHttp: async () => ({ healthy: true }), credentialsCheck: async () => ({ configured: true }), tokenCheck: async () => ({ status: 'valid' }), configWarnings: [] });
            expect(mismatch.clients[0]).toMatchObject({ status: 'problem', matchesRecommended: false });
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    });

    it('makes Codex HTTP unhealthy when its future launch environment lacks the token', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-doctor-codex-'));
        try {
            await fs.writeFile(path.join(root, 'http-token'), 'persisted-doctor-token-value\n');
            const resolver = await createDoctorDesiredEntryResolver({ launch: { command: 'node', args: ['server.js'] },
                transport: { transport: 'http', url: 'http://127.0.0.1:3939/mcp' }, env: {}, configDir: root });
            const current = { url: 'http://127.0.0.1:3939/mcp', bearer_token_env_var: 'GOOGLE_MCP_HTTP_TOKEN' };
            const report = await inspectSetup({ adapters: [adapter('Codex', { status: 'found', entry: current })], desiredEntries: resolver,
                inspectHttp: async () => ({ healthy: true }), credentialsCheck: async () => ({ configured: true }), tokenCheck: async () => ({ status: 'valid' }), configWarnings: [] });
            expect(report.healthy).toBe(false);
            expect(report.clients[0].problem).toMatch(/missing from the Codex launch environment/i);
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    });

    it('does not mistake a token loaded from google-tools-mcp config for Codex inherited environment', async () => {
        const resolver = await createDoctorDesiredEntryResolver({ launch: { command: 'node', args: ['server.js'] },
            transport: { transport: 'http', url: 'http://127.0.0.1:3939/mcp' },
            env: { GOOGLE_MCP_HTTP_TOKEN: 'config-only-token' }, loadedConfigKeys: ['GOOGLE_MCP_HTTP_TOKEN'] });
        expect(resolver({ name: 'Codex' }).problem).toMatch(/missing from the Codex launch environment/i);
    });

    it('treats a null or failed desired-entry construction as a problem', async () => {
        for (const desiredEntries of [() => null, () => ({ desiredEntry: null, problem: 'construction failed' })]) {
            const report = await inspectSetup({ adapters: [adapter('Client', { status: 'found', entry: desired })], desiredEntries,
                credentialsCheck: async () => ({ configured: true }), tokenCheck: async () => ({ status: 'valid' }), configWarnings: [] });
            expect(report.healthy).toBe(false);
            expect(report.clients[0].status).toBe('problem');
        }
    });
    it('reports missing, unknown, mismatched, and healthy entries', async () => {
        const cases = [
            ['missing', { status: 'missing' }, 'missing client entry'],
            ['unknown', { status: 'unknown', raw: 'garbage' }, 'unrecognized client entry'],
            ['wrong', { status: 'found', entry: { command: 'other', args: [] } }, 'entry differs from recommended configuration'],
            ['healthy', { status: 'found', entry: desired }, undefined],
        ];
        for (const [name, current, problem] of cases) {
            const report = await inspectSetup({ adapters: [adapter(name, current)], desiredEntry: desired, inspectHttp: async () => ({ healthy: true }), credentialsCheck: async () => ({ configured: true }), tokenCheck: async () => ({ status: 'valid' }), configWarnings: [] });
            expect(report.clients[0].problem).toBe(problem);
            expect(report.clients[0].status).toBe(problem ? 'problem' : 'configured');
        }
    });
    it('reports a service-account-only installation as healthy with no OAuth files', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-service-account-'));
        try {
            const keyPath = path.join(root, 'key.json');
            await fs.writeFile(keyPath, JSON.stringify({
                type: 'service_account', client_email: 'robot@example.iam.gserviceaccount.com',
                private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
            }));
            const env = { SERVICE_ACCOUNT_PATH: keyPath, GOOGLE_IMPERSONATE_USER: 'user@example.com' };
            expect(resolveAuthSource(env)).toBe('service-account');

            // No client secrets anywhere and no token.json: exactly the
            // configuration dist/auth.js authorizes through JWT.
            const credentials = await checkCredentials({ env, load: async () => { throw new Error('no OAuth credentials'); } });
            expect(credentials).toMatchObject({ configured: true, source: 'service-account' });
            expect(credentials.serviceAccount).toMatchObject({ healthy: true, clientEmail: 'robot@example.iam.gserviceaccount.com', impersonateUser: 'user@example.com' });
            const token = await inspectToken({ env, tokenPath: path.join(root, 'token.json') });
            expect(token).toEqual({ status: 'not-applicable', source: 'service-account' });

            const report = await inspectSetup({
                credentialsCheck: () => checkCredentials({ env, load: async () => { throw new Error('no OAuth credentials'); } }),
                tokenCheck: () => inspectToken({ env, tokenPath: path.join(root, 'token.json') }),
                configWarnings: [],
            });
            expect(report.problems).toEqual([]);
            expect(report.healthy).toBe(true);
            expect(JSON.stringify(report.problems)).not.toMatch(/OAuth/);
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    });

    it.each([
        ['missing key file', null, /key file not found/],
        ['unparseable key file', 'not json', /could not be read or parsed/],
        ['key file without a private key', JSON.stringify({ client_email: 'robot@example.com' }), /no client_email\/private_key/],
    ])('reports a broken service-account configuration as a service-account problem: %s', async (_label, contents, expected) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-service-account-bad-'));
        try {
            const keyPath = path.join(root, 'key.json');
            if (contents !== null) await fs.writeFile(keyPath, contents);
            const env = { SERVICE_ACCOUNT_PATH: keyPath };
            const report = await inspectSetup({
                credentialsCheck: () => checkCredentials({ env, load: async () => { throw new Error('no OAuth credentials'); } }),
                tokenCheck: () => inspectToken({ env }), configWarnings: [],
            });
            expect(report.healthy).toBe(false);
            expect(report.problems).toHaveLength(1);
            expect(report.problems[0]).toMatch(/^Service account: /);
            expect(report.problems[0]).toMatch(expected);
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    });

    it('lets returning setup skip the OAuth wizard for a healthy service account', async () => {
        const messages = [];
        const ui = {
            intro: () => {}, outro: value => messages.push(String(value)),
            log: Object.fromEntries(['message', 'error', 'success', 'step'].map(name => [name, value => messages.push(String(value))])),
        };
        let authFlowRuns = 0;
        for (const reauth of [false, true]) {
            await runSetup({
                reauth,
                checkCredentialsImpl: async () => ({ configured: true, source: 'service-account', serviceAccount: { healthy: true, impersonateUser: 'user@example.com' } }),
                inspectTokenImpl: async () => ({ status: 'not-applicable', source: 'service-account' }),
                runAuthFlowImpl: async () => { authFlowRuns += 1; },
                existingLaunchTargetImpl: async () => ({ command: 'node', args: ['/installed/index.js'] }),
                configureTransportImpl: async () => ({ transport: 'stdio' }),
                registerClientsImpl: async () => ({ detected: false }),
                ui, clear: () => {},
            });
        }
        // Not once, and not even with --reauth: there is no OAuth token here.
        expect(authFlowRuns).toBe(0);
        const output = messages.join('\n');
        expect(output).toContain('Service account credentials are configured and valid (impersonating user@example.com)');
        expect(output).toContain('--reauth does not apply');
        expect(output).not.toContain('Authenticate with Google');
        expect(output).toContain('Setup complete!');
    });

    it('surfaces config warnings as doctor problems and config output', async () => {
        const report = await inspectSetup({ credentialsCheck: async () => ({ configured: true }), tokenCheck: async () => ({ status: 'valid' }), configWarnings: ['Malformed config line /tmp/.env:2; expected KEY=VALUE.'] });
        expect(report.healthy).toBe(false);
        expect(report.problems[0]).toContain('Config:');
        expect(report.config.warnings).toHaveLength(1);
    });

    it('surfaces malformed-config warnings in the troubleshoot report', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-troubleshoot-warning-'));
        const envPath = path.join(root, '.env');
        const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            await fs.writeFile(envPath, 'GOOGLE_MCP_PORT 4949\n');
            expect(loadEnvFile(envPath)).toBe(true);
            const tools = new Map();
            await registerAllTools({ addTool: definition => tools.set(definition.name, definition) });
            const report = JSON.parse(await tools.get('troubleshoot').execute({}));
            expect(report.config.warnings).toEqual(expect.arrayContaining([
                expect.stringContaining(`${envPath}:1`),
            ]));
        } finally {
            stderr.mockRestore();
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});
