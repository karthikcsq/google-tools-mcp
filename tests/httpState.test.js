import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    ensureHttpToken, getHttpStatePaths, publishHttpState, readHttpState, removeHttpState,
} from '../dist/httpState.js';

async function fixture() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-http-state-'));
}

describe('shared HTTP state and token persistence', () => {
    it('generates one stable private token and reuses it across restarts', async () => {
        const configDir = await fixture();
        try {
            const first = await ensureHttpToken({ configDir, env: {} });
            const second = await ensureHttpToken({ configDir, env: {} });
            expect(first.created).toBe(true);
            expect(second.token).toBe(first.token);
            expect(second.source).toBe('file');
            expect(first.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
            expect((await fs.readFile(getHttpStatePaths(configDir).tokenPath, 'utf8')).trim()).toBe(first.token);
            if (process.platform !== 'win32') {
                expect((await fs.stat(getHttpStatePaths(configDir).tokenPath)).mode & 0o777).toBe(0o600);
            }
        } finally { await fs.rm(configDir, { recursive: true, force: true }); }
    });

    it('honors an environment override without writing or reporting the secret', async () => {
        const configDir = await fixture();
        try {
            const result = await ensureHttpToken({ configDir, env: { GOOGLE_MCP_HTTP_TOKEN: 'environment-token-that-is-long-enough' } });
            expect(result).toMatchObject({ source: 'environment', persisted: false, path: null });
            expect(result.token).toBe('environment-token-that-is-long-enough');
            await expect(fs.access(getHttpStatePaths(configDir).tokenPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally { await fs.rm(configDir, { recursive: true, force: true }); }
    });

    it('publishes validated state atomically and removes only the owning pid', async () => {
        const configDir = await fixture();
        try {
            const input = {
                pid: process.pid, port: 43123, host: '127.0.0.1', endpoint: '/mcp',
                startedAt: new Date().toISOString(), version: '2.0.0', profile: 'default',
            };
            const published = await publishHttpState(input, { configDir });
            expect(published.url).toBe('http://127.0.0.1:43123/mcp');
            await expect(readHttpState({ configDir })).resolves.toEqual(published);
            await expect(removeHttpState({ configDir, expectedPid: process.pid + 1 })).resolves.toBe(false);
            await expect(readHttpState({ configDir })).resolves.toEqual(published);
            await expect(removeHttpState({ configDir, expectedPid: process.pid })).resolves.toBe(true);
            await expect(readHttpState({ configDir })).resolves.toBeNull();
        } finally { await fs.rm(configDir, { recursive: true, force: true }); }
    });

    it('refuses symlinked token files instead of following them', async () => {
        if (process.platform === 'win32') return;
        const configDir = await fixture();
        const outside = path.join(configDir, 'outside');
        try {
            await fs.writeFile(outside, 'unchanged');
            await fs.symlink(outside, getHttpStatePaths(configDir).tokenPath);
            await expect(ensureHttpToken({ configDir, env: {} })).rejects.toThrow(/unsafe/);
            await expect(fs.readFile(outside, 'utf8')).resolves.toBe('unchanged');
        } finally { await fs.rm(configDir, { recursive: true, force: true }); }
    });
});
