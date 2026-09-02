// Tests for dist/updateCheck.js — the update-nudge logic that replaces the
// auto-update behavior lost when setup.js switched MCP clients from `npx`
// (which always re-resolves to the latest published version) to a fixed
// global-install path (which never refreshes on its own). See the comment
// block at the top of dist/updateCheck.js for the full story.
//
// Every filesystem/network dependency is injected with fakes, matching
// tests/setupFastLaunch.test.js — no real npm, disk, or network access.
import { describe, it, expect, jest } from '@jest/globals';
import path from 'path';
import {
    stateFilePath,
    compareVersions,
    isNewerVersion,
    shouldCheckNow,
    fetchLatestVersion,
    checkForUpdate,
    isUpdateCheckDisabled,
} from '../dist/updateCheck.js';

// ---------------------------------------------------------------------------
// stateFilePath
// ---------------------------------------------------------------------------
describe('stateFilePath', () => {
    it('joins the config dir with the cache file name', () => {
        expect(stateFilePath('/home/user/.config/google-tools-mcp'))
            .toBe(path.join('/home/user/.config/google-tools-mcp', 'update-check.json'));
    });
});

// ---------------------------------------------------------------------------
// compareVersions / isNewerVersion
// ---------------------------------------------------------------------------
describe('compareVersions', () => {
    it('returns 0 for equal versions', () => {
        expect(compareVersions('1.2.12', '1.2.12')).toBe(0);
    });

    it('detects a newer patch version', () => {
        expect(compareVersions('1.2.13', '1.2.12')).toBe(1);
        expect(compareVersions('1.2.12', '1.2.13')).toBe(-1);
    });

    it('detects a newer minor/major version even with a smaller patch', () => {
        expect(compareVersions('1.3.0', '1.2.99')).toBe(1);
        expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    });

    it('ignores pre-release/build suffixes', () => {
        expect(compareVersions('1.2.12-beta.1', '1.2.12')).toBe(0);
        expect(compareVersions('1.2.12+build5', '1.2.12')).toBe(0);
    });

    it('treats missing/unparseable segments as 0 instead of throwing', () => {
        expect(() => compareVersions('garbage', '1.0.0')).not.toThrow();
        expect(compareVersions('1', '1.0.0')).toBe(0);
    });
});

