#!/usr/bin/env node
// google-tools-mcp — Combined Google Workspace MCP server
//
// All tool categories (Drive, Docs, Sheets, Gmail, Calendar) are loaded at
// startup so they're available in the initial tools/list response.
//
// Usage:
//   google-tools-mcp          Start the MCP server (default)
//   google-tools-mcp auth     Run the interactive OAuth flow
//   google-tools-mcp setup    Guided setup: enable APIs, create credentials, authenticate
import { createRequire } from 'module';
import { FastMCP } from 'fastmcp';
import { registerAllTools } from './tools/index.js';
import { logger } from './logger.js';
import { getConfigDir } from './auth.js';
import { checkForUpdate } from './updateCheck.js';
import { resolveHttpAuthConfig, assertSafeHttpBinding, generateToken, createHttpAuthenticate, createHttpRequestGuard, startWithRequestGuard } from './httpAuth.js';
import { clearSession } from './readTracker.js';

// Read our own published version straight from package.json rather than
// hardcoding it. `files: ["dist"]` in package.json only restricts what npm
// packs; package.json itself always ships at the package root (npm
// includes it unconditionally), so this resolves the same way both in this
// checkout and once installed globally.
const require = createRequire(import.meta.url);
const { version: packageVersion } = require('../package.json');

// --- Setup subcommand ---
if (process.argv[2] === 'setup') {
    const { runSetup } = await import('./setup.js');
    try {
        await runSetup();
        process.exit(0);
    } catch (error) {
        console.error('\nSetup failed:', error.message || error);
        process.exit(1);
    }
}

// --- Auth subcommand ---
if (process.argv[2] === 'auth') {
    const { runAuthFlow } = await import('./auth.js');
    try {
        await runAuthFlow();
        logger.info('Authorization complete. You can now start the MCP server.');
        process.exit(0);
    } catch (error) {
        logger.error('Authorization failed:', error.message || error);
        process.exit(1);
    }
}

// --- Transport selection ---
// Default is stdio (one server spawned per MCP client, the classic model).
// Set GOOGLE_MCP_TRANSPORT=http to run a single long-lived HTTP server that
// many clients share over a localhost URL — one process instead of one per
// session. Accepts "http" or "httpStream" (both map to FastMCP httpStream).
const transportEnv = (process.env.GOOGLE_MCP_TRANSPORT || 'stdio').toLowerCase();
const useHttp = transportEnv === 'http' || transportEnv === 'httpstream';
const httpPort = Number(process.env.GOOGLE_MCP_PORT) || 3939;
const httpEndpoint = process.env.GOOGLE_MCP_ENDPOINT || '/mcp';

// --- HTTP security ---
// The HTTP transport exposes the authenticated Google tool surface over a local
// URL. Gate it behind a bearer token + Origin validation and bind to loopback
// by default so it isn't reachable by untrusted local processes, browser-
// delivered requests, or the network. (PR #36 review)
const httpAuth = resolveHttpAuthConfig(process.env);
if (useHttp) {
    // Refuse to start rather than log a warning after the fact: a non-loopback
    // host combined with GOOGLE_MCP_HTTP_NO_AUTH=1 is a remotely reachable,
    // completely unauthenticated server in front of Gmail/Drive/Docs/Calendar,
    // and an empty host after trimming can make Node bind to all interfaces.
    // Written straight to stderr (not the logger) so LOG_LEVEL=error/silent
    // can't hide the reason the process refused to start.
    try {
        assertSafeHttpBinding(httpAuth);
    } catch (configError) {
        process.stderr.write(`FATAL: ${configError.message}\n`);
        process.exit(1);
    }
}
let httpToken = httpAuth.explicitToken;
if (useHttp && !httpAuth.noAuth && !httpToken) {
    // No token configured — generate a one-time one so the server is never
    // unauthenticated by accident. Log it prominently; the operator should set
    // GOOGLE_MCP_HTTP_TOKEN to a fixed value to keep it stable across restarts.
    httpToken = generateToken();
    // Write straight to stderr rather than through the logger. LOG_LEVEL=error
    // and LOG_LEVEL=silent are both documented settings, and either one would
    // swallow a warn-level message — starting a server that demands a token
    // nobody ever saw, so every client gets rejected with no way to recover.
    process.stderr.write(
        'GOOGLE_MCP_HTTP_TOKEN is not set — generated a one-time token for this run.\n' +
        `  Token: ${httpToken}\n` +
        '  Clients must send:  Authorization: Bearer <token>\n' +
        '  Set GOOGLE_MCP_HTTP_TOKEN to keep this stable across restarts.\n'
    );
}

// --- Process lifecycle logging ---
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
});
process.on('unhandledRejection', (reason, _promise) => {
    logger.error('Unhandled Promise Rejection:', reason);
});
process.on('SIGINT', () => {
    logger.info('Received SIGINT — shutting down.');
    process.exit(0);
});
process.on('SIGTERM', () => {
    logger.info('Received SIGTERM — shutting down.');
    process.exit(0);
});
// Exit when the MCP client closes the stdio pipe.
// This is the primary shutdown path for stdio MCP servers — SIGTERM is not
// reliably delivered on Windows when a parent process exits.
//
// IMPORTANT: only wire these in stdio mode. In HTTP mode the server is a
// detached daemon whose stdin ends/closes immediately at launch — attaching
// these there would make the daemon exit the instant it starts.
if (!useHttp) {
    process.stdin.on('close', () => {
        logger.info('stdin closed — MCP client disconnected. Shutting down.');
        process.exit(0);
    });
    process.stdin.on('end', () => {
        logger.info('stdin ended — MCP client disconnected. Shutting down.');
        process.exit(0);
    });
}
process.on('exit', (code) => {
    logger.info(`Process exiting with code ${code}.`);
});

