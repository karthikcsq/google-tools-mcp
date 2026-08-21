import { describe, expect, it } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('published package contents', () => {
    it('contains only package metadata and runtime JavaScript', async () => {
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
                env: { ...process.env, npm_config_cache: cache },
            });
            expect(result.status).toBe(0);
            const [{ files }] = JSON.parse(result.stdout);
            const packedPaths = files.map(({ path }) => path);

            expect(packedPaths).toContain('dist/index.js');
            expect(packedPaths).toEqual(expect.arrayContaining(['package.json', 'README.md', 'LICENSE']));
            for (const packedPath of packedPaths) {
                expect(packedPath).toMatch(/^(?:package\.json|README\.md|LICENSE|dist\/.+\.js)$/);
                expect(packedPath).not.toMatch(/^dist\/.*\.test\.js$/);
            }
        } finally {
            await rm(cache, { recursive: true, force: true });
        }
    });
});
