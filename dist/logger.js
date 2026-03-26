// src/logger.ts
//
// Centralized logger with LOG_LEVEL support.
// All log output goes to stderr (stdout reserved for MCP protocol).
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
export const logger = {
    debug(...args) {
        if (shouldLog('debug')) {
            console.error('[DEBUG]', ...args);
        }
    },
    info(...args) {
        if (shouldLog('info')) {
            console.error('[INFO]', ...args);
        }
    },
    warn(...args) {
        if (shouldLog('warn')) {
            console.error('[WARN]', ...args);
        }
    },
    error(...args) {
        if (shouldLog('error')) {
            console.error('[ERROR]', ...args);
        }
    },
};