// --- Server startup ---
const serverOptions = {
    name: 'google-tools-mcp',
    version: '1.0.0',
};
if (useHttp) {
    // authenticate() runs before any tool; a throw becomes an HTTP 401. It is
    // only attached in HTTP mode, so stdio behavior is unchanged.
    serverOptions.authenticate = createHttpAuthenticate(
        { token: httpToken, noAuth: httpAuth.noAuth, allowedOrigins: httpAuth.allowedOrigins },
        logger,
    );
}
const server = new FastMCP(serverOptions);

// Free per-session tracker state when an HTTP client disconnects, so a long-
// lived shared server doesn't accumulate it indefinitely.
server.on('disconnect', ({ session }) => {
    try {
        const key = session?.sessionId;
        if (key) clearSession(key);
    } catch (cleanupError) {
        logger.warn(`Session cleanup failed: ${cleanupError.message || cleanupError}`);
    }
});

await registerAllTools(server);

try {
    logger.info('Starting google-tools-mcp server...');
    // process.uptime() covers the whole life of this node process, including
    // module load time, so a slow number here means the server itself is
    // slow to boot. If this is fast (~1s) but the MCP client still reports a
    // long time-to-connect, the delay is happening before this process even
    // started — e.g. npx re-resolving the dependency tree on every launch.
    // See https://github.com/karthikcsq/google-tools-mcp/issues/46
    //
    // Measured inside each branch rather than once before them, so the number
    // covers the transport actually being brought up: binding a port is not
    // the same work as attaching to a stdio pipe.
    let readyMs;
    if (useHttp) {
        // authenticate() above only runs on session creation (POST). The guard
        // covers every method and every route mcp-proxy can dispatch to
        // (including the legacy /sse and /messages compatibility endpoints
        // FastMCP always stands up alongside the configured streamable
        // endpoint), so GET stream attachment and DELETE session termination
        // have to present the same token instead of riding on a session id
        // alone.
        const guard = createHttpRequestGuard(
            { token: httpToken, noAuth: httpAuth.noAuth, allowedOrigins: httpAuth.allowedOrigins },
            logger,
        );
        await startWithRequestGuard(() => server.start({
            transportType: 'httpStream',
            httpStream: { port: httpPort, endpoint: httpEndpoint, host: httpAuth.host },
        }), guard);
        readyMs = Math.round(process.uptime() * 1000);
        logger.info(`MCP Server running over HTTP at http://${httpAuth.host}:${httpPort}${httpEndpoint} in ${readyMs}ms.`);
        logger.info(`Auth: ${httpAuth.noAuth ? 'DISABLED (GOOGLE_MCP_HTTP_NO_AUTH) — do not use on a shared machine' : 'bearer token required'}; bound to ${httpAuth.host}.`);
        logger.info('Shared mode: point every client at this URL instead of spawning per-session stdio servers.');
    } else {
        await server.start({ transportType: 'stdio' });
        readyMs = Math.round(process.uptime() * 1000);
        logger.info(`MCP Server running using stdio in ${readyMs}ms. Awaiting client connection...`);
    }
    if (readyMs > 5000) {
        logger.warn(`Startup took ${readyMs}ms. If the MCP client also reports a long connection time, ` +
            'this process itself is slow — check for antivirus/disk contention. If this number is small ' +
            'but the client-reported connect time is much larger (e.g. near 30000ms), the delay is happening ' +
            'before this process starts (commonly npx re-resolving the dependency tree on every launch); ' +
            'see the README troubleshooting section for a fix.');
    }
    logger.info('Google auth will run automatically on first tool call.');

    // Best-effort update nudge. This runs AFTER the transport above is
    // already established, and is deliberately not awaited: a slow or
    // unreachable registry can never delay or block the MCP handshake this
    // way. checkForUpdate() is itself time-boxed and caches its result, so
    // most launches don't even make a network call. See updateCheck.js for
    // why this exists: pointing MCP clients at a fixed global-install path
    // (see setup.js) fixed the npx timeout race but also means nothing else
    // ever re-runs `npm install -g` to pick up new releases.
    checkForUpdate({ currentVersion: packageVersion, configDir: getConfigDir() })
        .then((result) => {
            if (result?.updateAvailable) {
                logger.warn(
                    `A newer version of google-tools-mcp is available: ${result.latestVersion} ` +
                    `(currently running ${packageVersion}). Update with: npm install -g google-tools-mcp@latest`
                );
            }
        })
        .catch(() => {
            // checkForUpdate() already swallows its own errors; this catch
            // only guards against a truly unexpected throw so it can never
            // surface as an unhandled rejection.
        });
} catch (startError) {
    logger.error('FATAL: Server failed to start:', startError.message || startError);
    process.exit(1);
}
