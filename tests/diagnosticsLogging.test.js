import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createV2HttpHandler, MCP_PROTOCOL_VERSION, prepareMcpServerFactory } from '../dist/mcpServer.js';
import { getArgumentShape, getStructuredLogFilePath, logToolCall, logger, resetLoggerForTests, setLogRotationThresholdForTests } from '../dist/logger.js';
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
    it('writes one redacted record per success and classified failure without argument values', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-jsonl-'));
        process.env.GOOGLE_MCP_LOG_FILE = join(directory, 'server.log');
        process.env.GOOGLE_MCP_JSONL_FILE = join(directory, 'server.jsonl');
        const secret = 'diagnostic-secret-value-0123456789';
        const release = registerSecret(secret);
        const factory = await prepareMcpServerFactory({ registerTools: async (server) => {
            server.addTool({ name: 'ok', parameters: z.object({ body: z.string() }), execute: async () => 'ok' });
            server.addTool({ name: 'user', parameters: z.object({}), execute: async () => { throw publicError(`fix token=${secret}`); } });
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
});
