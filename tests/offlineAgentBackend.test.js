import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioRpcClient } from '../scripts/agent-testing/stdio-client.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(repositoryRoot, 'scripts', 'agent-testing', 'offline-stdio-server.mjs');
const probePath = path.join(repositoryRoot, 'scripts', 'agent-testing', 'offline-backend-probe.mjs');

function toolText(envelope) {
    return envelope?.result?.content?.map((part) => part?.text ?? '').join('\n') ?? '';
}

function jsonToolResult(envelope) {
    return JSON.parse(toolText(envelope));
}

async function runNode(script, args = []) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, ...args], {
            cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
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

describe('offline agent backend', () => {
    let workspaceDir;
    let child;
    let client;
    let stderr = '';

    beforeAll(async () => {
        workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-offline-'));
        child = spawn(process.execPath, [serverPath], {
            cwd: repositoryRoot,
            env: {
                ...process.env,
                GOOGLE_MCP_AGENT_TEST_CONFIG: JSON.stringify({
                    backend: 'offline',
                    folderId: 'agent_test_root',
                    workspaceDir,
                    journalFile: path.join(workspaceDir, 'journal.jsonl'),
                    runId: 'jest-offline',
                }),
            },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        client = new StdioRpcClient(child, { timeoutMs: 30_000 });
        const discover = await client.discover();
        expect(discover.error).toBeUndefined();
    }, 35_000);

    afterAll(async () => {
        await client?.close();
        if (workspaceDir) await fs.rm(workspaceDir, { recursive: true, force: true });
    }, 10_000);

    test('tracks unsupported calls, preserves Docs batch atomicity, and exposes cleanup state', async () => {
        const result = await runNode(probePath, [workspaceDir]);
        expect(result).toMatchObject({ code: 0, signal: null });
        const probe = JSON.parse(result.stdout);
        expect(probe).toMatchObject({
            unsupportedCode: 'OFFLINE_UNSUPPORTED',
            afterText: '\n',
            beforeRevision: probe.afterRevision,
        });
        expect(probe.beforeCleanupStatus).toMatchObject({
            resourceCount: 1,
            counters: { unsupported: 1 },
            lastUnsupported: { method: 'docs.documents.batchUpdate' },
        });
        expect(probe.status).toMatchObject({
            activeFileIds: ['agent_test_root'], resourceCount: 0,
        });
    });

    test('runs the production stdio tools against stateful Drive, Docs, and Sheets', async () => {
        const folder = jsonToolResult(await client.callTool('createFolder', {
            name: 'agent workflow', parentFolderId: 'agent_test_root',
        }));

        const document = jsonToolResult(await client.callTool('createDocument', {
            title: 'Notes', parentFolderId: folder.id, initialContent: 'alpha', contentFormat: 'raw',
        }));
        expect(document.warnings).toBeUndefined();

        const firstRead = await client.callTool('readDocument', {
            documentId: document.id, format: 'text', writeLocalFile: false,
        });
        const secondRead = await client.callTool('readDocument', {
            documentId: document.id, format: 'text', writeLocalFile: false,
        });
        expect(firstRead.result.readHandle).toEqual(expect.any(String));
        expect(secondRead.result.readHandle).toEqual(expect.any(String));

        const append = await client.callTool('appendText', {
            documentId: document.id,
            text: ' beta',
            addNewlineIfNeeded: false,
            readHandle: secondRead.result.readHandle,
        });
        expect(toolText(append)).toContain('Successfully appended text');

        const staleAppend = await client.callTool('appendText', {
            documentId: document.id,
            text: ' stale',
            addNewlineIfNeeded: false,
            readHandle: firstRead.result.readHandle,
        });
        expect(staleAppend.result.isError).toBe(true);
        expect(toolText(staleAppend)).toMatch(/revision|changed|read handle/i);

        const current = await client.callTool('readDocument', {
            documentId: document.id, format: 'text', writeLocalFile: false,
        });
        expect(toolText(current)).toContain('alpha beta');

        const modified = await client.callTool('modifyText', {
            documentId: document.id,
            target: { textToFind: 'beta' },
            text: 'gamma',
            readHandle: current.result.readHandle,
        });
        expect(toolText(modified)).toContain('Successfully replaced text');
        const afterModify = await client.callTool('readDocument', {
            documentId: document.id, format: 'text', writeLocalFile: false,
        });
        expect(toolText(afterModify)).toContain('alpha gamma');

        const copied = jsonToolResult(await client.callTool('copyFile', {
            fileId: document.id, name: 'Notes copy', parentFolderId: folder.id,
        }));
        const renamed = await client.callTool('renameFile', { fileId: copied.id, newName: 'Notes archive' });
        expect(toolText(renamed)).toContain('Notes archive');
        const metadata = await client.callTool('getFileInfo', { fileId: copied.id });
        expect(toolText(metadata)).toContain('Notes archive');
        const cleanup = jsonToolResult(await client.callTool('deleteFile', { fileId: copied.id }));
        expect(cleanup.action).toBe('trashed');

        const spreadsheet = jsonToolResult(await client.callTool('createSpreadsheet', {
            title: 'Numbers', parentFolderId: folder.id, initialData: [['item', 'count']],
        }));
        const write = await client.callTool('writeSpreadsheet', {
            spreadsheetId: spreadsheet.id, range: 'A2:B2', values: [['widgets', 2]],
        });
        expect(toolText(write)).toContain('Successfully wrote 2 cells');
        const sheet = await client.callTool('readSpreadsheet', {
            spreadsheetId: spreadsheet.id, range: 'A1:B2',
        });
        expect(JSON.parse(toolText(sheet)).values).toEqual([['item', 'count'], ['widgets', 2]]);

        const listing = await client.callTool('listFolderContents', { folderId: folder.id });
        expect(toolText(listing)).toContain('Notes');
        expect(toolText(listing)).toContain('Numbers');
        expect(toolText(listing)).not.toContain('Notes archive');

        const unavailable = await client.callTool('createPresentation', {
            name: 'No network deck', slides: [{ title: 'One', content: 'Offline must refuse this.' }], parentFolderId: folder.id,
        });
        expect(unavailable.result.isError).toBe(true);
        expect(toolText(unavailable)).toMatch(/unavailable in the offline agent-test backend/i);
        expect(stderr).not.toMatch(/Google authentication required|Unable to read config file/i);
    }, 35_000);
});
