// Package-tarball guards. package.json's `files` entry ships the dist/ tree
// verbatim, so the only way to be sure about what gets published is to read
// the actual tarball manifest rather than the working tree.
//
// Issue #74: the five pre-consolidation Gmail forks at
// dist/tools/{drafts,labels,messages,settings,threads}.js were deleted because
// they are dead code (`dist/tools/index.js` imports Gmail tools only via
// explicit `./gmail/*.js` paths); they must not come back into the package.
//
// Issue #56: nothing but package metadata and runtime JavaScript may ship, and
// in particular no *.test.js under dist/.
//
// This file is the home for any future package-contents guard -- add an it()
// here against the shared manifest below rather than opening a second
// package-contents test file and paying for a second `npm pack` run.
import { describe, it, expect, beforeAll } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

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

    beforeAll(async () => {
        // Pack once for every guard in this file.
        //
        // When the suite runs under an npm script, npm_execpath points at the
        // invoking npm's own CLI entrypoint, so it can be run through
        // process.execPath with no shell at all. Only when that is missing do
        // we fall back to letting the platform's shell resolve `npm` to
        // `npm.cmd`/`npm.ps1` on Windows (Node flags a manual args-array +
        // shell:true combination as unsafe generically, even though these args
        // are fixed literals, not user input).
        //
        // --ignore-scripts keeps a future prepare/prepack hook from rebuilding
        // mid-test, and a throwaway npm_config_cache keeps the run from
        // touching the developer's real npm cache.
        const cache = await mkdtemp(join(tmpdir(), 'google-tools-mcp-npm-cache-'));
        try {
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
        } finally {
            await rm(cache, { recursive: true, force: true });
        }
    }, 60000);

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
