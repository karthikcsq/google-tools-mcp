import { afterEach, describe, expect, test } from '@jest/globals';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repositoryRoot, 'scripts', 'agent-test.mjs');
const ownedSessions = new Map();

function textFromEnvelope(envelope) {
    return envelope?.result?.content?.map((item) => item?.text ?? '').join('\n') ?? '';
}

function jsonFromEnvelope(envelope) {
    return JSON.parse(textFromEnvelope(envelope));
}

function runCli(args, { cwd = repositoryRoot } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, ...args], {
            cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
}

function cliJson(result) {
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toBe('');
    return JSON.parse(result.stdout);
}

async function startSession(transport, goal = `CLI ${transport} integration`) {
    const result = await runCli([
        'start', '--backend', 'offline', '--transport', transport,
        '--goal', goal, '--timeout-ms', '30000',
    ]);
    expect(result).toMatchObject({ code: 0, signal: null });
    const started = cliJson(result);
    expect(started).toMatchObject({ backend: 'offline', transport, runId: expect.any(String), manifest: expect.any(String) });
    const manifest = JSON.parse(await fs.readFile(started.manifest, 'utf8'));
    ownedSessions.set(started.manifest, manifest);
    return { manifestPath: started.manifest, manifest };
}

async function command(session, ...args) {
    const result = await runCli([...args, '--session', session.manifestPath]);
    return { result, body: result.stdout ? JSON.parse(result.stdout) : null };
}

async function finish(session, outcome = 'pass', summary = 'Integration test completed.') {
    const response = await command(session, 'finish', '--outcome', outcome, '--summary', summary);
    ownedSessions.delete(session.manifestPath);
    return response;
}

async function call(session, tool, args, expectedNegative) {
    const options = ['call', tool, '--args', JSON.stringify(args)];
    if (expectedNegative) options.push('--expected-negative', expectedNegative);
    const response = await command(session, ...options);
    return response;
}

async function eventuallyClosed(url) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        try { await fetch(url, { method: 'POST' }); }
        catch { return; }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Owned agent-test broker remained reachable after finish.');
}

