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
//
// Sandboxing: every test in the 'writeWorkspaceFile' describe block below
// actually writes to (and, in the symlink tests, deletes/replaces) whatever
// directory getWorkspaceDir() resolves to. getWorkspaceDir() normally returns
// the REAL per-user production directory that readDocument/
// replaceDocumentWithMarkdown use to hold live working copies of a user's
// Google Docs. Running these tests against that real path -- and recursively
// deleting it in cleanup, as this suite used to -- can destroy a user's saved
// working copies, and colliding on one shared path also isn't safe across
// parallel Jest workers.
//
// GOOGLE_MCP_WORKSPACE_DIR (see dist/workspace.js) overrides the
// resolved directory. Every test that writes anything sets it (directly or
// via the describe-level beforeAll/afterAll below) to a directory obtained
// from fs.mkdtemp() -- a fresh, collision-proof sandbox -- and restores the
// previous value afterward. No test in this file ever removes the real
// production path; the only directories ever deleted here are ones this file
// itself created via mkdtemp.
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getWorkspaceDir, getWorkspacePath, writeWorkspaceFile, backupIfLocallyModified } from '../dist/workspace.js';

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

describe('workspace path scoping (default, unoverridden directory)', () => {
    // No override active here: this block never writes to disk, it only
    // inspects the path strings getWorkspaceDir()/getWorkspacePath() produce,
    // so it is safe to run against the real default resolution.
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
    let sandboxDir;
    let previousEnvValue;

    beforeAll(async () => {
        previousEnvValue = process.env.GOOGLE_MCP_WORKSPACE_DIR;
        // A dedicated sandbox for this describe block only. Never the
        // production path, and unique per test run so parallel Jest workers
        // (and parallel CI runs) can never collide on it.
        sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtm-workspace-test-'));
        process.env.GOOGLE_MCP_WORKSPACE_DIR = sandboxDir;
    });

    afterAll(async () => {
        if (previousEnvValue === undefined) {
            delete process.env.GOOGLE_MCP_WORKSPACE_DIR;
        } else {
            process.env.GOOGLE_MCP_WORKSPACE_DIR = previousEnvValue;
        }
        // Safe: sandboxDir is a directory this file created with mkdtemp, never
        // the real per-user production workspace.
        await fs.rm(sandboxDir, { recursive: true, force: true });
    });

    it('writes content and returns a readable path', async () => {
        const id = `doc-${uid()}`;
        const p = await writeWorkspaceFile(id, 'hello content');
        expect(p).toBe(getWorkspacePath(id));
        expect(await fs.readFile(p, 'utf-8')).toBe('hello content');
    });

    it('overwrites (truncates) an existing file', async () => {
        const id = `doc-${uid()}`;
        await writeWorkspaceFile(id, 'a much longer first version');
        const p = await writeWorkspaceFile(id, 'short');
        expect(await fs.readFile(p, 'utf-8')).toBe('short');
    });

    it('keeps tab writes separate on disk', async () => {
        const id = `doc-${uid()}`;
        await writeWorkspaceFile(id, 'tab one body', 'tab-1');
        await writeWorkspaceFile(id, 'tab two body', 'tab-2');
        expect(await fs.readFile(getWorkspacePath(id, 'tab-1'), 'utf-8')).toBe('tab one body');
        expect(await fs.readFile(getWorkspacePath(id, 'tab-2'), 'utf-8')).toBe('tab two body');
    });

    (isWin ? it.skip : it)('creates a 0700 base dir and 0600 file (POSIX)', async () => {
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
        // This test needs to delete-and-replace the base directory itself, so
        // it uses its OWN fresh, never-before-existing path for the duration
        // of the test rather than touching the shared sandboxDir (which other
        // tests in this file rely on staying a real directory). The override
        // is restored to sandboxDir in `finally`.
        const priorOverride = process.env.GOOGLE_MCP_WORKSPACE_DIR;
        const testDir = path.join(os.tmpdir(), `gtm-symlink-basedir-${uid()}`);
        const decoy = path.join(os.tmpdir(), `gtm-decoy-${uid()}`);
        process.env.GOOGLE_MCP_WORKSPACE_DIR = testDir;
        try {
            await fs.mkdir(decoy, { recursive: true });
            await fs.symlink(decoy, testDir, 'dir');
            await expect(writeWorkspaceFile(`doc-${uid()}`, 'data')).rejects.toThrow(/symlink|not a regular directory/i);
        } finally {
            process.env.GOOGLE_MCP_WORKSPACE_DIR = priorOverride;
            // testDir/decoy are paths this test invented via uid() and never
            // existed before this test created them -- safe to remove.
            await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
            await fs.rm(decoy, { recursive: true, force: true }).catch(() => {});
        }
    });

    (isWin ? it.skip : it)('does not follow a pre-planted symlink at the target path (POSIX)', async () => {
        if (!(await canSymlink())) {
            return;
        }
        const id = `doc-${uid()}`;
        const victim = path.join(os.tmpdir(), `gtm-victim-${uid()}.txt`);
        const linkPath = getWorkspacePath(id);
        await fs.writeFile(victim, 'ORIGINAL VICTIM CONTENT');
        // Plant a symlink at the exact path writeWorkspaceFile will target,
        // inside the shared sandbox dir (which ensureSafeBaseDir() will have
        // already created as a real directory by earlier tests in this block).
        await fs.mkdir(getWorkspaceDir(), { recursive: true, mode: 0o700 });
        await fs.symlink(victim, linkPath);
        try {
            await expect(writeWorkspaceFile(id, 'attacker-redirected data')).rejects.toThrow();
            // Victim file must be untouched.
            expect(await fs.readFile(victim, 'utf-8')).toBe('ORIGINAL VICTIM CONTENT');
        } finally {
            // Clean up only the specific symlink and victim file this test
            // created -- never the shared sandbox directory itself.
            await fs.rm(linkPath, { force: true }).catch(() => {});
            await fs.rm(victim, { force: true }).catch(() => {});
        }
    });
});

