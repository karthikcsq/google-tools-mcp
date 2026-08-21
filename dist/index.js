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
import './config.js';
import { createRequire } from 'module';
import { logger } from './logger.js';
import { getConfigDir } from './config.js';
import { checkForUpdate } from './updateCheck.js';
import { resolveHttpAuthConfig, assertSafeHttpBinding, generateToken } from './httpAuth.js';
import { prepareMcpServerFactory, startV2HttpServer, startV2Stdio, installRuntimeLifecycle } from './mcpServer.js';

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
// client. Accepts "http" or "httpStream"; both now map to the same stateless
// 2026-07-28 HTTP runtime ("httpStream" is kept only so an existing config
// keeps starting, since there is no separate streamed transport any more).
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
process.on('exit', (code) => {
    logger.info(`Process exiting with code ${code}.`);
});

// --- Server startup ---
// One runtime: the official MCP SDK v2 facade in dist/mcpServer.js. Tools are
// preloaded once into a definition list, then each stdio connection / HTTP
// request gets a side-effect-free SDK server built from it.
const profile = (process.env.GOOGLE_MCP_PROFILE || 'default').trim() || 'default';
try {
    logger.info('Starting google-tools-mcp server...');
    const factory = await prepareMcpServerFactory({ logger });
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
    let runtime;
    let readyMs;
    if (useHttp) {
        // Bearer token + Origin are checked by the facade's middleware ahead of
        // the SDK handler, on every method and every path — there is no session
        // lifecycle left to dispatch on, and no legacy /sse or /messages route
        // to leave open.
        runtime = await startV2HttpServer(factory, {
            auth: { token: httpToken, noAuth: httpAuth.noAuth, allowedOrigins: httpAuth.allowedOrigins },
            endpoint: httpEndpoint,
            host: httpAuth.host,
            port: httpPort,
            profile,
            logger,
        });
        readyMs = Math.round(process.uptime() * 1000);
        logger.info(`MCP Server running over HTTP at http://${httpAuth.host}:${httpPort}${httpEndpoint} in ${readyMs}ms.`);
        // "bearer-token", hyphenated: the log redactor treats `Bearer <word>`
        // as a credential and would rewrite the unhyphenated phrase to
        // "Bearer [REDACTED] required".
        logger.info(`Auth: ${httpAuth.noAuth ? 'DISABLED (GOOGLE_MCP_HTTP_NO_AUTH) — do not use on a shared machine' : 'bearer-token required'}; bound to ${httpAuth.host}.`);
        logger.info('Shared mode: point every client at this URL instead of spawning one stdio server per client.');
        logger.info('HTTP is stateless (MCP 2026-07-28): no Mcp-Session-Id, no /sse, and read state is never carried ' +
            'between requests. Docs edits over HTTP need the readHandle returned by readDocument; guarded Sheets and ' +
            'Drive edits are stdio-only in this release.');
        logger.info('One process serves one configured Google profile and one effective service principal. ' +
            'Multiple profiles or horizontal scale are out of scope for this release.');
    } else {
        runtime = startV2Stdio(factory, { profile, logger });
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
    // One lifecycle owner for SIGINT/SIGTERM and, on stdio, the stdin-EOF
    // shutdown path the SDK's own transport does not provide.
    installRuntimeLifecycle(runtime, { useStdio: !useHttp, logger });

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