async function nativeRequest(session, body, authorization = `Bearer ${session.manifest.nativeMcp.token}`) {
    const headers = {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': body.method,
    };
    if (body.method === 'tools/call' && body.params?.name) headers['mcp-name'] = body.params.name;
    if (authorization) headers.authorization = authorization;
    return fetch(session.manifest.nativeMcp.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}

afterEach(async () => {
    for (const [manifestPath, manifest] of ownedSessions) {
        await runCli(['finish', '--session', manifestPath, '--outcome', 'blocked', '--summary', 'Jest cleanup after assertion failure.']).catch(() => {});
        ownedSessions.delete(manifestPath);
    }
});

describe('agent-test CLI integration', () => {
    test.each(['stdio', 'http'])('starts an offline %s session and runs a complete Docs lifecycle', async (transport) => {
        const help = await runCli(['help']);
        expect(help).toMatchObject({ code: 0, signal: null });
        expect(cliJson(help).usage).toContain('start --backend offline|live --transport stdio|http');

        const session = await startSession(transport);
        try {
            const listing = await command(session, 'list');
            expect(listing.result).toMatchObject({ code: 0, signal: null });
            expect(listing.body.result.tools).toHaveLength(160);
            expect(listing.body.result.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['createDocument', 'readDocument', 'appendText']));

            const describe = await command(session, 'describe', 'createDocument');
            expect(describe.result).toMatchObject({ code: 0, signal: null });
            expect(describe.body.tool).toMatchObject({ name: 'createDocument', inputSchema: expect.any(Object) });

            const longContent = `begin-${'abcdefghijklmnopqrstuvwxyz'.repeat(28)}-end`;
            expect(longContent.length).toBeGreaterThan(600);
            const create = await call(session, 'createDocument', {
                title: `CLI ${transport} document`, parentFolderId: session.manifest.folderId,
                initialContent: longContent, contentFormat: 'raw',
            });
            expect(create.result).toMatchObject({ code: 0, signal: null });
            const document = jsonFromEnvelope(create.body);
            expect(document.id).toEqual(expect.any(String));

            const read = await call(session, 'readDocument', {
                documentId: document.id, format: 'text', writeLocalFile: false,
            });
            expect(read.result).toMatchObject({ code: 0, signal: null });
            expect(textFromEnvelope(read.body)).toContain(longContent);
            expect(read.body.result.readHandle).toEqual(expect.any(String));

            const append = await call(session, 'appendText', {
                documentId: document.id, text: ' appended', addNewlineIfNeeded: false,
                readHandle: read.body.result.readHandle,
            });
            expect(append.result).toMatchObject({ code: 0, signal: null });
            expect(textFromEnvelope(append.body)).toContain('Successfully appended text');

            const report = await finish(session);
            expect(report.result).toMatchObject({ code: 0, signal: null });
            expect(report.body).toMatchObject({ verdict: { strictPass: true }, cleanup: { remaining: [] } });
            expect(report.body.cleanup.cleaned).toContain(document.id);
            await eventuallyClosed(session.manifest.controlUrl);
        } finally {
            if (ownedSessions.has(session.manifestPath)) await finish(session, 'blocked', 'Test failed before normal finish.');
        }
    }, 120_000);

    test('accepts a UTF-8 BOM args file and keeps independent session fixtures isolated', async () => {
        const argsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-agent-test-'));
        const argsFile = path.join(argsDir, 'document.json');
        const first = await startSession('stdio', 'fixture A');
        const second = await startSession('stdio', 'fixture B');
        try {
            const args = { title: 'BOM args document', parentFolderId: first.manifest.folderId, initialContent: 'A-only', contentFormat: 'raw' };
            await fs.writeFile(argsFile, `\uFEFF${JSON.stringify(args)}`, 'utf8');
            const created = await command(first, 'call', 'createDocument', '--args', `@${argsFile}`);
            expect(created.result).toMatchObject({ code: 0, signal: null });
            const document = jsonFromEnvelope(created.body);

            const inaccessible = await call(second, 'getFileInfo', { fileId: document.id }, 'Fixture A resource must not exist in fixture B.');
            expect(inaccessible.result).toMatchObject({ code: 0, signal: null });
            expect(inaccessible.body.result.isError).toBe(true);

            const secondCreated = await call(second, 'createDocument', {
                title: 'B-only', parentFolderId: second.manifest.folderId, initialContent: 'B-only', contentFormat: 'raw',
            });
            expect(secondCreated.result).toMatchObject({ code: 0, signal: null });

            const firstReport = await finish(first);
            const secondReport = await finish(second);
            expect(firstReport.body.verdict.strictPass).toBe(true);
            expect(secondReport.body.verdict.strictPass).toBe(true);
            expect(firstReport.body.runId).not.toBe(secondReport.body.runId);
        } finally {
            if (ownedSessions.has(first.manifestPath)) await finish(first, 'blocked', 'Test cleanup.');
            if (ownedSessions.has(second.manifestPath)) await finish(second, 'blocked', 'Test cleanup.');
            await fs.rm(argsDir, { recursive: true, force: true });
        }
    }, 120_000);

    test('records expected, unexpected, blocked, and friction outcomes without falsely reporting strict pass', async () => {
        const expected = await startSession('stdio', 'expected schema failure');
        try {
            const negative = await call(expected, 'createDocument', {}, 'Missing required title is an intentional schema check.');
            expect(negative.result).toMatchObject({ code: 0, signal: null });
            expect(negative.body.result.isError).toBe(true);
            const meaningful = await call(expected, 'createDocument', {
                title: 'valid after negative', parentFolderId: expected.manifest.folderId, initialContent: 'ok', contentFormat: 'raw',
            });
            expect(meaningful.result.code).toBe(0);
            const report = await finish(expected);
            expect(report.body).toMatchObject({ verdict: { strictPass: true }, totals: { unexpectedFailures: 0 } });
        } finally {
            if (ownedSessions.has(expected.manifestPath)) await finish(expected, 'blocked', 'Test cleanup.');
        }

        const failure = await startSession('stdio', 'unexpected failure and friction');
        try {
            const unexpected = await call(failure, 'createDocument', {});
            expect(unexpected.result.code).toBe(1);
            expect(unexpected.body.result.isError).toBe(true);
            const friction = await command(failure, 'friction', '--text', 'The schema failure was intentionally recorded as friction.');
            expect(friction.result.code).toBe(0);
            const report = await finish(failure);
            expect(report.result.code).toBe(1);
            expect(report.body.verdict.strictPass).toBe(false);
            expect(report.body.verdict.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/unexpected failure/i), expect.stringMatching(/friction/i)]));
        } finally {
            if (ownedSessions.has(failure.manifestPath)) await finish(failure, 'blocked', 'Test cleanup.');
        }

        const blocked = await startSession('stdio', 'offline unsupported operation');
        try {
            const unsupported = await call(blocked, 'createPresentation', {
                name: 'Offline refusal', slides: [{ title: 'Nope', content: 'Offline' }], parentFolderId: blocked.manifest.folderId,
            });
            expect(unsupported.result.code).toBe(1);
            expect(textFromEnvelope(unsupported.body)).toMatch(/unavailable in the offline agent-test backend/i);
            const report = await finish(blocked, 'blocked', 'Offline backend does not implement Slides.');
            expect(report.result.code).toBe(1);
            expect(report.body).toMatchObject({ finalOutcome: 'blocked', verdict: { strictPass: false }, totals: { offlineUnsupported: 1 } });
        } finally {
            if (ownedSessions.has(blocked.manifestPath)) await finish(blocked, 'blocked', 'Test cleanup.');
        }
    }, 120_000);

    test('rejects invalid broker authentication and accounts for direct native HTTP schema failures', async () => {
        const session = await startSession('http', 'native HTTP accounting');
        try {
            const missingControlAuth = await fetch(session.manifest.controlUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'status' }),
            });
            const wrongControlAuth = await fetch(session.manifest.controlUrl, {
                method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: JSON.stringify({ command: 'status' }),
            });
            expect(missingControlAuth.status).toBe(401);
            expect(wrongControlAuth.status).toBe(401);

            const protocolMeta = { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } };
            const missingNativeAuth = await nativeRequest(session, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: protocolMeta }, '');
            const wrongNativeAuth = await nativeRequest(session, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: protocolMeta }, 'Bearer wrong');
            expect(missingNativeAuth.status).toBe(401);
            expect(wrongNativeAuth.status).toBe(401);

            const list = await nativeRequest(session, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: protocolMeta });
            expect(list.status).toBe(200);
            expect((await list.json()).result.tools).toHaveLength(160);

            const schemaFailure = await nativeRequest(session, {
                jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'createDocument', arguments: {}, ...protocolMeta },
            });
            expect(schemaFailure.status).toBe(200);
            expect((await schemaFailure.json()).result.isError).toBe(true);
            const unknownTool = await nativeRequest(session, {
                jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'notARealTool', arguments: {}, ...protocolMeta },
            });
            expect(unknownTool.status).toBe(200);
            const unknownEnvelope = await unknownTool.json();
            expect(unknownEnvelope.error || unknownEnvelope.result?.isError).toBeTruthy();

            const report = await finish(session, 'fail', 'Raw HTTP failures were deliberate.');
            expect(report.result.code).toBe(1);
            expect(report.body.verdict.strictPass).toBe(false);
            expect(report.body.calls).toEqual(expect.arrayContaining([
                expect.objectContaining({ source: 'native-http', tool: 'createDocument', outcome: 'error' }),
                expect.objectContaining({ source: 'native-http', tool: 'notARealTool', outcome: 'error' }),
            ]));
        } finally {
            if (ownedSessions.has(session.manifestPath)) await finish(session, 'blocked', 'Test cleanup.');
        }
    }, 120_000);
});
