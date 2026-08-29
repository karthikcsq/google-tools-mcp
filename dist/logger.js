// Centralized logger with LOG_LEVEL support.
// All log output goes to stderr (stdout reserved for MCP protocol).
// Plain logs and structured tool-call records are both persisted by default.
import * as fs from 'fs';
import * as path from 'path';
import { redactDiagnostic } from './errors.js';
import { getConfigDir, getDefaultLogPath, getDefaultJsonlPath } from './config.js';

const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    silent: 4,
};
function resolveLevel() {
    const env = process.env.LOG_LEVEL?.toLowerCase();
    if (env && env in LOG_LEVELS) {
        return env;
    }
    return 'info';
}
let currentLevel = null;
export function refreshLogLevel() {
    currentLevel = resolveLevel();
}
function shouldLog(level) {
    if (currentLevel === null) currentLevel = resolveLevel();
    return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

// --- File logging ---
let logStream = null;
let structuredLogPath = null;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
let rotationLimit = MAX_LOG_BYTES;
export function setLogRotationThresholdForTests(value = MAX_LOG_BYTES) { rotationLimit = value; }
const disabledValues = new Set(['0', 'false', 'off', 'none']);
let warnedPaths = new Set();
let plainBytes = 0;
let structuredBytes = 0;

function configuredPath(value, fallback) {
    if (value === undefined || value === '' || value === '1') return fallback;
    if (disabledValues.has(String(value).toLowerCase())) return null;
    return value;
}

export function getLogFilePath() {
    return configuredPath(process.env.GOOGLE_MCP_LOG_FILE, getDefaultLogPath());
}

// The two sinks are documented as independently controlled: GOOGLE_MCP_LOG_FILE
// changes or disables the plain file, GOOGLE_MCP_JSONL_FILE changes or disables
// JSONL. So an explicit JSONL path is resolved on its own and stays live even
// when the plain log is switched off. The plain log is only consulted to derive
// a default location when JSONL has no explicit path of its own.
export function getStructuredLogFilePath() {
    const configured = process.env.GOOGLE_MCP_JSONL_FILE;
    if (configured !== undefined && configured !== '' && configured !== '1') {
        return disabledValues.has(String(configured).toLowerCase()) ? null : configured;
    }
    const plainPath = getLogFilePath();
    if (!plainPath) return null;
    return process.env.GOOGLE_MCP_LOG_FILE && process.env.GOOGLE_MCP_LOG_FILE !== '1'
        ? path.join(path.dirname(plainPath), 'server.jsonl')
        : getDefaultJsonlPath();
}

function warnFileFailure(filePath) {
    if (warnedPaths.has(filePath)) return;
    warnedPaths.add(filePath);
    process.stderr.write(`WARNING: Unable to write diagnostic log file ${filePath}.\n`);
}

// fs.renameSync(oldPath, newPath) already atomically replaces an existing
// newPath on both POSIX and Windows (libuv's uv_fs_rename uses
// MOVEFILE_REPLACE_EXISTING on Windows) -- there is no need to unlink the
// previous `.1` first. A bare, unlink-free renameSync never leaves the
// destination transiently missing, and a process whose own source is already
// gone (ENOENT) just means another process rotated first, not a failure.
function rotateNow(filePath) {
    const rotatedPath = `${filePath}.1`;
    try {
        fs.renameSync(filePath, rotatedPath);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

// stdio is one process per client, and every process for a profile shares
// the same default log paths with its own independent, purely local byte
// counters. Rotation is a read-decide-mutate sequence (stat the size, then
// rename), so without cross-process coordination two processes can each
// independently decide "this needs rotating" moments apart: the second
// process's rotation then unconditionally replaces `.1` with whatever now
// sits at the primary path -- which, if the first process already rotated
// and recreated a small fresh file, discards the larger batch of retained
// history the first rotation had only just written. Neither process's own
// current record is lost by this (rotateNow()/openPrivateLogFile() always
// leave something appendable at the primary path either way), but the
// retained `.1` file can still be destroyed out from under a concurrent
// rotation (finding 24). A short-lived, cross-process exclusive lock file
// (O_EXCL create, which is atomic on every platform Node supports) serializes
// the actual check-and-rotate step so only one process performs it at a
// time; the decision is re-verified fresh under the lock, since the file may
// already have been rotated by whoever held the lock first. A process that
// cannot acquire the lock within the timeout skips rotation for this call
// rather than blocking indefinitely -- the file just grows a little past the
// limit until the next successful rotation, which is a far smaller cost than
// destroying already-retained diagnostics.
const ROTATION_LOCK_SUFFIX = '.rotate.lock';
let rotationLockTimeoutMs = 2_000;
const ROTATION_LOCK_RETRY_MS = 15;
let rotationLockStaleMs = 5_000;
/** Test-only: shrink the lock wait/staleness windows so contention tests don't take real seconds. */
export function setRotationLockTimingForTests({ timeoutMs = 2_000, staleMs = 5_000 } = {}) {
    rotationLockTimeoutMs = timeoutMs;
    rotationLockStaleMs = staleMs;
}

function syncSleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn` while holding an exclusive, cross-process lock for `filePath`'s rotation. Returns whether `fn` ran. */
export function withRotationLock(filePath, fn) {
    const lockPath = `${filePath}${ROTATION_LOCK_SUFFIX}`;
    const deadline = Date.now() + rotationLockTimeoutMs;
    let fd;
    for (;;) {
        try {
            fd = fs.openSync(lockPath, 'wx', 0o600);
            break;
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            // Break a lock abandoned by a process that crashed while holding
            // it, instead of waiting out the full timeout forever.
            try {
                if (Date.now() - fs.statSync(lockPath).mtimeMs > rotationLockStaleMs) {
                    fs.unlinkSync(lockPath);
                    continue;
                }
            } catch { /* lock disappeared or is unreadable between the stat and here -- just retry */ }
            if (Date.now() >= deadline) return false;
            syncSleep(ROTATION_LOCK_RETRY_MS);
        }
    }
    try {
        fn();
        return true;
    } finally {
        try { fs.closeSync(fd); } catch { /* already closed */ }
        try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    }
}

function rotateIfAlreadyOversized(filePath) {
    try {
        assertSafeLogTarget(filePath);
        if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= MAX_LOG_BYTES) return;
        withRotationLock(filePath, () => {
            // Re-check fresh under the lock: another process may already
            // have rotated this file while this one waited to acquire it.
            if (fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_LOG_BYTES) rotateNow(filePath);
        });
    } catch {
        warnFileFailure(filePath);
    }
}

// GOOGLE_MCP_LOG_FILE and GOOGLE_MCP_JSONL_FILE accept arbitrary paths, so the
// parent directory is frequently one this process does not own — /tmp, or a
// directory the operator deliberately shares at 0755. Tightening that to 0700
// would change permissions on unrelated files, and on /tmp the chmod fails
// outright with EPERM and takes requested logging down with it. So a directory
// only gets its mode set when this logger created it, or when it is the
// dedicated config directory the logger owns by definition. Privacy for a
// custom location rests on the 0600 file mode instead.
// Exported so the rule can be asserted on every platform: Windows chmod is a
// near no-op, so a mode comparison there cannot distinguish the two branches.
export function resolveLogDirectoryAction(directory, { exists = fs.existsSync, configDir = getConfigDir() } = {}) {
    if (!exists(directory)) return 'create';
    return path.resolve(directory) === path.resolve(configDir) ? 'chmod' : 'leave';
}

function ensurePrivateDirectory(directory) {
    const action = resolveLogDirectoryAction(directory);
    if (action === 'leave') return;
    if (action === 'create') fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(directory, 0o700); } catch (error) { if (process.platform !== 'win32') throw error; }
}

// GOOGLE_MCP_LOG_FILE / GOOGLE_MCP_JSONL_FILE accept arbitrary operator-
// configured paths. If an existing path at that location is a symlink, the
// APIs this logger otherwise uses (statSync, openSync) follow it: rotation
// would decide to rotate based on the *target's* size, and opening it would
// chmod(0600) and append diagnostic content to whatever the symlink points
// at, not to a log file this process owns (finding 15). lstat never follows
// the final path component, so this is the same "refuse unless it's a
// regular, non-symlink file" check dist/httpState.js already uses for its
// own operations files. A path that does not exist yet is fine -- it will be
// created fresh -- so only an existing non-regular/symlinked path is refused.
function assertSafeLogTarget(filePath) {
    let stat;
    try {
        stat = fs.lstatSync(filePath);
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Refusing unsafe diagnostic log path (not a regular file): ${filePath}`);
    }
}

