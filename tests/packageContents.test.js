// Package-tarball guards (issues #74 and #56). The five pre-consolidation
// Gmail forks at dist/tools/{drafts,labels,messages,settings,threads}.js were
// deleted because they are dead code (`dist/tools/index.js` imports Gmail
// tools only via explicit `./gmail/*.js` paths). package.json's
// `files: ["dist"]` ships the entire dist/ tree verbatim, so the only way
// to be sure they never come back into the published package is to check the
// actual tarball manifest, not just the working tree.
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEAD_GMAIL_FORKS = [
    'dist/tools/drafts.js',
    'dist/tools/labels.js',
    'dist/tools/messages.js',
    'dist/tools/settings.js',
    'dist/tools/threads.js',
];

describe('npm package tarball contents', () => {
    let cache;
    let packedPaths;

    beforeAll(async () => {
        cache = await mkdtemp(join(tmpdir(), 'google-tools-mcp-npm-cache-'));
        const npmEntrypoint = process.env.npm_execpath;
        const command = npmEntrypoint ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
        const args = npmEntrypoint
            ? [npmEntrypoint, 'pack', '--dry-run', '--json', '--ignore-scripts']
            : ['pack', '--dry-run', '--json', '--ignore-scripts'];
        const result = spawnSync(command, args, {
            cwd: repoRoot,
            encoding: 'utf8',
            shell: !npmEntrypoint && process.platform === 'win32',
            env: { ...process.env, npm_config_cache: cache },
        });
        expect(result.status).toBe(0);
        const [{ files }] = JSON.parse(result.stdout);
        packedPaths = files.map(({ path }) => path);
    }, 60000);

    afterAll(async () => {
        if (cache) await rm(cache, { recursive: true, force: true });
    });

    it('does not contain the deleted pre-consolidation Gmail tool forks', () => {
        for (const deadPath of DEAD_GMAIL_FORKS) {
            expect(packedPaths).not.toContain(deadPath);
        }
    });

    it('still contains the live Gmail tool modules', () => {
        expect(packedPaths).toContain('dist/tools/gmail/drafts.js');
        expect(packedPaths).toContain('dist/tools/gmail/labels.js');
        expect(packedPaths).toContain('dist/tools/gmail/messages.js');
        expect(packedPaths).toContain('dist/tools/gmail/settings.js');
        expect(packedPaths).toContain('dist/tools/gmail/threads.js');
    });

    it('still contains the entry point referenced by package.json bin/start', () => {
        expect(packedPaths).toContain('dist/index.js');
    });

    it('contains only package metadata and runtime JavaScript', () => {
        expect(packedPaths).toEqual(expect.arrayContaining(['package.json', 'README.md', 'LICENSE']));
        for (const packedPath of packedPaths) {
            expect(packedPath).toMatch(/^(?:package\.json|README\.md|LICENSE|dist\/.+\.js)$/);
            expect(packedPath).not.toMatch(/^dist\/.*\.test\.js$/);
        }
    });
});
