import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { createV2HttpHandler, MCP_PROTOCOL_VERSION, prepareMcpServerFactory } from '../dist/mcpServer.js';
import { classifyUpstreamError, wrapOperationError } from '../dist/errors.js';
import { executeRetrySafeTool, isRetrySafeReadTool } from '../dist/tools/index.js';
import { inspectSetup } from '../dist/setupInspect.js';
import { executeBatchUpdate } from '../dist/googleDocsApiHelpers.js';
import { readRange } from '../dist/googleSheetsApiHelpers.js';

const TOKEN = 'phase-one-diagnostics-token';

function apiError(status, reason, message = 'raw upstream error should never reach the caller', headers) {
    return Object.assign(new Error(message), {
        code: status,
        response: { status, headers, data: { error: { code: status, message, errors: [{ reason }] } } },
    });
}

function request(name) {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            'mcp-protocol-version': MCP_PROTOCOL_VERSION,
            'mcp-method': 'tools/call',
            'mcp-name': name,
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name,
                arguments: {},
                _meta: {
                    'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
                    'io.modelcontextprotocol/clientCapabilities': {},
                },
            },
        }),
    });
}

describe('Phase 1 diagnostic contracts', () => {
    it.each([
        [403, 'userRateLimitExceeded', { code: 'RATE_LIMITED', status: 403, retryable: true, reason: 'rate-limit' }],
        [403, 'dailyLimitExceeded', { code: 'QUOTA_EXHAUSTED', status: 403, retryable: false, reason: 'quota-exhausted' }],
        [403, 'domainPolicy', { code: 'PERMISSION_DENIED', status: 403, retryable: false, reason: 'permission-denied' }],
        [404, 'notFound', { code: 'NOT_FOUND', status: 404, retryable: false, reason: 'not-found' }],
    ])('normalizes %i / %s into a closed safe error contract', (status, reason, expected) => {
        const raw = apiError(status, reason, `unsafe path C:/private/${reason}/token.json`);
        expect(classifyUpstreamError(wrapOperationError('read file', raw))).toMatchObject(expected);
    });

    it('returns a safe structured API failure without exposing upstream text', async () => {
        const raw = apiError(403, 'userRateLimitExceeded', 'Bearer hidden-token from C:/private/token.json');
        const factory = await prepareMcpServerFactory({ registerTools: async (server) => {
            server.addTool({ name: 'listMessages', description: 'read', parameters: z.object({}), execute: async () => { throw raw; } });
        } });
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const response = await (await handler.fetch(request('listMessages'))).json();
            expect(response.result.isError).toBe(true);
            expect(response.result.structuredContent).toEqual({ error: {
                code: 'RATE_LIMITED', status: 403, retryable: true, reason: 'rate-limit',
            } });
            expect(response.result.content[0].text).toContain('Retry with exponential backoff');
            expect(JSON.stringify(response.result)).not.toContain('hidden-token');
            expect(JSON.stringify(response.result)).not.toContain('C:/private');
        } finally { await handler.close(); }
    });

    it.each([
        ['Sheets', () => readRange({ spreadsheets: { values: { get: async () => {
            throw apiError(403, 'userRateLimitExceeded', 'Sheets quota at C:/private/sheets-token.json');
        } } } }, 'sheet-1', 'A1')],
        ['Docs', () => executeBatchUpdate({ documents: { batchUpdate: async () => {
            throw apiError(403, 'userRateLimitExceeded', 'Docs quota at C:/private/docs-token.json');
        } } }, 'doc-1', [{ insertText: {} }])],
    ])('keeps a %s quota cause intact through the production MCP error wrapper', async (_service, execute) => {
        const factory = await prepareMcpServerFactory({ registerTools: async (server) => {
            server.addTool({ name: 'listMessages', description: 'read', parameters: z.object({}), execute });
        } });
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const response = await (await handler.fetch(request('listMessages'))).json();
            expect(response.result.structuredContent.error).toEqual({
                code: 'RATE_LIMITED', status: 403, retryable: true, reason: 'rate-limit',
            });
            expect(JSON.stringify(response.result)).not.toContain('C:/private');
        } finally { await handler.close(); }
    });

    it('marks transient mutation outcomes non-retryable', async () => {
        const factory = await prepareMcpServerFactory({ registerTools: async (server) => {
            server.addTool({ name: 'writeThing', description: 'write', parameters: z.object({}), execute: async () => {
                throw apiError(503, 'backendError');
            } });
        } });
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const response = await (await handler.fetch(request('writeThing'))).json();
            expect(response.result.structuredContent.error).toMatchObject({
                code: 'SERVICE_UNAVAILABLE', status: 503, retryable: false, reason: 'outcome-unknown',
            });
            expect(response.result.content[0].text).toContain('did not confirm whether this change completed');
        } finally { await handler.close(); }
    });

    it('retries only known read operations with bounded exponential delays', async () => {
        const waits = [];
        let readAttempts = 0;
        await expect(executeRetrySafeTool('listMessages', {}, async () => {
            readAttempts += 1;
            if (readAttempts < 3) throw apiError(429, 'rateLimitExceeded');
            return 'ok';
        }, { wait: async (delay) => waits.push(delay), random: () => 0.5 })).resolves.toBe('ok');
        expect(waits).toEqual([100, 200]);

        let writeAttempts = 0;
        await expect(executeRetrySafeTool('writeSpreadsheet', {}, async () => {
            writeAttempts += 1;
            throw apiError(503, 'backendError');
        }, { wait: async () => { throw new Error('writes must not wait for a retry'); } })).rejects.toThrow('raw upstream');
        expect(writeAttempts).toBe(1);
        expect(isRetrySafeReadTool('manageFilter', { action: 'create' })).toBe(false);
        expect(isRetrySafeReadTool('manageFilter', { action: 'get' })).toBe(true);
    });

    it('honors a bounded Retry-After response before retrying a read', async () => {
        const waits = [];
        let attempts = 0;
        await expect(executeRetrySafeTool('listMessages', {}, async () => {
            attempts += 1;
            if (attempts === 1) throw apiError(429, 'rateLimitExceeded', undefined, { get: () => '1' });
            return 'ok';
        }, { wait: async (delay) => waits.push(delay), random: () => 0, now: () => 0 })).resolves.toBe('ok');
        expect(waits).toEqual([1000]);
    });

    it('reports an installed but unconfigured client without failing doctor', async () => {
        const report = await inspectSetup({
            adapters: [{ name: 'Codex', detect: async () => true, get: async () => ({ status: 'missing' }) }],
            desiredEntry: { command: 'google-tools-mcp', args: [] },
            credentialsCheck: async () => ({ configured: true }),
            tokenCheck: async () => ({ status: 'valid' }),
            configWarnings: [],
        });
        expect(report.healthy).toBe(true);
        expect(report.clients).toEqual([expect.objectContaining({ client: 'Codex', status: 'unconfigured' })]);
        expect(report.problems).toEqual([]);
    });

    it('treats a selected client missing registration as a doctor failure', async () => {
        const report = await inspectSetup({
            adapters: [{ name: 'Codex', detect: async () => true, get: async () => ({ status: 'missing' }) }],
            desiredEntry: { command: 'google-tools-mcp', args: [] },
            requiredClients: ['Codex'],
            credentialsCheck: async () => ({ configured: true }),
            tokenCheck: async () => ({ status: 'valid' }),
            configWarnings: [],
        });
        expect(report.healthy).toBe(false);
        expect(report.clients[0]).toEqual(expect.objectContaining({ status: 'problem', problem: 'missing client entry' }));
    });
});