// Issue #122: readDocument used to overwrite the local mirror unconditionally,
// silently destroying an in-progress local edit. backupIfLocallyModified is
// the guard: called right before the next writeWorkspaceFile, it copies
// whatever is currently on disk to `<path>.bak` when that content looks like
// something OTHER than this process's own last write to it.
describe('backupIfLocallyModified (#122)', () => {
    let sandboxDir;
    let previousEnvValue;

    beforeAll(async () => {
        previousEnvValue = process.env.GOOGLE_MCP_WORKSPACE_DIR;
        sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtm-workspace-backup-test-'));
        process.env.GOOGLE_MCP_WORKSPACE_DIR = sandboxDir;
    });

    afterAll(async () => {
        if (previousEnvValue === undefined) {
            delete process.env.GOOGLE_MCP_WORKSPACE_DIR;
        } else {
            process.env.GOOGLE_MCP_WORKSPACE_DIR = previousEnvValue;
        }
        await fs.rm(sandboxDir, { recursive: true, force: true });
    });

    it('does nothing when there is no file on disk yet', async () => {
        const id = `doc-${uid()}`;
        const result = await backupIfLocallyModified(getWorkspacePath(id));
        expect(result).toEqual({ backedUp: false });
    });

    it('does not back up immediately after writeWorkspaceFile itself wrote the file', async () => {
        const id = `doc-${uid()}`;
        await writeWorkspaceFile(id, 'fresh from a read');
        const result = await backupIfLocallyModified(getWorkspacePath(id));
        expect(result).toEqual({ backedUp: false });
    });

    it('backs up when the on-disk file was modified after this process last wrote it', async () => {
        const id = `doc-${uid()}`;
        const p = await writeWorkspaceFile(id, 'original read content');
        // Simulate a human editing the working copy readDocument told them to edit.
        await fs.writeFile(p, 'MY UNPUSHED LOCAL EDIT', 'utf-8');
        const future = new Date(Date.now() + 10_000);
        await fs.utimes(p, future, future);

        const result = await backupIfLocallyModified(p);
        expect(result.backedUp).toBe(true);
        expect(result.backupPath).toBe(`${p}.bak`);
        expect(await fs.readFile(result.backupPath, 'utf-8')).toBe('MY UNPUSHED LOCAL EDIT');
        // The original file is untouched by the backup step itself — only the
        // NEXT writeWorkspaceFile call overwrites it, which the caller controls.
        expect(await fs.readFile(p, 'utf-8')).toBe('MY UNPUSHED LOCAL EDIT');
    });

    it('errs toward a backup for a file this process never wrote (no record, e.g. after a restart)', async () => {
        const id = `doc-${uid()}`;
        const p = getWorkspacePath(id);
        // Written directly, bypassing writeWorkspaceFile — no in-memory record
        // of this path exists, exactly like a mirror left over from a previous
        // process. There is no way to prove it is safe to clobber.
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, 'pre-existing content, unknown origin', 'utf-8');

        const result = await backupIfLocallyModified(p);
        expect(result.backedUp).toBe(true);
        expect(await fs.readFile(result.backupPath, 'utf-8')).toBe('pre-existing content, unknown origin');
    });

    it('a subsequent writeWorkspaceFile still succeeds normally after a backup', async () => {
        const id = `doc-${uid()}`;
        const p = await writeWorkspaceFile(id, 'v1');
        await fs.writeFile(p, 'local edit', 'utf-8');
        const future = new Date(Date.now() + 10_000);
        await fs.utimes(p, future, future);
        await backupIfLocallyModified(p);

        const written = await writeWorkspaceFile(id, 'v2 from the new read');
        expect(await fs.readFile(written, 'utf-8')).toBe('v2 from the new read');
    });

    it('does not back up a second time in a row once its own write is the most recent one', async () => {
        const id = `doc-${uid()}`;
        const p = await writeWorkspaceFile(id, 'v1');
        await fs.writeFile(p, 'local edit', 'utf-8');
        const future = new Date(Date.now() + 10_000);
        await fs.utimes(p, future, future);
        const first = await backupIfLocallyModified(p);
        expect(first.backedUp).toBe(true);

        await writeWorkspaceFile(id, 'v2, our own fresh write');
        const second = await backupIfLocallyModified(p);
        expect(second).toEqual({ backedUp: false });
    });
});
