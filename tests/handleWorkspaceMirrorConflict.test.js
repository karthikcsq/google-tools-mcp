// Issue #122: the SDK v2 handle path writes a user-facing editable content.md.
// It must protect an existing local edit with the same guard as the legacy
// document/tab mirror. The deterministic IDs model a reused path directly;
// before the guard this second creation overwrote the edit with no .bak file.
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const WORKSPACE_ROOT = path.join(os.tmpdir(), `gtm-handle-mirror-conflict-${process.pid}-${Date.now()}`);
process.env.GOOGLE_MCP_WORKSPACE_DIR = WORKSPACE_ROOT;

const { createHandleWorkspace, resetHandleRuntimeState } = await import('../dist/handleRuntime.js');

beforeEach(() => resetHandleRuntimeState());
afterEach(async () => {
    resetHandleRuntimeState();
    await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true });
});

describe('SDK v2 editable handle workspace conflict handling (#122)', () => {
    it('backs up an immediate local edit before reusing an editable handle path', async () => {
        const ids = { workspaceId: 'reused-handle-workspace', ownershipManifest: 'first-handle-manifest' };
        const first = await createHandleWorkspace({
            profile: 'default', fileId: 'doc-122', revisionId: 'rev-1', fingerprint: 'fingerprint-1', content: 'remote v1',
            ...ids,
        });
        await fs.writeFile(first.editablePath, 'LOCAL EDIT NOT PUSHED', 'utf8');

        // resetHandleRuntimeState intentionally leaves disk untouched, exactly
        // like a process-local handle registry being rebuilt around a retained
        // path. The second write must preserve the editable content first.
        resetHandleRuntimeState();
        const second = await createHandleWorkspace({
            profile: 'default', fileId: 'doc-122', revisionId: 'rev-2', fingerprint: 'fingerprint-2', content: 'remote v2',
            workspaceId: ids.workspaceId, ownershipManifest: 'second-handle-manifest',
        });

        expect(second.backedUp).toBe(true);
        expect(second.backupPath).toBe(`${first.editablePath}.bak`);
        expect(await fs.readFile(second.backupPath, 'utf8')).toBe('LOCAL EDIT NOT PUSHED');
        expect(await fs.readFile(second.editablePath, 'utf8')).toBe('remote v2');
    });
});
