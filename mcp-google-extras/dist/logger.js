// src/logger.ts
//
// Centralized logger with LOG_LEVEL support.
//
// Log levels (from most to least verbose):
//   debug  - Detailed diagnostic info (text range mapping, request building, etc.)
//   info   - General operational messages (server started, auth succeeded, etc.)
//   warn   - Potentially harmful situations (missing content, fallback behavior)
//   error  - Error conditions (API failures, auth failures, etc.)
//
// Set via the LOG_LEVEL environment variable. Defaults to "info".
// Example: LOG_LEVEL=debug npm start
//
// MCP servers communicate over stdout, so all log output goes to stderr.
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
/** Re-read LOG_LEVEL from the environment (useful for testing). */
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
