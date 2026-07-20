// Tests for the secure local workspace (dist/workspace.js).
//
// These pin the security hardening required for a per-session working-copy
// file that holds Google Doc contents on disk:
//   - per-user base directory scoping (no shared /tmp/google-tools-mcp path);
//   - tab-scoped filenames so two tabs of one document don't collide;
//   - refusal to write when the base directory is a symlink (planted-dir attack);
//   - O_NOFOLLOW so a pre-planted symlink at the target path can't be clobbered
//     (POSIX);
//   - private permissions (0700 dir / 0600 file) on POSIX.
import { describe, it, expect, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getWorkspaceDir, getWorkspacePath, writeWorkspaceFile } from '../dist/workspace.js';

const isWin = process.platform === 'win32';
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Detect whether this environment can create symlinks (Windows often can't
// without Developer Mode / admin). Used to skip symlink-specific assertions.
async function canSymlink() {
    const probeDir = path.join(os.tmpdir(), `gtm-symprobe-${uid()}`);
    const target = path.join(probeDir, 'target');
    const link = path.join(probeDir, 'link');
    try {
        await fs.mkdir(probeDir, { recursive: true });
        await fs.writeFile(target, 'x');
        await fs.symlink(target, link);
        return true;
    } catch {
        return false;
    } finally {
        await fs.rm(probeDir, { recursive: true, force: true });
    }
}

const created = [];
afterEach(async () => {
    for (const p of created.splice(0)) {
        await fs.rm(p, { recursive: true, force: true }).catch(() => {});
    }
});

describe('workspace path scoping', () => {
    it('base dir is under the OS temp dir and scoped per-user', () => {
        const dir = getWorkspaceDir();
        expect(dir.startsWith(os.tmpdir())).toBe(true);
        expect(path.basename(dir).startsWith('google-tools-mcp-')).toBe(true);
        // Not a shared, unscoped path.
        expect(path.basename(dir)).not.toBe('google-tools-mcp');
    });

    it('scopes the filename by documentId', () => {
        const p = getWorkspacePath('doc-ABC');
        expect(path.basename(p)).toBe('doc-ABC.md');
        expect(path.dirname(p)).toBe(getWorkspaceDir());
    });

    it('gives two tabs of the same document distinct files', () => {
        const noTab = getWorkspacePath('docX');
        const tabA = getWorkspacePath('docX', 'tab-A');
        const tabB = getWorkspacePath('docX', 'tab-B');
        expect(tabA).not.toBe(tabB);
        expect(tabA).not.toBe(noTab);
        expect(path.basename(tabA)).toBe('docX.tab-A.md');
        expect(path.basename(tabB)).toBe('docX.tab-B.md');
    });

    it('sanitizes unexpected characters out of the filename', () => {
        const p = getWorkspacePath('../../etc/passwd');
        // No path separators survive → cannot traverse out of the base dir.
        expect(path.dirname(p)).toBe(getWorkspaceDir());
        expect(path.basename(p)).not.toContain('/');
        expect(path.basename(p)).not.toContain('\\');
    });
});

describe('writeWorkspaceFile', () => {
    it('writes content and returns a readable path', async () => {
        created.push(getWorkspaceDir());
        const id = `doc-${uid()}`;
        const p = await writeWorkspaceFile(id, 'hello content');
        expect(p).toBe(getWorkspacePath(id));
        expect(await fs.readFile(p, 'utf-8')).toBe('hello content');
    });

    it('overwrites (truncates) an existing file', async () => {
        created.push(getWorkspaceDir());
        const id = `doc-${uid()}`;
        await writeWorkspaceFile(id, 'a much longer first version');
        const p = await writeWorkspaceFile(id, 'short');
        expect(await fs.readFile(p, 'utf-8')).toBe('short');
    });

    it('keeps tab writes separate on disk', async () => {
        created.push(getWorkspaceDir());
        const id = `doc-${uid()}`;
        await writeWorkspaceFile(id, 'tab one body', 'tab-1');
        await writeWorkspaceFile(id, 'tab two body', 'tab-2');
        expect(await fs.readFile(getWorkspacePath(id, 'tab-1'), 'utf-8')).toBe('tab one body');
        expect(await fs.readFile(getWorkspacePath(id, 'tab-2'), 'utf-8')).toBe('tab two body');
    });

    (isWin ? it.skip : it)('creates a 0700 base dir and 0600 file (POSIX)', async () => {
        created.push(getWorkspaceDir());
        const id = `doc-${uid()}`;
        const p = await writeWorkspaceFile(id, 'secret');
        const dirStat = await fs.stat(getWorkspaceDir());
        const fileStat = await fs.stat(p);
        expect(dirStat.mode & 0o777).toBe(0o700);
        expect(fileStat.mode & 0o777).toBe(0o600);
    });

    it('refuses to write when the base dir is a symlink', async () => {
        if (!(await canSymlink())) {
            return; // environment can't create symlinks; skip
        }
        const dir = getWorkspaceDir();
        const decoy = path.join(os.tmpdir(), `gtm-decoy-${uid()}`);
        created.push(dir, decoy);
        await fs.rm(dir, { recursive: true, force: true });
        await fs.mkdir(decoy, { recursive: true });
        await fs.symlink(decoy, dir, 'dir');
        await expect(writeWorkspaceFile(`doc-${uid()}`, 'data')).rejects.toThrow(/symlink|not a regular directory/i);
    });

    (isWin ? it.skip : it)('does not follow a pre-planted symlink at the target path (POSIX)', async () => {
        if (!(await canSymlink())) {
            return;
        }
        created.push(getWorkspaceDir());
        const id = `doc-${uid()}`;
        const victim = path.join(os.tmpdir(), `gtm-victim-${uid()}.txt`);
        created.push(victim);
        await fs.mkdir(getWorkspaceDir(), { recursive: true, mode: 0o700 });
        await fs.writeFile(victim, 'ORIGINAL VICTIM CONTENT');
        // Plant a symlink at the exact path writeWorkspaceFile will target.
        await fs.symlink(victim, getWorkspacePath(id));
        await expect(writeWorkspaceFile(id, 'attacker-redirected data')).rejects.toThrow();
        // Victim file must be untouched.
        expect(await fs.readFile(victim, 'utf-8')).toBe('ORIGINAL VICTIM CONTENT');
    });
});