function openPrivateLogFile(filePath) {
    assertSafeLogTarget(filePath);
    const descriptor = fs.openSync(filePath, 'a', 0o600);
    try { fs.chmodSync(filePath, 0o600); } catch (error) {
        if (process.platform !== 'win32') throw error;
    }
    fs.closeSync(descriptor);
}

function initLogFile() {
    if (logStream) return;
    const logPath = getLogFilePath();
    if (!logPath) return;
    try {
        ensurePrivateDirectory(path.dirname(logPath));
        rotateIfAlreadyOversized(logPath);
        openPrivateLogFile(logPath);
        plainBytes = fs.statSync(logPath).size;
        logStream = { path: logPath };
    } catch {
        warnFileFailure(logPath);
    }
}

function initStructuredLogFile() {
    if (structuredLogPath !== null) return structuredLogPath;
    const filePath = getStructuredLogFilePath();
    structuredLogPath = filePath || false;
    if (!filePath) return null;
    try {
        ensurePrivateDirectory(path.dirname(filePath));
        rotateIfAlreadyOversized(filePath);
        structuredBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
        openPrivateLogFile(filePath);
        return filePath;
    } catch {
        warnFileFailure(filePath);
        structuredLogPath = false;
        return null;
    }
}

function argumentDescriptor(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `array:${value.length}`;
    if (typeof value === 'string') return `string:${Buffer.byteLength(value, 'utf8')}`;
    if (value && typeof value === 'object') {
        try { return `object:${Object.keys(value).length}`; } catch { return 'object'; }
    }
    return typeof value;
}

