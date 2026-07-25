// Tests for dist/setup.js — fast-launch install logic (issue #46).
//
// `npx -y google-tools-mcp` re-resolves the whole dependency tree on every
// launch, which can take 30+ seconds on some machines and lose the race
// against Claude Code's fixed 30s stdio MCP connection timeout. Setup now
// installs the package globally once and points MCP clients directly at the
// resolved dist/index.js via `node`, skipping npx on every subsequent
// launch. These tests cover that resolution and fallback logic with
// injected fakes — no real npm/network/filesystem calls.
import { describe, it, expect, jest } from '@jest/globals';
import path from 'path';
import {
    resolveGlobalIndexPath,
    installGlobalFastLaunch,
    buildLaunchCommand,
    resolveRunningIndexPath,
} from '../dist/setup.js';

// ---------------------------------------------------------------------------
// resolveGlobalIndexPath
// ---------------------------------------------------------------------------
describe('resolveGlobalIndexPath', () => {
    it('joins the global root with the package dist/index.js path', () => {
        const result = resolveGlobalIndexPath('/usr/local/lib/node_modules');
        expect(result).toBe(path.join('/usr/local/lib/node_modules', 'google-tools-mcp', 'dist', 'index.js'));
    });

    it('works with a Windows-style root', () => {
        const root = 'C:\\Users\\2supe\\AppData\\Roaming\\npm\\node_modules';
        const result = resolveGlobalIndexPath(root);
        expect(result).toBe(path.join(root, 'google-tools-mcp', 'dist', 'index.js'));
        expect(result.endsWith(path.join('google-tools-mcp', 'dist', 'index.js'))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// installGlobalFastLaunch
// ---------------------------------------------------------------------------
describe('installGlobalFastLaunch', () => {
    it('returns ok:false without attempting install when npm is not on PATH', async () => {
        const run = jest.fn();
        const access = jest.fn();
        const result = await installGlobalFastLaunch({ run, access, hasNpm: () => false });

        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/npm.*not found/i);
        expect(run).not.toHaveBeenCalled();
        expect(access).not.toHaveBeenCalled();
    });

    it('falls back gracefully when the global install command fails', async () => {
        const run = jest.fn().mockRejectedValueOnce(new Error('EACCES: permission denied'));
        const access = jest.fn();
        const result = await installGlobalFastLaunch({ run, access, hasNpm: () => true });

        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/npm install -g google-tools-mcp failed/);
        expect(result.reason).toMatch(/EACCES/);
        expect(run).toHaveBeenCalledWith('npm install -g google-tools-mcp@latest');
        expect(access).not.toHaveBeenCalled();
    });

    it('falls back gracefully when resolving the npm global root fails', async () => {
        const run = jest.fn()
            .mockResolvedValueOnce('') // install succeeds
            .mockRejectedValueOnce(new Error('npm root -g exploded'));
        const access = jest.fn();
        const result = await installGlobalFastLaunch({ run, access, hasNpm: () => true });

        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/could not resolve the npm global root/);
        expect(access).not.toHaveBeenCalled();
    });

    it('falls back gracefully when the installed dist/index.js cannot be found', async () => {
        const globalRoot = '/usr/local/lib/node_modules';
        const run = jest.fn()
            .mockResolvedValueOnce('') // install succeeds
            .mockResolvedValueOnce(`${globalRoot}\n`); // npm root -g (with trailing newline)
        const access = jest.fn().mockRejectedValueOnce(new Error('ENOENT'));
        const result = await installGlobalFastLaunch({ run, access, hasNpm: () => true });

        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/dist\/index\.js was not found/);
        expect(access).toHaveBeenCalledWith(resolveGlobalIndexPath(globalRoot));
    });

    it('returns ok:true with the resolved index path on success', async () => {
        const globalRoot = '/usr/local/lib/node_modules';
        const run = jest.fn()
            .mockResolvedValueOnce('') // install succeeds
            .mockResolvedValueOnce(`${globalRoot}\n`); // npm root -g
        const access = jest.fn().mockResolvedValueOnce(undefined);
        const result = await installGlobalFastLaunch({ run, access, hasNpm: () => true });

        expect(result.ok).toBe(true);
        expect(result.indexPath).toBe(resolveGlobalIndexPath(globalRoot));
    });
});

// ---------------------------------------------------------------------------
// buildLaunchCommand
// ---------------------------------------------------------------------------
describe('buildLaunchCommand', () => {
    it('builds a direct node launch command when fast-launch succeeded', () => {
        const fastLaunch = { ok: true, indexPath: '/usr/local/lib/node_modules/google-tools-mcp/dist/index.js' };
        const result = buildLaunchCommand(fastLaunch, { execPath: '/usr/bin/node' });

        expect(result.command).toBe('/usr/bin/node');
        expect(result.args).toEqual(['/usr/local/lib/node_modules/google-tools-mcp/dist/index.js']);
        expect(result.shellDisplay).toBe('"/usr/bin/node" "/usr/local/lib/node_modules/google-tools-mcp/dist/index.js"');
    });

    it('quotes paths so a space in the node or install path is still valid shell syntax', () => {
        const fastLaunch = { ok: true, indexPath: 'C:\\Users\\2supe\\google-tools-mcp\\dist\\index.js' };
        const result = buildLaunchCommand(fastLaunch, { execPath: 'C:\\Program Files\\nodejs\\node.exe' });

        expect(result.shellDisplay).toBe(
            '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\2supe\\google-tools-mcp\\dist\\index.js"'
        );
    });

    it('falls back to npx when the global install failed but npx is present', () => {
        const result = buildLaunchCommand(
            { ok: false, reason: 'npm install failed' },
            { hasNpx: () => true },
        );

        expect(result.command).toBe('npx');
        expect(result.args).toEqual(['-y', 'google-tools-mcp']);
        expect(result.shellDisplay).toBe('npx -y google-tools-mcp');
        expect(result.source).toBe('npx');
    });

    it('falls back to npx when no fast-launch result is given', () => {
        const result = buildLaunchCommand(undefined, { hasNpx: () => true });
        expect(result.shellDisplay).toBe('npx -y google-tools-mcp');
    });

    // The npm-missing case is the one that used to produce a broken config: on a
    // standard Node install npm and npx ship together, so no npm almost always
    // means no npx, and writing `npx -y google-tools-mcp` would have handed the
    // user a launch command that cannot run.
    it('does NOT write an npx command when npx is absent', () => {
        const result = buildLaunchCommand(
            { ok: false, npmMissing: true, reason: 'npm was not found on PATH' },
            {
                hasNpx: () => false,
                runningIndexPath: '/opt/pkg/dist/index.js',
                execPath: '/usr/bin/node',
            },
        );

        expect(result.command).toBe('/usr/bin/node');
        expect(result.args).toEqual(['/opt/pkg/dist/index.js']);
        expect(result.source).toBe('running-copy');
    });

    it('returns null when there is no global install, no npx, and no running copy', () => {
        const result = buildLaunchCommand(
            { ok: false, npmMissing: true, reason: 'npm was not found on PATH' },
            { hasNpx: () => false, runningIndexPath: null },
        );

        expect(result).toBeNull();
    });

    it('prefers the global install over both fallbacks', () => {
        const result = buildLaunchCommand(
            { ok: true, indexPath: '/global/dist/index.js' },
            { hasNpx: () => true, runningIndexPath: '/opt/pkg/dist/index.js', execPath: '/usr/bin/node' },
        );

        expect(result.args).toEqual(['/global/dist/index.js']);
        expect(result.source).toBe('global');
    });

    it('prefers npx over the running copy when both are available', () => {
        const result = buildLaunchCommand(
            { ok: false, reason: 'install failed' },
            { hasNpx: () => true, runningIndexPath: '/opt/pkg/dist/index.js' },
        );

        expect(result.source).toBe('npx');
    });
});

// ---------------------------------------------------------------------------
// resolveRunningIndexPath
// ---------------------------------------------------------------------------
describe('resolveRunningIndexPath', () => {
    it('points at index.js next to the given module', () => {
        // File URLs are platform-shaped: Windows needs a drive letter, POSIX
        // does not, and fileURLToPath rejects the other platform's form.
        const moduleUrl = process.platform === 'win32'
            ? 'file:///C:/opt/pkg/dist/setup.js'
            : 'file:///opt/pkg/dist/setup.js';
        const result = resolveRunningIndexPath(moduleUrl);
        expect(result.split(path.sep).join('/')).toMatch(/\/opt\/pkg\/dist\/index\.js$/);
    });

    it('returns null instead of throwing when the URL cannot be resolved', () => {
        expect(resolveRunningIndexPath('not-a-file-url')).toBeNull();
    });

    it('resolves its own module by default', () => {
        expect(resolveRunningIndexPath()).toMatch(/index\.js$/);
    });
});
