import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createV2HttpHandler, MCP_PROTOCOL_VERSION, prepareMcpServerFactory } from '../dist/mcpServer.js';
import { getArgumentShape, getLogFilePath, getStructuredLogFilePath, logToolCall, logger, readRecentToolCalls, resetLoggerForTests, setLogRotationThresholdForTests } from '../dist/logger.js';
import { publicError, registerSecret } from '../dist/errors.js';

const originalEnv = { ...process.env };
afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    resetLoggerForTests();
    setLogRotationThresholdForTests();
});

function request(name, args) {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer diagnostic-test-token', 'content-type': 'application/json', 'mcp-protocol-version': MCP_PROTOCOL_VERSION, 'mcp-method': 'tools/call', 'mcp-name': name },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
    });
}

describe('structured diagnostics', () => {
    it('keeps caller-supplied public-error text out of JSONL while retaining the classified failure', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-jsonl-'));
        process.env.GOOGLE_MCP_LOG_FILE = join(directory, 'server.log');
        process.env.GOOGLE_MCP_JSONL_FILE = join(directory, 'server.jsonl');
        const secret = 'diagnostic-secret-value-0123456789';
        const release = registerSecret(secret);
        const factory = await prepareMcpServerFactory({ registerTools: async (server) => {
            server.addTool({ name: 'ok', parameters: z.object({ body: z.string() }), execute: async () => 'ok' });
            server.addTool({ name: 'user', parameters: z.object({}), execute: async () => { throw publicError(`fix requested text=diagnostic-caller-content-7f8e9d`); } });
            server.addTool({ name: 'broken', parameters: z.object({}), execute: async () => { throw new Error(`private ${secret}`); } });
        } });
        const handler = createV2HttpHandler(factory, { auth: { token: 'diagnostic-test-token' } });
        try {
            await handler.fetch(request('ok', { body: `content ${secret}` }));
            await handler.fetch(request('user', {}));
            await handler.fetch(request('broken', {}));
            const records = (await readFile(join(directory, 'server.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
            expect(records).toHaveLength(3);
            expect(records.map((record) => record.outcome)).toEqual(['ok', 'user_error', 'error']);
            expect(records.map((record) => record.reqId)).toEqual([...records.map((record) => record.reqId)].sort((a, b) => a - b));
            expect(records[0].argShape).toEqual({ body: `string:${Buffer.byteLength(`content ${secret}`, 'utf8')}` });
            expect(JSON.stringify(records)).not.toContain(secret);
            expect(JSON.stringify(records)).not.toContain('diagnostic-caller-content-7f8e9d');
            expect(records[1]).toMatchObject({ tool: 'user', outcome: 'user_error', errCode: 'USER_ERROR', errMsg: 'caller-visible error' });
            expect(new Set(Object.keys(records[0]))).toEqual(new Set(['ts', 'event', 'tool', 'reqId', 'durationMs', 'outcome', 'errCode', 'errMsg', 'argShape']));
        } finally { release(); await handler.close(); await rm(directory, { recursive: true, force: true }); }
    });

    it('rotates an oversized JSONL file at open and replaces stale retention', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-rotation-'));
        const jsonlPath = join(directory, 'server.jsonl');
        process.env.GOOGLE_MCP_LOG_FILE = join(directory, 'server.log');
        process.env.GOOGLE_MCP_JSONL_FILE = jsonlPath;
        await writeFile(jsonlPath, 'x'.repeat(5 * 1024 * 1024 + 1));
        await writeFile(`${jsonlPath}.1`, 'stale');
        logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'ok', reqId: 1, durationMs: 0, outcome: 'ok', errCode: null, errMsg: null, argShape: getArgumentShape({}) });
        expect((await stat(`${jsonlPath}.1`)).size).toBeGreaterThan(5 * 1024 * 1024);
        expect(await readFile(jsonlPath, 'utf8')).toContain('"tool":"ok"');
        await rm(directory, { recursive: true, force: true });
    });

    it('keeps the documented JSONL field set synchronized with emitted records', async () => {
        const runbook = await readFile('docs/troubleshooting-runbook.md', 'utf8');
        for (const field of ['ts', 'event', 'tool', 'reqId', 'durationMs', 'outcome', 'errCode', 'errMsg', 'argShape']) expect(runbook).toContain(`\`${field}\``);
        expect(getStructuredLogFilePath()).toBeTruthy();
    });

    it('rotates both long-lived plain and JSONL logs during runtime', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-runtime-rotation-'));
        const plainPath = join(directory, 'server.log');
        const jsonlPath = join(directory, 'server.jsonl');
        process.env.GOOGLE_MCP_LOG_FILE = plainPath;
        process.env.GOOGLE_MCP_JSONL_FILE = jsonlPath;
        const payload = 'x'.repeat(1_000);
        setLogRotationThresholdForTests(4_096);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        logger.info('seed');
        for (let i = 0; i < 10; i += 1) {
            logger.info(payload);
            logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'first', reqId: i, durationMs: 0, outcome: 'ok', errCode: null, errMsg: null, argShape: { x: payload } });
        }
        logger.info('after-rotation');
        logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'after', reqId: 2, durationMs: 0, outcome: 'ok', errCode: null, errMsg: null, argShape: {} });
        expect((await stat(`${plainPath}.1`)).size).toBeGreaterThan(0);
        expect((await stat(`${jsonlPath}.1`)).size).toBeGreaterThan(0);
        expect(await readFile(plainPath, 'utf8')).toContain('after-rotation');
        expect(await readFile(jsonlPath, 'utf8')).toContain('"tool":"after"');
        errorSpy.mockRestore();
        await rm(directory, { recursive: true, force: true });
    });

    it('creates diagnostic directories and files private by default', async () => {
        const root = await mkdtemp(join(tmpdir(), 'google-tools-mcp-private-'));
        const directory = join(root, 'diagnostics');
        const plainPath = join(directory, 'server.log');
        const jsonlPath = join(directory, 'server.jsonl');
        process.env.GOOGLE_MCP_LOG_FILE = plainPath;
        process.env.GOOGLE_MCP_JSONL_FILE = jsonlPath;
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            logger.info('create private plain log');
            logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'private', reqId: 1, durationMs: 0, outcome: 'ok', errCode: null, errMsg: null, argShape: {} });
            if (process.platform !== 'win32') {
                expect((await stat(directory)).mode & 0o777).toBe(0o700);
                expect((await stat(plainPath)).mode & 0o777).toBe(0o600);
                expect((await stat(jsonlPath)).mode & 0o777).toBe(0o600);
            }
        } finally { errorSpy.mockRestore(); await rm(root, { recursive: true, force: true }); }
    });

    it('leaves an existing custom log parent directory at its original mode', async () => {
        const root = await mkdtemp(join(tmpdir(), 'google-tools-mcp-shared-parent-'));
        // A directory the operator created and deliberately shares/traverses.
        const shared = join(root, 'shared-logs');
        await mkdir(shared, { recursive: true, mode: 0o755 });
        await chmod(shared, 0o755);
        const before = (await stat(shared)).mode & 0o777;
        const plainPath = join(shared, 'server.log');
        const jsonlPath = join(shared, 'records.jsonl');
        process.env.GOOGLE_MCP_LOG_FILE = plainPath;
        process.env.GOOGLE_MCP_JSONL_FILE = jsonlPath;
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            logger.info('write into a shared parent');
            logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'shared', reqId: 1, durationMs: 0, outcome: 'ok', errCode: null, errMsg: null, argShape: {} });
            expect(await readFile(plainPath, 'utf8')).toContain('write into a shared parent');
            expect(await readFile(jsonlPath, 'utf8')).toContain('"tool":"shared"');
            expect((await stat(shared)).mode & 0o777).toBe(before);
            if (process.platform !== 'win32') {
                expect(before).toBe(0o755);
                // Privacy for a custom location comes from the file mode, not
                // from re-permissioning somebody else's directory.
                expect((await stat(plainPath)).mode & 0o777).toBe(0o600);
                expect((await stat(jsonlPath)).mode & 0o777).toBe(0o600);
            }
        } finally { errorSpy.mockRestore(); await rm(root, { recursive: true, force: true }); }
    });

    it('logs into a system-style shared parent it has no permission to chmod', async () => {
        // The GOOGLE_MCP_LOG_FILE=/tmp/google-tools-mcp.log case. On Linux the
        // temp directory is root-owned with the sticky bit, so any chmod attempt
        // is EPERM; the logger must never need one to start writing.
        const shared = tmpdir();
        const before = (await stat(shared)).mode & 0o777;
        const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
        const plainPath = join(shared, `google-tools-mcp-system-parent-${suffix}.log`);
        process.env.GOOGLE_MCP_LOG_FILE = plainPath;
        process.env.GOOGLE_MCP_JSONL_FILE = '0';
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            logger.info('system parent line');
            expect(stderrSpy.mock.calls.map(([value]) => String(value)).join('')).not.toContain('Unable to write diagnostic log file');
            expect(await readFile(plainPath, 'utf8')).toContain('system parent line');
            expect((await stat(shared)).mode & 0o777).toBe(before);
        } finally {
            stderrSpy.mockRestore(); errorSpy.mockRestore();
            await rm(plainPath, { force: true });
            await rm(`${plainPath}.1`, { force: true });
        }
    });

    it('keeps an explicit JSONL path live when the plain log is disabled', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-jsonl-only-'));
        const jsonlPath = join(directory, 'server.jsonl');
        process.env.GOOGLE_MCP_LOG_FILE = '0';
        process.env.GOOGLE_MCP_JSONL_FILE = jsonlPath;
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(getLogFilePath()).toBeNull();
            expect(getStructuredLogFilePath()).toBe(jsonlPath);
            logger.info('this plain line has no file sink');
            logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'jsonl-only', reqId: 1, durationMs: 0, outcome: 'ok', errCode: null, errMsg: null, argShape: {} });
            expect(await readFile(jsonlPath, 'utf8')).toContain('"tool":"jsonl-only"');
            expect(readRecentToolCalls().records.map(({ tool }) => tool)).toEqual(['jsonl-only']);
            // Nothing else was written into the directory: the plain sink is off.
            expect(await readdir(directory)).toEqual(['server.jsonl']);
        } finally { errorSpy.mockRestore(); await rm(directory, { recursive: true, force: true }); }
    });

    it('still lets GOOGLE_MCP_JSONL_FILE alone disable structured logging', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-jsonl-off-'));
        process.env.GOOGLE_MCP_LOG_FILE = join(directory, 'server.log');
        process.env.GOOGLE_MCP_JSONL_FILE = 'off';
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(getStructuredLogFilePath()).toBeNull();
            logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'never', reqId: 1, durationMs: 0, outcome: 'ok', errCode: null, errMsg: null, argShape: {} });
            logger.info('plain still works');
            expect(await readdir(directory)).toEqual(['server.log']);
            expect(readRecentToolCalls()).toEqual({ filePath: null, records: [] });
        } finally { errorSpy.mockRestore(); await rm(directory, { recursive: true, force: true }); }
    });
});