export function getArgumentShape(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return [argumentDescriptor(args)];
    const shape = Object.create(null);
    for (const key of Object.keys(args)) shape[key] = argumentDescriptor(args[key]);
    return shape;
}

/** Persist one redacted, content-free record for an executed MCP tool call. */
export function logToolCall(record) {
    const filePath = initStructuredLogFile();
    if (!filePath) return;
    const safe = redactDiagnostic(record);
    try {
        const line = `${JSON.stringify(safe)}\n`;
        if (structuredBytes + Buffer.byteLength(line) >= rotationLimit) {
            structuredBytes = fs.statSync(filePath).size;
        }
        if (structuredBytes + Buffer.byteLength(line) > rotationLimit) {
            // Serialize against every other process sharing this path
            // (finding 24), and re-check fresh under the lock rather than
            // trusting this call's possibly-stale local structuredBytes.
            withRotationLock(filePath, () => {
                const currentSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
                if (currentSize + Buffer.byteLength(line) > rotationLimit) rotateNow(filePath);
            });
            // rotateNow() leaves nothing at filePath: appending straight
            // through would otherwise create a brand new file through Node's
            // default create-mode (the process umask, commonly 0644),
            // silently dropping the 0600 guarantee openPrivateLogFile()
            // established at startup for every write after the first
            // in-process rotation (finding 16). The plain logger doesn't
            // have this bug because its own rotation branch in log() below
            // calls initLogFile(), which reopens through
            // openPrivateLogFile(); do the structured equivalent here before
            // appending again. Safe to call even when this call lost the
            // lock race and no rotation actually happened here: it never
            // truncates an existing file.
            openPrivateLogFile(filePath);
            structuredBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
        }
        fs.appendFileSync(filePath, line, 'utf8');
        structuredBytes += Buffer.byteLength(line);
        if (shouldLog('debug')) console.error(`${timestamp()} [DEBUG] ${JSON.stringify(safe)}`);
    } catch {
        warnFileFailure(filePath);
    }
}