describe('isNewerVersion', () => {
    it('is true when the candidate is strictly newer', () => {
        expect(isNewerVersion('1.2.12', '1.2.13')).toBe(true);
    });

    it('is false when equal or older', () => {
        expect(isNewerVersion('1.2.12', '1.2.12')).toBe(false);
        expect(isNewerVersion('1.2.12', '1.2.11')).toBe(false);
    });

    it('is false for a null/undefined/empty candidate rather than throwing', () => {
        expect(isNewerVersion('1.2.12', null)).toBe(false);
        expect(isNewerVersion('1.2.12', undefined)).toBe(false);
        expect(isNewerVersion('1.2.12', '')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// shouldCheckNow
// ---------------------------------------------------------------------------
describe('shouldCheckNow', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('says yes when there is no prior check', () => {
        expect(shouldCheckNow(null, Date.now(), DAY)).toBe(true);
        expect(shouldCheckNow(undefined, Date.now(), DAY)).toBe(true);
    });

    it('says no when the interval has not elapsed', () => {
        const now = Date.parse('2026-07-24T12:00:00.000Z');
        const lastCheckedAt = new Date(now - DAY / 2).toISOString();
        expect(shouldCheckNow(lastCheckedAt, now, DAY)).toBe(false);
    });

    it('says yes once the interval has elapsed', () => {
        const now = Date.parse('2026-07-24T12:00:00.000Z');
        const lastCheckedAt = new Date(now - DAY - 1).toISOString();
        expect(shouldCheckNow(lastCheckedAt, now, DAY)).toBe(true);
    });

    it('says yes for an unparseable timestamp instead of throwing', () => {
        expect(shouldCheckNow('not-a-date', Date.now(), DAY)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// fetchLatestVersion
// ---------------------------------------------------------------------------
describe('fetchLatestVersion', () => {
    it('returns the version from a successful registry response', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ version: '1.2.13' }),
        });
        const result = await fetchLatestVersion({ fetchImpl });
        expect(result).toBe('1.2.13');
        expect(fetchImpl).toHaveBeenCalledWith(
            'https://registry.npmjs.org/google-tools-mcp/latest',
            expect.objectContaining({ signal: expect.anything() }),
        );
    });

    it('returns null on a non-2xx response instead of throwing', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
        expect(await fetchLatestVersion({ fetchImpl })).toBeNull();
    });

    it('returns null when the network call rejects (offline/timeout)', async () => {
        const fetchImpl = jest.fn().mockRejectedValue(new Error('network down'));
        expect(await fetchLatestVersion({ fetchImpl })).toBeNull();
    });

    it('returns null when the body has no usable version field', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
        expect(await fetchLatestVersion({ fetchImpl })).toBeNull();
    });

    it('returns null when parsing the JSON body throws', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => { throw new Error('bad json'); },
        });
        expect(await fetchLatestVersion({ fetchImpl })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// checkForUpdate
// ---------------------------------------------------------------------------
describe('checkForUpdate', () => {
    const configDir = '/home/user/.config/google-tools-mcp';
    // Every case in this describe block is exercising the "not opted out"
    // path, so each passes an explicit empty env rather than relying on
    // `process.env`. The real environment (e.g. a CI runner, which sets
    // CI=true) must never change what these assertions expect. The opt-out
    // paths themselves are covered in the "update check opt-out" block below.
    const env = {};

    it('checks the network and reports updateAvailable when behind, on a cold cache', async () => {
        const readFile = jest.fn().mockRejectedValue(new Error('ENOENT'));
        const writeFile = jest.fn().mockResolvedValue(undefined);
        const mkdir = jest.fn().mockResolvedValue(undefined);
        const fetchLatest = jest.fn().mockResolvedValue('1.2.13');

        const result = await checkForUpdate({
            currentVersion: '1.2.12',
            configDir,
            now: Date.parse('2026-07-24T00:00:00.000Z'),
            fetchLatest,
            readFile,
            writeFile,
            mkdir,
            env,
        });

        expect(fetchLatest).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ checked: true, latestVersion: '1.2.13', updateAvailable: true });
        expect(mkdir).toHaveBeenCalledWith(configDir, { recursive: true });
        expect(writeFile).toHaveBeenCalledWith(
            stateFilePath(configDir),
            JSON.stringify({ lastCheckedAt: new Date(Date.parse('2026-07-24T00:00:00.000Z')).toISOString(), latestVersion: '1.2.13' }),
        );
    });

    it('reports updateAvailable: false when already current', async () => {
        const readFile = jest.fn().mockRejectedValue(new Error('ENOENT'));
        const fetchLatest = jest.fn().mockResolvedValue('1.2.12');

        const result = await checkForUpdate({
            currentVersion: '1.2.12',
            configDir,
            fetchLatest,
            readFile,
            writeFile: jest.fn(),
            mkdir: jest.fn(),
            env,
        });

        expect(result).toEqual({ checked: true, latestVersion: '1.2.12', updateAvailable: false });
    });

    it('skips the network call entirely when the cache is still fresh', async () => {
        const now = Date.parse('2026-07-24T12:00:00.000Z');
        const cached = { lastCheckedAt: new Date(now - 1000).toISOString(), latestVersion: '1.2.13' };
        const readFile = jest.fn().mockResolvedValue(JSON.stringify(cached));
        const fetchLatest = jest.fn();

        const result = await checkForUpdate({
            currentVersion: '1.2.12',
            configDir,
            now,
            fetchLatest,
            readFile,
            writeFile: jest.fn(),
            mkdir: jest.fn(),
            env,
        });

        expect(fetchLatest).not.toHaveBeenCalled();
        expect(result).toEqual({ checked: false, latestVersion: '1.2.13', updateAvailable: true });
    });

    it('re-checks once the cached entry is stale', async () => {
        const DAY = 24 * 60 * 60 * 1000;
        const now = Date.parse('2026-07-24T12:00:00.000Z');
        const cached = { lastCheckedAt: new Date(now - DAY - 1).toISOString(), latestVersion: '1.2.12' };
        const readFile = jest.fn().mockResolvedValue(JSON.stringify(cached));
        const fetchLatest = jest.fn().mockResolvedValue('1.2.14');

        const result = await checkForUpdate({
            currentVersion: '1.2.12',
            configDir,
            now,
            fetchLatest,
            readFile,
            writeFile: jest.fn(),
            mkdir: jest.fn(),
            env,
        });

        expect(fetchLatest).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ checked: true, latestVersion: '1.2.14', updateAvailable: true });
    });

    it('treats a corrupt cache file as a cold cache instead of throwing', async () => {
        const readFile = jest.fn().mockResolvedValue('{ not: valid json');
        const fetchLatest = jest.fn().mockResolvedValue('1.2.13');

        const result = await checkForUpdate({
            currentVersion: '1.2.12',
            configDir,
            fetchLatest,
            readFile,
            writeFile: jest.fn(),
            mkdir: jest.fn(),
            env,
        });

        expect(fetchLatest).toHaveBeenCalledTimes(1);
        expect(result.checked).toBe(true);
    });

    it('never throws and reports the safe default when the registry is unreachable', async () => {
        const readFile = jest.fn().mockRejectedValue(new Error('ENOENT'));
        const fetchLatest = jest.fn().mockResolvedValue(null); // fetchLatestVersion's own contract on failure

        const result = await checkForUpdate({
            currentVersion: '1.2.12',
            configDir,
            fetchLatest,
            readFile,
            writeFile: jest.fn(),
            mkdir: jest.fn(),
            env,
        });

        expect(result).toEqual({ checked: true, latestVersion: null, updateAvailable: false });
    });

    it('never throws even when persisting the cache fails (e.g. read-only config dir)', async () => {
        const readFile = jest.fn().mockRejectedValue(new Error('ENOENT'));
        const mkdir = jest.fn().mockRejectedValue(new Error('EACCES'));
        const writeFile = jest.fn();
        const fetchLatest = jest.fn().mockResolvedValue('1.2.13');

        await expect(checkForUpdate({
            currentVersion: '1.2.12',
            configDir,
            fetchLatest,
            readFile,
            writeFile,
            mkdir,
            env,
        })).resolves.toEqual({ checked: true, latestVersion: '1.2.13', updateAvailable: true });
        expect(writeFile).not.toHaveBeenCalled();
    });

    it('never throws even when fetchLatest itself unexpectedly rejects', async () => {
        const readFile = jest.fn().mockRejectedValue(new Error('ENOENT'));
        const fetchLatest = jest.fn().mockRejectedValue(new Error('should not happen'));

        await expect(checkForUpdate({
            currentVersion: '1.2.12',
            configDir,
            fetchLatest,
            readFile,
            writeFile: jest.fn(),
            mkdir: jest.fn(),
            env,
        })).resolves.toEqual({ checked: false, latestVersion: null, updateAvailable: false });
    });
});

