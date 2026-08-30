// Package-tarball guard (issues #74 and #56).
//
// #74: the five pre-consolidation Gmail forks at
// dist/tools/{drafts,labels,messages,settings,threads}.js were deleted because
// they are dead code (`dist/tools/index.js` imports Gmail tools only via
// explicit `./gmail/*.js` paths). package.json's `files: ["dist"]` ships the
// entire dist/ tree verbatim, so the only way to be sure they never come back
// into the published package is to check the actual tarball manifest, not just
// the working tree.
//
// #56: nothing but package metadata and runtime JavaScript may be published,
// and no *.test.js may ship under dist/.
//
// Both guards read one manifest produced by a single `npm pack --dry-run`, so
// any future package-contents guard belongs in this file rather than a second
// one that would pay for another pack.
import { describe, it, expect, beforeAll } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const DEAD_GMAIL_FORKS = [
    'dist/tools/drafts.js',
    'dist/tools/labels.js',
    'dist/tools/messages.js',
    'dist/tools/settings.js',
    'dist/tools/threads.js',
];

describe('npm package tarball contents', () => {
    let files;

    // Packing runs npm against an isolated, empty cache, so package-manager
    // startup alone can exceed Jest's 5s default whenever the rest of the suite
    // is loading the machine. Measured at roughly one failure in three without
    // an explicit timeout; do not remove it.
    beforeAll(async () => {
        const cache = await mkdtemp(join(tmpdir(), 'google-tools-mcp-npm-cache-'));
        try {
            // Prefer the npm entrypoint Jest was launched from, so no shell is
            // needed to resolve `npm` to `npm.cmd`/`npm.ps1` on Windows.
            const npmEntrypoint = process.env.npm_execpath;
            const command = npmEntrypoint ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
            const args = npmEntrypoint
                ? [npmEntrypoint, 'pack', '--dry-run', '--json', '--ignore-scripts']
                : ['pack', '--dry-run', '--json', '--ignore-scripts'];
            const result = spawnSync(command, args, {
                cwd: repoRoot,
                encoding: 'utf8',
                shell: !npmEntrypoint && process.platform === 'win32',
                windowsHide: true,
                env: { ...process.env, npm_config_cache: cache },
            });
            expect(result.status).toBe(0);
            const [manifest] = JSON.parse(result.stdout);
            files = manifest.files.map(({ path }) => path);
        }
        finally {
            await rm(cache, { recursive: true, force: true });
        }
    }, 120_000);

    it('does not contain the deleted pre-consolidation Gmail tool forks', () => {
        for (const deadPath of DEAD_GMAIL_FORKS) {
            expect(files).not.toContain(deadPath);
        }
    });

    it('still contains the live Gmail tool modules', () => {
        expect(files).toContain('dist/tools/gmail/drafts.js');
        expect(files).toContain('dist/tools/gmail/labels.js');
        expect(files).toContain('dist/tools/gmail/messages.js');
        expect(files).toContain('dist/tools/gmail/settings.js');
        expect(files).toContain('dist/tools/gmail/threads.js');
    });

    it('still contains the entry point referenced by package.json bin/start', () => {
        expect(files).toContain('dist/index.js');
    });

    it('contains only package metadata and runtime JavaScript', () => {
        expect(files).toEqual(expect.arrayContaining(['package.json', 'README.md', 'LICENSE']));
        for (const packedPath of files) {
            expect(packedPath).toMatch(/^(?:package\.json|README\.md|LICENSE|dist\/.+\.js)$/);
            expect(packedPath).not.toMatch(/^dist\/.*\.test\.js$/);
        }
    });
});