function parseToolCallRecords(filePath) {
    const lines = fs.readFileSync(filePath, 'utf8').trimEnd().split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line)).filter((record) => record?.event === 'tool_call');
}

export function readRecentToolCalls(limit = 200) {
    const filePath = getStructuredLogFilePath();
    if (!filePath) return { filePath: null, records: [] };
    let records;
    try {
        records = parseToolCallRecords(filePath);
    } catch (error) {
        return { filePath, records: [], error: error?.code || 'READ_FAILED' };
    }
    // Rotation retains the previous primary as `${filePath}.1` (see
    // rotateNow). Reading only the current primary means a failure moved
    // into `.1` by a rotation that happened moments ago silently drops out
    // of troubleshoot's recent-activity window even though the retained file
    // still has it (finding 19). Fold it in whenever the primary alone
    // doesn't already cover the requested window; a missing or unreadable
    // `.1` (the common case -- no rotation has happened yet) just leaves the
    // primary's records as they were.
    if (records.length < limit) {
        try {
            records = [...parseToolCallRecords(`${filePath}.1`), ...records];
        } catch { /* no retained file yet, or it isn't readable -- primary stands alone */ }
    }
    return { filePath, records: records.slice(-limit) };
}

export function resetLoggerForTests() {
    logStream?.destroy?.();
    logStream = null;
    structuredLogPath = null;
    warnedPaths = new Set();
    plainBytes = 0; structuredBytes = 0;
}

function timestamp() {
    return new Date().toISOString();
}

function formatArgs(args) {
    return args.map((arg) => {
        const safe = redactDiagnostic(arg);
        let isError = false;
        try { isError = arg instanceof Error; } catch { /* hostile proxies are formatted generically */ }
        if (isError && safe && typeof safe === 'object') {
            return safe.stack || `${safe.name}: ${safe.message}`;
        }
        if (typeof safe === 'object') {
            try { return JSON.stringify(safe); } catch { return '[Unserializable diagnostic]'; }
        }
        return String(safe);
    }).join(' ');
}

function log(level, args) {
    if (!shouldLog(level)) return;
    initLogFile();
    const tag = level.toUpperCase();
    const ts = timestamp();
    const msg = formatArgs(args);
    console.error(`${ts} [${tag}] ${msg}`);
    if (logStream) {
        try {
            const bytes = Buffer.byteLength(`${ts} [${tag}] ${msg}\n`);
            if (plainBytes + bytes >= rotationLimit) {
                plainBytes = fs.statSync(getLogFilePath()).size;
            }
            if (plainBytes + bytes > rotationLimit) {
                const logPath = getLogFilePath();
                logStream = null;
                // Serialize against every other process sharing this path
                // (finding 24); re-check fresh under the lock.
                withRotationLock(logPath, () => {
                    const currentSize = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
                    if (currentSize + bytes > rotationLimit) rotateNow(logPath);
                });
                initLogFile();
            }
            plainBytes += bytes;
            fs.appendFileSync(getLogFilePath(), `${ts} [${tag}] ${msg}\n`, 'utf8');
        } catch {
            logStream = null;
        }
    }
}

export const logger = {
    debug(...args) { log('debug', args); },
    info(...args) { log('info', args); },
    warn(...args) { log('warn', args); },
    error(...args) { log('error', args); },
};
