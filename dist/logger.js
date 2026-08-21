// Centralized logger with LOG_LEVEL support.
// All log output goes to stderr (stdout reserved for MCP protocol).
// Plain logs and structured tool-call records are both persisted by default.
import * as fs from 'fs';
import * as path from 'path';
import { redactDiagnostic } from './errors.js';
import { getDefaultLogPath, getDefaultJsonlPath } from './config.js';

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

export function getStructuredLogFilePath() {
    const plainPath = getLogFilePath();
    if (!plainPath) return null;
    const configured = process.env.GOOGLE_MCP_JSONL_FILE;
    if (configured === undefined || configured === '' || configured === '1') {
        return process.env.GOOGLE_MCP_LOG_FILE && process.env.GOOGLE_MCP_LOG_FILE !== '1'
            ? path.join(path.dirname(plainPath), 'server.jsonl')
            : getDefaultJsonlPath();
    }
    if (disabledValues.has(String(configured).toLowerCase())) return null;
    return configured;
}

function warnFileFailure(filePath) {
    if (warnedPaths.has(filePath)) return;
    warnedPaths.add(filePath);
    process.stderr.write(`WARNING: Unable to write diagnostic log file ${filePath}.\n`);
}

function rotateNow(filePath) {
    const rotatedPath = `${filePath}.1`;
    try { fs.unlinkSync(rotatedPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    fs.renameSync(filePath, rotatedPath);
}
function rotateIfAlreadyOversized(filePath) {
    try {
        if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= MAX_LOG_BYTES) return;
        rotateNow(filePath);
    } catch {
        warnFileFailure(filePath);
    }
}

function initLogFile() {
    if (logStream) return;
    const logPath = getLogFilePath();
    if (!logPath) return;
    try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        rotateIfAlreadyOversized(logPath);
        fs.closeSync(fs.openSync(logPath, 'a'));
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
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        rotateIfAlreadyOversized(filePath);
        structuredBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
        fs.closeSync(fs.openSync(filePath, 'a'));
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
            rotateNow(filePath); structuredBytes = 0;
        }
        fs.appendFileSync(filePath, line, 'utf8');
        structuredBytes += Buffer.byteLength(line);
        if (shouldLog('debug')) console.error(`${timestamp()} [DEBUG] ${JSON.stringify(safe)}`);
    } catch {
        warnFileFailure(filePath);
    }
}

export function readRecentToolCalls(limit = 200) {
    const filePath = getStructuredLogFilePath();
    if (!filePath) return { filePath: null, records: [] };
    try {
        const lines = fs.readFileSync(filePath, 'utf8').trimEnd().split('\n').filter(Boolean).slice(-limit);
        const records = lines.map((line) => JSON.parse(line)).filter((record) => record?.event === 'tool_call');
        return { filePath, records };
    } catch (error) {
        return { filePath, records: [], error: error?.code || 'READ_FAILED' };
    }
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
                logStream = null; rotateNow(getLogFilePath()); initLogFile();
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
