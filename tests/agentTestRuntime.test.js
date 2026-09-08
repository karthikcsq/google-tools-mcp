import { afterEach, describe, expect, test } from '@jest/globals';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compactToolSearch } from '../scripts/agent-testing/common.mjs';
import { cleanupResources, makeRecorder } from '../scripts/agent-testing/instrumented-server.mjs';

let temporary = null;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runNode(file) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [file], { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 15_000);
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
}

afterEach(async () => {
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    temporary = null;
});

describe('agent-test runtime accounting', () => {
    test('captures a tool stdout leak even on its in-process stdio transport', async () => {
        temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-agent-runtime-'));
        const recorder = makeRecorder({
            backend: 'offline', workspaceDir: temporary, journalFile: path.join(temporary, 'journal.jsonl'),
        }, { getStatus: () => ({ counters: { unsupported: 0 } }) });
        await expect(recorder.execute({
            name: 'leaksStdout',
            execute: async () => { process.stdout.write('rogue tool output\n'); return 'ok'; },
        }, {}, { log: {} })).resolves.toBe('ok');
        expect(recorder.state.stdoutLeaks).toEqual(['rogue tool output\n']);
        expect(await fs.readFile(path.join(temporary, 'journal.jsonl'), 'utf8')).toContain('stdout-leak');
    });

    test('compacts searched discovery while leaving the full MCP envelope available by default', () => {
        const envelope = {
            jsonrpc: '2.0', id: 7,
            result: {
                tools: [
                    { name: 'createDocument', description: 'Creates a document in Drive.', inputSchema: { type: 'object' } },
                    { name: 'copyFile', description: 'Copies a file in Drive.', inputSchema: { type: 'object' } },
                    { name: 'getProfile', description: 'Reads the authenticated profile.', inputSchema: { type: 'object' } },
                ],
            },
        };
        const compact = compactToolSearch(envelope, 'document');
        expect(compact).toEqual({
            jsonrpc: '2.0', id: 7,
            result: { tools: [{ name: 'createDocument', description: 'Creates a document in Drive.' }] },
        });
        expect(envelope.result.tools[0]).toHaveProperty('inputSchema');
        expect(envelope.result.tools).toHaveLength(3);
    });

    test('live cleanup treats deleted and trashed resources as clean, verifies new trash state, and keeps containment', async () => {
        temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-agent-runtime-'));
        const files = new Map([
            ['needs-trash', { trashed: false }],
            ['already-trashed', { trashed: true }],
        ]);
        const reads = [];
        const updates = [];
        const notFound = () => Object.assign(new Error('not found'), { code: 404 });
        const rawDrive = {
            'files.get': async ({ fileId }) => {
                reads.push(fileId);
                if (fileId === 'already-deleted') throw notFound();
                const file = files.get(fileId);
                if (!file) throw notFound();
                return { data: { id: fileId, trashed: file.trashed } };
            },
            'files.update': async ({ fileId }) => {
                updates.push(fileId);
                const file = files.get(fileId);
                if (!file) throw notFound();
                file.trashed = true;
                return { data: { id: fileId, trashed: true } };
            },
        };
        const guard = {
            ensureInstrumented: async () => {}, rawDrive: async () => rawDrive,
            isInsideTestFolder: async (id) => id === 'needs-trash',
        };
        const recorder = makeRecorder({
            backend: 'live', workspaceDir: temporary, journalFile: path.join(temporary, 'journal.jsonl'),
        }, { backend: { backend: 'live' }, guard });
        recorder.state.resources.push(
            { id: 'needs-trash', kind: 'drive' },
            { id: 'already-trashed', kind: 'drive' },
            { id: 'already-deleted', kind: 'drive' },
        );

        const cleanup = await cleanupResources({ backendState: { backend: { backend: 'live' }, guard }, recorder });
        expect(cleanup.remaining).toEqual([]);
        expect(cleanup.cleaned).toEqual(expect.arrayContaining(['needs-trash', 'already-trashed', 'already-deleted']));
        expect(updates).toEqual(['needs-trash']);
        expect(reads.filter((id) => id === 'needs-trash')).toHaveLength(2);
        expect(reads).toEqual(expect.arrayContaining(['already-trashed', 'already-deleted']));
    });

    test('the live factory binds the first guard to its child folder with offline fake clients', async () => {
        temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-agent-live-guard-'));
        const childFile = path.join(temporary, 'live-guard-probe.mjs');
        const url = (relative) => pathToFileURL(path.join(repositoryRoot, relative)).href;
        await fs.writeFile(childFile, `
            import { PassThrough } from 'node:stream';
            import { installOfflineBackend } from ${JSON.stringify(url('scripts/agent-testing/offline.mjs'))};

            const workspaceDir = ${JSON.stringify(path.join(temporary, 'workspace'))};
            await installOfflineBackend({ folderId: 'agent_test_root', workspaceDir });
            const { getDriveClient } = await import(${JSON.stringify(url('dist/clients.js'))});
            const { createInstrumentedFactory, cleanupResources } = await import(${JSON.stringify(url('scripts/agent-testing/instrumented-server.mjs'))});
            const { startV2Stdio } = await import(${JSON.stringify(url('dist/mcpServer.js'))});
            const { StdioRpcClient } = await import(${JSON.stringify(url('scripts/agent-testing/stdio-client.mjs'))});
            const drive = await getDriveClient();
            const sibling = (await drive.files.create({ requestBody: {
                name: 'sibling', mimeType: 'application/vnd.google-apps.folder', parents: ['agent_test_root'],
            } })).data.id;
            const { factory, backendState, recorder } = await createInstrumentedFactory({
                backend: 'live', folderId: 'agent_test_root', workspaceDir,
                journalFile: ${JSON.stringify(path.join(temporary, 'journal.jsonl'))}, runId: 'fake-live-guard',
            });
            let outsideRejected = false;
            try {
                await drive.files.update({ fileId: sibling, requestBody: { trashed: true }, supportsAllDrives: true });
            } catch (error) {
                outsideRejected = Boolean(error?.safety) || /not inside the live-smoke test folder/i.test(String(error?.message || ''));
            }
            const input = new PassThrough();
            const output = new PassThrough();
            const runtime = startV2Stdio(factory, { input, output });
            const client = new StdioRpcClient({ stdin: input, stdout: output, once() {} }, { timeoutMs: 10_000 });
            await client.discover();
            const created = await client.callTool('createDocument', {
                title: 'child-only', parentFolderId: backendState.folderId, initialContent: 'safe', contentFormat: 'raw',
            });
            if (created?.error || created?.result?.isError) throw new Error('The child-folder Docs write was rejected.');
            const cleanup = await cleanupResources({ backendState, recorder });
            await runtime.close();
            process.stdout.write('__PROBE__' + JSON.stringify({
                insideChild: await backendState.guard.isInsideTestFolder(backendState.folderId), outsideRejected,
                cleaned: cleanup.cleaned, remaining: cleanup.remaining,
            }));
        `, 'utf8');

        const result = await runNode(childFile);
        expect(result.signal).toBeNull();
        if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'live guard probe failed without output');
        const marker = result.stdout.lastIndexOf('__PROBE__');
        expect(marker).toBeGreaterThanOrEqual(0);
        const probe = JSON.parse(result.stdout.slice(marker + '__PROBE__'.length));
        expect(probe).toMatchObject({ insideChild: true, outsideRejected: true, remaining: [] });
        expect(probe.cleaned).toEqual(expect.arrayContaining([expect.any(String)]));
    }, 30_000);
});
