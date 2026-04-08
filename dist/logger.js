// Centralized logger with LOG_LEVEL support.
// All log output goes to stderr (stdout reserved for MCP protocol).
// If GOOGLE_MCP_LOG_FILE is set, logs are also appended to that file.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
let currentLevel = resolveLevel();
export function refreshLogLevel() {
    currentLevel = resolveLevel();
}
function shouldLog(level) {
    return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

// --- File logging ---
let logStream = null;

function getDefaultLogPath() {
    const xdg = process.env.XDG_CONFIG_HOME;
    const base = xdg || path.join(os.homedir(), '.config');
    const baseDir = path.join(base, 'google-tools-mcp');
    const profile = process.env.GOOGLE_MCP_PROFILE;
    const dir = profile ? path.join(baseDir, profile) : baseDir;
    return path.join(dir, 'server.log');
}

function initLogFile() {
    if (logStream) return;
    const logPath = process.env.GOOGLE_MCP_LOG_FILE === '1'
        ? getDefaultLogPath()
        : process.env.GOOGLE_MCP_LOG_FILE;
    if (!logPath) return;
    try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        logStream = fs.createWriteStream(logPath, { flags: 'a' });
    } catch {
        // If we can't open the log file, continue without file logging
    }
}
initLogFile();

function timestamp() {
    return new Date().toISOString();
}

function formatArgs(args) {
    return args.map(a => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch { return String(a); }
        }
        return String(a);
    }).join(' ');
}

function log(level, args) {
    if (!shouldLog(level)) return;
    const tag = level.toUpperCase();
    const ts = timestamp();
    const msg = formatArgs(args);
    console.error(`${ts} [${tag}] ${msg}`);
    if (logStream) {
        logStream.write(`${ts} [${tag}] ${msg}\n`);
    }
}

export const logger = {
    debug(...args) { log('debug', args); },
    info(...args) { log('info', args); },
    warn(...args) { log('warn', args); },
    error(...args) { log('error', args); },
};
