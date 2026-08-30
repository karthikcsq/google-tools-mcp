import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { connectModernHttpClient } from '../dist/httpClient.js';
import {
    createHandleWorkspace, getReadHandleStore, resetHandleRuntimeState, setResultHandle, syncRuntimeBinding,
} from '../dist/handleRuntime.js';
import { prepareMcpServerFactory, startV2HttpServer } from '../dist/mcpServer.js';
import { getRequestContext } from '../dist/requestContext.js';

const TOKEN = 'two-real-http-clients-share-one-stable-token';
const WORKSPACE_ROOT = path.join(os.tmpdir(), `google-tools-mcp-two-client-${process.pid}-${Date.now()}`);
process.env.GOOGLE_MCP_WORKSPACE_DIR = WORKSPACE_ROOT;

function text(result) {
    return result.content?.find((item) => item.type === 'text')?.text;
}

async function factory() {
    return prepareMcpServerFactory({
        registerTools: async (server) => {
            server.addTool({
                name: 'readCopy', description: 'issue an isolated editable copy',
                parameters: z.object({ content: z.string() }),
                execute: async ({ content }) => {
                    const context = getRequestContext();
                    syncRuntimeBinding(context);
                    const workspace = await createHandleWorkspace({
                        profile: context.profile, fileId: 'same-document', revisionId: 'same-revision',
                        fingerprint: 'same-structure', content,
                    });
                    const issued = getReadHandleStore().issue({
                        resourceKind: 'docs', resourceId: 'same-document', scope: 'document',
                        tabId: null, revisionId: 'same-revision', structuralFingerprint: 'same-structure',
                        version: 1, workspace: workspace.workspace,
                    }, { context });
                    setResultHandle(issued.readHandle, issued.expiresAt);
                    return { content: [{ type: 'text', text: content }] };
                },
            });
            server.addTool({
                name: 'editCopy', description: 'edit only the possessed handle workspace',
                parameters: z.object({ readHandle: z.string(), content: z.string() }),
                execute: async ({ readHandle, content }) => {
                    const context = getRequestContext();
                    syncRuntimeBinding(context);
                    const workspace = getReadHandleStore().getInternalWorkspace(readHandle, { context });
                    await fs.writeFile(workspace.editablePath, content, 'utf8');
                    getReadHandleStore().markWorkspaceDirty(readHandle, true, { context });
                    return 'edited';
                },
            });
            server.addTool({
                name: 'inspectCopy', description: 'read only the possessed handle workspace',
                parameters: z.object({ readHandle: z.string() }),
                execute: async ({ readHandle }) => {
                    const context = getRequestContext();
                    syncRuntimeBinding(context);
                    const workspace = getReadHandleStore().getInternalWorkspace(readHandle, { context });
                    return fs.readFile(workspace.editablePath, 'utf8');
                },
            });
        },
    });
}

afterEach(async () => {
    resetHandleRuntimeState();
    await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true });
});

describe('two real HTTP MCP clients', () => {
    it('serves two independent SDK clients concurrently with distinct handles and workspaces', async () => {
        const runtime = await startV2HttpServer(await factory(), {
            auth: { token: TOKEN }, host: '127.0.0.1', port: 0, profile: 'default',
        });
        const url = `http://127.0.0.1:${runtime.server.address().port}/mcp`;
        const first = await connectModernHttpClient(url, { token: TOKEN, clientInfo: { name: 'client-one', version: '1' } });
        const second = await connectModernHttpClient(url, { token: TOKEN, clientInfo: { name: 'client-two', version: '1' } });
        try {
            const [left, right] = await Promise.all([
                first.callTool('readCopy', { content: 'identical source' }),
                second.callTool('readCopy', { content: 'identical source' }),
            ]);
            expect(left.readHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(right.readHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(left.readHandle).not.toBe(right.readHandle);

            await first.callTool('editCopy', { readHandle: left.readHandle, content: 'client one edit' });
            expect(text(await first.callTool('inspectCopy', { readHandle: left.readHandle }))).toBe('client one edit');
            expect(text(await second.callTool('inspectCopy', { readHandle: right.readHandle }))).toBe('identical source');

            // The static bearer intentionally represents one service principal:
            // possession of an opaque handle, rather than a claimed client id,
            // is what authorizes access to that handle's private workspace.
            expect(text(await second.callTool('inspectCopy', { readHandle: left.readHandle }))).toBe('client one edit');

            await first.close();
            expect((await second.listTools()).tools.map(({ name }) => name)).toEqual(['editCopy', 'inspectCopy', 'readCopy']);

            const unauthenticated = await connectModernHttpClient(url, { token: 'wrong-token-that-is-still-well-formed' });
            await expect(unauthenticated.listTools()).rejects.toThrow();
            await unauthenticated.close();
        } finally {
            await first.close();
            await second.close();
            await runtime.close();
        }
    });
});