// ---------------------------------------------------------------------------
// isUpdateCheckDisabled / checkForUpdate opt-out
// ---------------------------------------------------------------------------
// Every opt-out path must be honored before any disk read or network call,
// so each case below asserts that `readFile` (and therefore `fetchLatest`,
// which can only run after a cache read) is never invoked when opted out.
describe('update check opt-out', () => {
    const configDir = '/home/user/.config/google-tools-mcp';

    describe('isUpdateCheckDisabled', () => {
        it('is false for a clean env', () => {
            expect(isUpdateCheckDisabled({})).toBe(false);
        });

        it('is true when NO_UPDATE_NOTIFIER is set, regardless of its value', () => {
            expect(isUpdateCheckDisabled({ NO_UPDATE_NOTIFIER: '' })).toBe(true);
            expect(isUpdateCheckDisabled({ NO_UPDATE_NOTIFIER: '1' })).toBe(true);
            expect(isUpdateCheckDisabled({ NO_UPDATE_NOTIFIER: 'false' })).toBe(true);
        });

        it('is true when GOOGLE_MCP_NO_UPDATE_CHECK is set, regardless of its value', () => {
            expect(isUpdateCheckDisabled({ GOOGLE_MCP_NO_UPDATE_CHECK: '' })).toBe(true);
            expect(isUpdateCheckDisabled({ GOOGLE_MCP_NO_UPDATE_CHECK: '1' })).toBe(true);
        });

        it('is true when CI is truthy', () => {
            expect(isUpdateCheckDisabled({ CI: 'true' })).toBe(true);
            expect(isUpdateCheckDisabled({ CI: '1' })).toBe(true);
        });

        it('is false when CI is explicitly "false"', () => {
            expect(isUpdateCheckDisabled({ CI: 'false' })).toBe(false);
        });

        it('is false when CI is unset or empty', () => {
            expect(isUpdateCheckDisabled({})).toBe(false);
            expect(isUpdateCheckDisabled({ CI: '' })).toBe(false);
        });

        it('defaults to process.env when no env is given, without throwing', () => {
            expect(() => isUpdateCheckDisabled()).not.toThrow();
        });
    });

    describe('checkForUpdate', () => {
        it('skips entirely when NO_UPDATE_NOTIFIER is set, before touching disk or network', async () => {
            const readFile = jest.fn();
            const writeFile = jest.fn();
            const mkdir = jest.fn();
            const fetchLatest = jest.fn();

            const result = await checkForUpdate({
                currentVersion: '1.2.12',
                configDir,
                fetchLatest,
                readFile,
                writeFile,
                mkdir,
                env: { NO_UPDATE_NOTIFIER: '1' },
            });

            expect(result).toEqual({ checked: false, latestVersion: null, updateAvailable: false, skipped: true });
            expect(readFile).not.toHaveBeenCalled();
            expect(writeFile).not.toHaveBeenCalled();
            expect(mkdir).not.toHaveBeenCalled();
            expect(fetchLatest).not.toHaveBeenCalled();
        });

        it('skips entirely when GOOGLE_MCP_NO_UPDATE_CHECK is set, before touching disk or network', async () => {
            const readFile = jest.fn();
            const fetchLatest = jest.fn();

            const result = await checkForUpdate({
                currentVersion: '1.2.12',
                configDir,
                fetchLatest,
                readFile,
                writeFile: jest.fn(),
                mkdir: jest.fn(),
                env: { GOOGLE_MCP_NO_UPDATE_CHECK: '1' },
            });

            expect(result).toEqual({ checked: false, latestVersion: null, updateAvailable: false, skipped: true });
            expect(readFile).not.toHaveBeenCalled();
            expect(fetchLatest).not.toHaveBeenCalled();
        });

        it('skips entirely when CI is set, before touching disk or network', async () => {
            const readFile = jest.fn();
            const fetchLatest = jest.fn();

            const result = await checkForUpdate({
                currentVersion: '1.2.12',
                configDir,
                fetchLatest,
                readFile,
                writeFile: jest.fn(),
                mkdir: jest.fn(),
                env: { CI: 'true' },
            });

            expect(result).toEqual({ checked: false, latestVersion: null, updateAvailable: false, skipped: true });
            expect(readFile).not.toHaveBeenCalled();
            expect(fetchLatest).not.toHaveBeenCalled();
        });

        it('still runs the check when CI is explicitly "false" and nothing else opts out', async () => {
            const readFile = jest.fn().mockRejectedValue(new Error('ENOENT'));
            const fetchLatest = jest.fn().mockResolvedValue('1.2.13');

            const result = await checkForUpdate({
                currentVersion: '1.2.12',
                configDir,
                fetchLatest,
                readFile,
                writeFile: jest.fn(),
                mkdir: jest.fn(),
                env: { CI: 'false' },
            });

            expect(fetchLatest).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ checked: true, latestVersion: '1.2.13', updateAvailable: true });
        });
    });
});

