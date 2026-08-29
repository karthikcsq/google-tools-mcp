import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';
import { createV2HttpHandler, MCP_PROTOCOL_VERSION, prepareMcpServerFactory } from '../dist/mcpServer.js';
import { getArgumentShape, getLogFilePath, getStructuredLogFilePath, logToolCall, logger, readRecentToolCalls, resetLoggerForTests, resolveLogDirectoryAction, setLogRotationThresholdForTests, setRotationLockTimingForTests, withRotationLock } from '../dist/logger.js';
import { publicError, registerSecret } from '../dist/errors.js';

const LOGGER_MODULE_URL = pathToFileURL(fileURLToPath(new URL('../dist/logger.js', import.meta.url))).href;

jest.setTimeout(30_000);

const originalEnv = { ...process.env };
afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    resetLoggerForTests();
    setLogRotationThresholdForTests();
    setRotationLockTimingForTests();
});

function request(name, args) {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer diagnostic-test-token', 'content-type': 'application/json', 'mcp-protocol-version': MCP_PROTOCOL_VERSION, 'mcp-method': 'tools/call', 'mcp-name': name },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
    });
}

describe('structured diagnostics', () => {
    it('keeps caller-supplied public-error text out of JSONL while retaining the classified failure', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-jsonl-'));
        process.env.GOOGLE_MCP_LOG_FILE = join(directory, 'server.log');
        process.env.GOOGLE_MCP_JSONL_FILE = join(directory, 'server.jsonl');
        const secret = 'diagnostic-secret-value-0123456789';
        const release = registerSecret(secret);
        const factory = await prepareMcpServerFactory({ registerTools: async (server) => {
            server.addTool({ name: 'ok', parameters: z.object({ body: z.string() }), execute: async () => 'ok' });
            server.addTool({ name: 'user', parameters: z.object({}), execute: async () => { throw publicError(`fix requested text=diagnostic-caller-content-7f8e9d`); } });
            server.addTool({ name: 'broken', parameters: z.object({}), execute: async () => { throw new Error(`private ${secret}`); } });
        } });
        const handler = createV2HttpHandler(factory, { auth: { token: 'diagnostic-test-token' } });
        try {
            await handler.fetch(request('ok', { body: `content ${secret}` }));
            await handler.fetch(request('user', {}));
            await handler.fetch(request('broken', {}));
            const records = (await readFile(join(directory, 'server.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
            expect(records).toHaveLength(3);
            expect(records.map((record) => record.outcome)).toEqual(['ok', 'user_error', 'error']);
            expect(records.map((record) => record.reqId)).toEqual([...records.map((record) => record.reqId)].sort((a, b) => a - b));
            expect(records[0].argShape).toEqual({ body: `string:${Buffer.byteLength(`content ${secret}`, 'utf8')}` });
            expect(JSON.stringify(records)).not.toContain(secret);
            expect(JSON.stringify(records)).not.toContain('diagnostic-caller-content-7f8e9d');
            expect(records[1]).toMatchObject({ tool: 'user', outcome: 'user_error', errCode: 'USER_ERROR', errMsg: 'caller-visible error' });
            expect(new Set(Object.keys(records[0]))).toEqual(new Set(['ts', 'event', 'tool', 'reqId', 'durationMs', 'outcome', 'errCode', 'errMsg', 'argShape']));
        } finally { release(); await handler.close(); await rm(directory, { recursive: true, force: true }); }
    });

    it('rotates an oversized JSONL file at open and replaces stale retention', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-rotation-'));
        const jsonlPath = join(directory, 'server.jsonl');
        process.env.GOOGLE_MCP_LOG_FILE = join(directory, 'server.log');
        process.env.GOOGLE_MCP_JSONL_FILE = jsonlPath;
        await writeFile(jsonlPath, 'x'.repeat(5 * 1024 * 1024 + 1));
        await writeFile(`${jsonlPath}.1`, 'stale');
        logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'ok', reqId: 1, durationMs: 0, outcome: 'ok', errCode: null, errMsg: null, argShape: getArgumentShape({}) });
        expect((await stat(`${jsonlPath}.1`)).size).toBeGreaterThan(5 * 1024 * 1024);
        expect(await readFile(jsonlPath, 'utf8')).toContain('"tool":"ok"');
        await rm(directory, { recursive: true, force: true });
    });

    it('keeps the documented JSONL field set synchronized with emitted records', async () => {
        const runbook = await readFile('docs/troubleshooting-runbook.md', 'utf8');
        for (const field of ['ts', 'event', 'tool', 'reqId', 'durationMs', 'outcome', 'errCode', 'errMsg', 'argShape']) expect(runbook).toContain(`\`${field}\``);
        expect(getStructuredLogFilePath()).toBeTruthy();
    });

    it('rotates both long-lived plain and JSONL logs during runtime', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-runtime-rotation-'));
        const plainPath = join(directory, 'server.log');
        const jsonlPath = join(directory, 'server.jsonl');
        process.env.GOOGLE_MCP_LOG_FILE = plainPath;
        process.env.GOOGLE_MCP_JSONL_FILE = jsonlPath;
        const payload = 'x'.repeat(1_000);
        setLogRotationThresholdForTests(4_096);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        logger.info('seed');
        for (let i = 0; i < 10; i += 1) {
            logger.info(payload);
            logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'first', reqId: i, durationMs: 0, outcome: 'ok', errCode: null, errMsg: null, argShape: { x: payload } });
        }
        logger.info('after-rotation');
        logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'after', reqId: 2, durationMs: 0, outcome: 'ok', errCode: null, errMsg: null, argShape: {} });
        expect((await stat(`${plainPath}.1`)).size).toBeGreaterThan(0);
        expect((await stat(`${jsonlPath}.1`)).size).toBeGreaterThan(0);
        expect(await readFile(plainPath, 'utf8')).toContain('after-rotation');
        expect(await readFile(jsonlPath, 'utf8')).toContain('"tool":"after"');
        errorSpy.mockRestore();
        await rm(directory, { recursive: true, force: true });
    });

    it('creates diagnostic directories and files private by default', async () => {
        const root = await mkdtemp(join(tmpdir(), 'google-tools-mcp-private-'));
        const directory = join(root, 'diagnostics');
        const plainPath = join(directory, 'server.log');
        const jsonlPath = join(directory, 'server.jsonl');
        process.env.GOOGLE_MCP_LOG_FILE = plainPath;
        process.env.GOOGLE_MCP_JSONL_FILE = jsonlPath;
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            logger.info('create private plain log');
            logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'private', reqId: 1, durationMs: 0, outcome: 'ok', errCode: null, errMsg: null, argShape: {} });
            if (process.platform !== 'win32') {
                expect((await stat(directory)).mode & 0o777).toBe(0o700);
                expect((await stat(plainPath)).mode & 0o777).toBe(0o600);
                expect((await stat(jsonlPath)).mode & 0o777).toBe(0o600);
            }
        } finally { errorSpy.mockRestore(); await rm(root, { recursive: true, force: true }); }
    });

    it('leaves an existing custom log parent directory at its original mode', async () => {
        const root = await mkdtemp(join(tmpdir(), 'google-tools-mcp-shared-parent-'));
        // A directory the operator created and deliberately shares/traverses.
        const shared = join(root, 'shared-logs');
        await mkdir(shared, { recursive: true, mode: 0o755 });
        await chmod(shared, 0o755);
        const before = (await stat(shared)).mode & 0o777;
        const plainPath = join(shared, 'server.log');
        const jsonlPath = join(shared, 'records.jsonl');
        process.env.GOOGLE_MCP_LOG_FILE = plainPath;
        process.env.GOOGLE_MCP_JSONL_FILE = jsonlPath;
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            logger.info('write into a shared parent');
            logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'shared', reqId: 1, durationMs: 0, outcome: 'ok', errCode: null, errMsg: null, argShape: {} });
            expect(await readFile(plainPath, 'utf8')).toContain('write into a shared parent');
            expect(await readFile(jsonlPath, 'utf8')).toContain('"tool":"shared"');
            expect((await stat(shared)).mode & 0o777).toBe(before);
            if (process.platform !== 'win32') {
                expect(before).toBe(0o755);
                // Privacy for a custom location comes from the file mode, not
                // from re-permissioning somebody else's directory.
                expect((await stat(plainPath)).mode & 0o777).toBe(0o600);
                expect((await stat(jsonlPath)).mode & 0o777).toBe(0o600);
            }
        } finally { errorSpy.mockRestore(); await rm(root, { recursive: true, force: true }); }
    });

    it('only sets a directory mode for a directory it creates or already owns', () => {
        // Platform-independent statement of the rule: a Windows chmod is close
        // enough to a no-op that comparing modes there proves nothing.
        const configDir = join(tmpdir(), 'google-tools-mcp-config');
        const present = new Set([configDir, tmpdir(), join(tmpdir(), 'shared-logs')]);
        const exists = (target) => present.has(target);
        expect(resolveLogDirectoryAction(configDir, { exists, configDir })).toBe('chmod');
        expect(resolveLogDirectoryAction(tmpdir(), { exists, configDir })).toBe('leave');
        expect(resolveLogDirectoryAction(join(tmpdir(), 'shared-logs'), { exists, configDir })).toBe('leave');
        expect(resolveLogDirectoryAction(join(tmpdir(), 'brand-new'), { exists, configDir })).toBe('create');
    });

    it('logs into a system-style shared parent it has no permission to chmod', async () => {
        // The GOOGLE_MCP_LOG_FILE=/tmp/google-tools-mcp.log case. On Linux the
        // temp directory is root-owned with the sticky bit, so any chmod attempt
        // is EPERM; the logger must never need one to start writing.
        const shared = tmpdir();
        const before = (await stat(shared)).mode & 0o777;
        const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
        const plainPath = join(shared, `google-tools-mcp-system-parent-${suffix}.log`);
        process.env.GOOGLE_MCP_LOG_FILE = plainPath;
        process.env.GOOGLE_MCP_JSONL_FILE = '0';
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            logger.info('system parent line');
            expect(stderrSpy.mock.calls.map(([value]) => String(value)).join('')).not.toContain('Unable to write diagnostic log file');
            expect(await readFile(plainPath, 'utf8')).toContain('system parent line');
            expect((await stat(shared)).mode & 0o777).toBe(before);
        } finally {
            stderrSpy.mockRestore(); errorSpy.mockRestore();
            await rm(plainPath, { force: true });
            await rm(`${plainPath}.1`, { force: true });
        }
    });

    it('keeps an explicit JSONL path live when the plain log is disabled', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-jsonl-only-'));
        const jsonlPath = join(directory, 'server.jsonl');
        process.env.GOOGLE_MCP_LOG_FILE = '0';
        process.env.GOOGLE_MCP_JSONL_FILE = jsonlPath;
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(getLogFilePath()).toBeNull();
            expect(getStructuredLogFilePath()).toBe(jsonlPath);
            logger.info('this plain line has no file sink');
            logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'jsonl-only', reqId: 1, durationMs: 0, outcome: 'ok', errCode: null, errMsg: null, argShape: {} });
            expect(await readFile(jsonlPath, 'utf8')).toContain('"tool":"jsonl-only"');
            expect(readRecentToolCalls().records.map(({ tool }) => tool)).toEqual(['jsonl-only']);
            // Nothing else was written into the directory: the plain sink is off.
            expect(await readdir(directory)).toEqual(['server.jsonl']);
        } finally { errorSpy.mockRestore(); await rm(directory, { recursive: true, force: true }); }
    });

    it('still lets GOOGLE_MCP_JSONL_FILE alone disable structured logging', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-jsonl-off-'));
        process.env.GOOGLE_MCP_LOG_FILE = join(directory, 'server.log');
        process.env.GOOGLE_MCP_JSONL_FILE = 'off';
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(getStructuredLogFilePath()).toBeNull();
            logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'never', reqId: 1, durationMs: 0, outcome: 'ok', errCode: null, errMsg: null, argShape: {} });
            logger.info('plain still works');
            expect(await readdir(directory)).toEqual(['server.log']);
            expect(readRecentToolCalls()).toEqual({ filePath: null, records: [] });
        } finally { errorSpy.mockRestore(); await rm(directory, { recursive: true, force: true }); }
    });

    // Finding 15: an existing symlink at a configured log path used to be
    // followed by statSync/openSync/chmodSync, so a custom log location
    // pointed at a symlink could rotate-check, chmod, and append diagnostic
    // content into whatever the symlink targeted instead of a log file this
    // process owns.
    it('refuses to follow a symlinked log path instead of writing through it', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-symlink-'));
        const sentinelPlain = join(directory, 'sentinel-plain.txt');
        const sentinelJsonl = join(directory, 'sentinel-jsonl.txt');
        await writeFile(sentinelPlain, 'do-not-touch-plain');
        await writeFile(sentinelJsonl, 'do-not-touch-jsonl');
        const beforeMode = process.platform !== 'win32' ? (await stat(sentinelPlain)).mode & 0o777 : null;
        const plainPath = join(directory, 'server.log');
        const jsonlPath = join(directory, 'server.jsonl');
        await symlink(sentinelPlain, plainPath);
        await symlink(sentinelJsonl, jsonlPath);
        process.env.GOOGLE_MCP_LOG_FILE = plainPath;
        process.env.GOOGLE_MCP_JSONL_FILE = jsonlPath;
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            logger.info('should never reach the symlink target');
            logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'symlinked', reqId: 1, durationMs: 0, outcome: 'ok', errCode: null, errMsg: null, argShape: {} });
            expect(await readFile(sentinelPlain, 'utf8')).toBe('do-not-touch-plain');
            expect(await readFile(sentinelJsonl, 'utf8')).toBe('do-not-touch-jsonl');
            if (process.platform !== 'win32') {
                expect((await stat(sentinelPlain)).mode & 0o777).toBe(beforeMode);
                expect((await stat(sentinelJsonl)).mode & 0o777).toBe(beforeMode);
            }
            const warnings = stderrSpy.mock.calls.map(([value]) => String(value)).join('');
            expect(warnings).toContain(`Unable to write diagnostic log file ${plainPath}`);
            expect(warnings).toContain(`Unable to write diagnostic log file ${jsonlPath}`);
        } finally {
            stderrSpy.mockRestore(); errorSpy.mockRestore();
            await rm(directory, { recursive: true, force: true });
        }
    });

    // Finding 16: rotateNow() leaves nothing at the JSONL path, so the
    // appendFileSync that used to follow it directly created the replacement
    // file through Node's default create-mode (the process umask) instead of
    // the 0600 openPrivateLogFile() establishes at startup -- the private-
    // mode guarantee silently disappeared after the first in-process
    // rotation.
    it('keeps the structured JSONL file private after in-process rotation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-jsonl-rotate-mode-'));
        const jsonlPath = join(directory, 'server.jsonl');
        process.env.GOOGLE_MCP_LOG_FILE = '0';
        process.env.GOOGLE_MCP_JSONL_FILE = jsonlPath;
        setLogRotationThresholdForTests(10);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'first', reqId: 1, durationMs: 0, outcome: 'ok', errCode: null, errMsg: null, argShape: { pad: 'x'.repeat(80) } });
            logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'second', reqId: 2, durationMs: 0, outcome: 'ok', errCode: null, errMsg: null, argShape: {} });
            expect(await readFile(`${jsonlPath}.1`, 'utf8')).toContain('"tool":"first"');
            expect(await readFile(jsonlPath, 'utf8')).toContain('"tool":"second"');
            if (process.platform !== 'win32') {
                expect((await stat(jsonlPath)).mode & 0o777).toBe(0o600);
            }
        } finally { errorSpy.mockRestore(); await rm(directory, { recursive: true, force: true }); }
    });

    // Finding 19: rotation retains the previous primary as `${filePath}.1`,
    // but readRecentToolCalls() (and therefore `troubleshoot`) used to read
    // only the current primary, so a failure moved into `.1` moments earlier
    // dropped out of the recent-activity window it is supposed to cover.
    it('readRecentToolCalls folds in the retained .1 file after rotation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-jsonl-recent-'));
        const jsonlPath = join(directory, 'server.jsonl');
        process.env.GOOGLE_MCP_LOG_FILE = '0';
        process.env.GOOGLE_MCP_JSONL_FILE = jsonlPath;
        setLogRotationThresholdForTests(10);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'older-failure', reqId: 1, durationMs: 0, outcome: 'error', errCode: 'BOOM', errMsg: 'boom', argShape: {} });
            logToolCall({ ts: new Date().toISOString(), event: 'tool_call', tool: 'newer-ok', reqId: 2, durationMs: 0, outcome: 'ok', errCode: null, errMsg: null, argShape: {} });
            // Both calls rotated (the threshold is tiny): the failure landed
            // in `.1` and only the ok record remains in the fresh primary.
            expect(await readFile(`${jsonlPath}.1`, 'utf8')).toContain('older-failure');
            expect(await readFile(jsonlPath, 'utf8')).not.toContain('older-failure');
            const recent = readRecentToolCalls();
            expect(recent.filePath).toBe(jsonlPath);
            expect(recent.records.map((record) => record.tool)).toEqual(['older-failure', 'newer-ok']);
        } finally { errorSpy.mockRestore(); await rm(directory, { recursive: true, force: true }); }
    });

    // Finding 24: stdio is one process per client, and every process for a
    // profile shares the same default diagnostic paths with its own
    // independent byte counters. Rotation used to be a bare stat-then-rename
    // with no cross-process coordination, so a second process could rotate
    // (and unconditionally overwrite `.1`) moments after a first process
    // already had, discarding retained history the first rotation had only
    // just written -- even though no single write was ever individually
    // lost. withRotationLock() now serializes the actual check-and-rotate
    // step behind a short-lived, cross-process exclusive lock file. These
    // tests exercise that primitive directly and deterministically (real
    // multi-process races are inherently non-deterministic and their
    // reproducibility is volume/threshold-sensitive), then one live
    // multi-process run exercises the full integration.
    describe('cross-process rotation lock', () => {
        it('a rotation attempt against a lock already held by another process does not run and does not touch the file', async () => {
            const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-lock-held-'));
            const filePath = join(directory, 'server.jsonl');
            const lockPath = `${filePath}.rotate.lock`;
            await writeFile(filePath, 'unrotated-content');
            await writeFile(lockPath, ''); // simulates another process's fresh, live lock
            setRotationLockTimingForTests({ timeoutMs: 100, staleMs: 60_000 });
            try {
                const fn = jest.fn();
                const ran = withRotationLock(filePath, fn);
                expect(ran).toBe(false);
                expect(fn).not.toHaveBeenCalled();
                // The lock is left in place -- it belongs to whoever created
                // it, not to a caller that failed to acquire it.
                expect(await readFile(lockPath, 'utf8')).toBe('');
                expect(await readFile(filePath, 'utf8')).toBe('unrotated-content');
            } finally { await rm(directory, { recursive: true, force: true }); }
        });

        it('breaks a lock abandoned by a crashed process instead of waiting out the full timeout', async () => {
            const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-lock-stale-'));
            const filePath = join(directory, 'server.jsonl');
            const lockPath = `${filePath}.rotate.lock`;
            await writeFile(lockPath, '');
            // Back-date the lock file well past the (shortened) staleness
            // window so it reads as abandoned rather than freshly held.
            const old = new Date(Date.now() - 10_000);
            await utimes(lockPath, old, old);
            setRotationLockTimingForTests({ timeoutMs: 5_000, staleMs: 500 });
            try {
                const fn = jest.fn();
                const ran = withRotationLock(filePath, fn);
                expect(ran).toBe(true);
                expect(fn).toHaveBeenCalledTimes(1);
                // The lock is released again once fn completes.
                await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
            } finally { await rm(directory, { recursive: true, force: true }); }
        });

        it('an uncontended lock is acquired immediately, runs fn once, and cleans itself up', async () => {
            const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-lock-free-'));
            const filePath = join(directory, 'server.jsonl');
            const lockPath = `${filePath}.rotate.lock`;
            try {
                const fn = jest.fn();
                const ran = withRotationLock(filePath, fn);
                expect(ran).toBe(true);
                expect(fn).toHaveBeenCalledTimes(1);
                await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
            } finally { await rm(directory, { recursive: true, force: true }); }
        });
    });

    // Live integration check: two real child processes writing and rotating
    // against the SAME JSONL file at once. The retention window (roughly
    // 2x the rotation threshold, across primary + `.1`) is sized to comfortably
    // hold this run's whole volume, so a correct implementation should be
    // able to retain every record; anything missing would mean a rotation
    // destroyed retained content out from under a concurrent peer rather than
    // the record simply aging out of a window too small to hold it.
    it('two concurrent processes rotating the same JSONL file lose no records and never crash', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'google-tools-mcp-jsonl-race-'));
        const jsonlPath = join(directory, 'server.jsonl');
        const workerPath = join(directory, 'rotation-worker.mjs');
        await writeFile(workerPath, [
            `import { setLogRotationThresholdForTests, logToolCall } from ${JSON.stringify(LOGGER_MODULE_URL)};`,
            'const [, , countArg, tag] = process.argv;',
            'const count = Number(countArg);',
            'setLogRotationThresholdForTests(Number(process.env.TEST_ROTATION_THRESHOLD));',
            'for (let i = 0; i < count; i += 1) {',
            '  logToolCall({ ts: new Date().toISOString(), event: "tool_call", tool: `${tag}-${i}`, reqId: i, durationMs: 0, outcome: "ok", errCode: null, errMsg: null, argShape: { pad: "x".repeat(10) } });',
            '}',
        ].join('\n'), 'utf8');

        const recordsPerWorker = 4;
        const runWorker = (tag) => new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [workerPath, String(recordsPerWorker), tag], {
                env: {
                    ...process.env, GOOGLE_MCP_LOG_FILE: '0', GOOGLE_MCP_JSONL_FILE: jsonlPath,
                    // ~150 bytes/record * 8 total records fits comfortably
                    // within the ~2x900-byte primary+.1 retention window.
                    TEST_ROTATION_THRESHOLD: '900', XDG_CONFIG_HOME: directory,
                },
            });
            let stderr = '';
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            child.once('error', reject);
            child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${tag} exited ${code}: ${stderr}`))));
        });

        try {
            // Launched together (not awaited sequentially) so both processes'
            // rotation decisions actually overlap in real time.
            await Promise.all([runWorker('procA'), runWorker('procB')]);

            const parseLines = async (filePath) => {
                try {
                    return (await readFile(filePath, 'utf8')).trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line));
                } catch (error) {
                    if (error?.code === 'ENOENT') return [];
                    throw error; // a thrown JSON.parse here means a corrupted/torn write
                }
            };
            const combined = [...await parseLines(`${jsonlPath}.1`), ...await parseLines(jsonlPath)];
            const seenTools = new Set(combined.map((record) => record.tool));
            const expectedTools = [
                ...Array.from({ length: recordsPerWorker }, (_, i) => `procA-${i}`),
                ...Array.from({ length: recordsPerWorker }, (_, i) => `procB-${i}`),
            ];
            for (const tool of expectedTools) expect(seenTools.has(tool)).toBe(true);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