// ---------------------------------------------------------------------------
// The production call shape: dist/index.js passes only currentVersion and
// configDir. Every test above injects readFile/writeFile/mkdir, which is how
// the module shipped with NO defaults for them: readState() threw "readFile is
// not a function" (swallowed as "no cache") and writeState() threw on mkdir
// (swallowed as "best effort"), so the registry was fetched on every launch
// and update-check.json was never written. This test uses the real filesystem
// against a temp dir and the same argument shape index.js uses.
// ---------------------------------------------------------------------------
describe('checkForUpdate with the production argument shape', () => {
    it('reads and writes the on-disk cache without any injected fs functions', async () => {
        const { mkdtemp, readFile: realReadFile, rm } = await import('node:fs/promises');
        const os = await import('node:os');
        const configDir = path.join(await mkdtemp(path.join(os.tmpdir(), 'gtm-update-')), 'nested', 'config');
        const fetchLatest = jest.fn().mockResolvedValue('9.9.9');
        try {
            const first = await checkForUpdate({ currentVersion: '1.0.0', configDir, fetchLatest, env: {} });
            expect(first).toEqual({ checked: true, latestVersion: '9.9.9', updateAvailable: true });
            const persisted = JSON.parse(await realReadFile(stateFilePath(configDir), 'utf8'));
            expect(persisted.latestVersion).toBe('9.9.9');
            expect(typeof persisted.lastCheckedAt).toBe('string');

            // Second launch inside the interval: served from disk, no network.
            const second = await checkForUpdate({ currentVersion: '1.0.0', configDir, fetchLatest, env: {} });
            expect(second).toEqual({ checked: false, latestVersion: '9.9.9', updateAvailable: true });
            expect(fetchLatest).toHaveBeenCalledTimes(1);
        } finally {
            await rm(path.dirname(path.dirname(configDir)), { recursive: true, force: true });
        }
    });
});
