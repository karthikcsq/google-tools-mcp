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
//   google-tools-mcp doctor   Inspect setup without changing files or tokens
import './config.js';
import { createRequire } from 'module';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { getConfigDir } from './config.js';
import { checkForUpdate } from './updateCheck.js';
import { assertSafeHttpBinding } from './httpAuth.js';
import { prepareMcpServerFactory, startV2HttpServer, startV2Stdio, installRuntimeLifecycle } from './mcpServer.js';
import {
    createPublishedState, getHttpServiceStatus, resolveHttpServiceConfig, restartHttpService,
    startHttpService, stopHttpService,
} from './httpLifecycle.js';
import { ensureHttpToken, publishHttpState, removeHttpState, removeHttpStateSync } from './httpState.js';

// Read our own published version straight from package.json rather than
// hardcoding it. `files: ["dist"]` in package.json only restricts what npm
// packs; package.json itself always ships at the package root (npm
// includes it unconditionally), so this resolves the same way both in this
// checkout and once installed globally.
const require = createRequire(import.meta.url);
const { version: packageVersion } = require('../package.json');
const entrypointPath = fileURLToPath(import.meta.url);
const subcommand = process.argv[2];

function statusOutput(report, json) {
    if (json) return `${JSON.stringify(report, null, 2)}\n`;
    if (!report.healthy) return `Shared HTTP service is not healthy (${report.diagnostic}).\n`;
    return `Shared HTTP service is healthy at ${report.state.url} (pid ${report.state.pid}, ` +
        `${report.identity.name} ${report.identity.version}, profile ${report.state.profile}, token source ${report.tokenSource}).\n`;
}

async function exitOperationsCli(code) {
    // Node's Windows fetch implementation releases an async libuv handle just
    // after the response body closes. An immediate process.exit can trip its
    // UV_HANDLE_CLOSING assertion; one short turn lets the SDK probe unwind.
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.exit(code);
}

// Lifecycle commands run before an MCP transport is opened. The default stdio
// path below continues to reserve stdout exclusively for protocol messages.
if (['start', 'status', 'restart', 'stop'].includes(subcommand)) {
    const json = process.argv.slice(3).includes('--json');
    const launch = { command: process.execPath, args: [entrypointPath] };
    try {
        if (subcommand === 'status') {
            const report = await getHttpServiceStatus();
            process.stdout.write(statusOutput(report, json));
            await exitOperationsCli(report.healthy ? 0 : 1);
        }
        if (subcommand === 'stop') {
            const result = await stopHttpService();
            process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `Shared HTTP service: ${result.status}.\n`);
            await exitOperationsCli(result.status === 'stop-timeout' ? 1 : 0);
        }
        const result = subcommand === 'restart'
            ? await restartHttpService({ launch })
            : await startHttpService({ launch });
        const state = result.state || result.started?.state;
        process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` :
            `Shared HTTP service ${result.status} at ${state.url}.\n`);
        await exitOperationsCli(0);
    } catch (error) {
        process.stderr.write(`Shared HTTP ${subcommand} failed: ${error?.message || 'unknown failure'}\n`);
        await exitOperationsCli(1);
    }
}

if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    process.stdout.write([
        'Usage: google-tools-mcp [command]',
        '',
        '  (no command)     Start the stdio MCP server',
        '  auth             Run Google OAuth authorization',
        '  setup [--reauth] Configure credentials and MCP clients',
        '  doctor [--json]  Inspect credentials, clients, and shared HTTP health',
        '  serve            Run the managed shared HTTP service in the foreground',
        '  start [--json]   Start or attach to the shared HTTP service',
        '  status [--json]  Authenticated health and MCP identity check',
        '  restart [--json] Stop, start, and authenticate a replacement service',
        '  stop [--json]    Stop the managed shared HTTP service',
        '',
    ].join('\n'));
    process.exit(0);
}

// --- Setup subcommand ---
if (process.argv[2] === 'setup') {
    const { runSetup } = await import('./setup.js');
    try {
        await runSetup({ reauth: process.argv.slice(3).includes('--reauth') });
        process.exit(0);
    } catch (error) {
        console.error('\nSetup failed:', error.message || error);
        process.exit(1);
    }
}

// --- Doctor subcommand ---
if (process.argv[2] === 'doctor') {
    const json = process.argv.slice(3).includes('--json');
    const { createClientAdapters } = await import('./clientAdapters.js');
    const { inspectSetup } = await import('./setupInspect.js');
    try {
        const report = await inspectSetup({ adapters: createClientAdapters() });
        if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        else {
            console.log(report.healthy ? 'Setup is healthy.' : 'Setup problems found:');
            for (const problem of report.problems) console.log(`- ${problem}`);
            for (const client of report.clients) console.log(`- ${client.client}: ${client.status}`);
        }
        process.exit(report.healthy ? 0 : 1);
    } catch {
        if (json) process.stdout.write(`${JSON.stringify({ healthy: false, inspectionError: true })}\n`);
        else console.error('Could not inspect setup.');
        process.exit(2);
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
const useHttp = subcommand === 'serve' || transportEnv === 'http' || transportEnv === 'httpstream';
// resolveHttpServiceConfig validates GOOGLE_MCP_PORT, GOOGLE_MCP_ENDPOINT,
// GOOGLE_MCP_HTTP_HOST, the profile, and the loopback-only deployment boundary.
let httpConfig = null;

// --- HTTP security ---
// The HTTP transport exposes the authenticated Google tool surface over a local
// URL. Gate it behind a bearer token + Origin validation and bind to loopback
// by default so it isn't reachable by untrusted local processes, browser-
// delivered requests, or the network. (PR #36 review)
if (useHttp) {
    // Refuse to start rather than log a warning after the fact: a non-loopback
    // host combined with GOOGLE_MCP_HTTP_NO_AUTH=1 is a remotely reachable,
    // completely unauthenticated server in front of Gmail/Drive/Docs/Calendar,
    // and an empty host after trimming can make Node bind to all interfaces.
    // Written straight to stderr (not the logger) so LOG_LEVEL=error/silent
    // can't hide the reason the process refused to start.
    try {
        httpConfig = resolveHttpServiceConfig(process.env);
        assertSafeHttpBinding(httpConfig);
    } catch (configError) {
        process.stderr.write(`FATAL: ${configError.message}\n`);
        process.exit(1);
    }
}
let httpToken = null;
let httpTokenInfo = null;
if (useHttp && !httpConfig.noAuth) {
    try {
        httpTokenInfo = await ensureHttpToken();
        httpToken = httpTokenInfo.token;
    } catch (tokenError) {
        process.stderr.write(`FATAL: Could not load the shared HTTP token (${tokenError?.message || 'unknown failure'}).\n`);
        process.exit(1);
    }
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
let ownsHttpState = false;
try {
    if (useHttp) {
        const existing = await getHttpServiceStatus();
        if (existing.healthy) {
            if (existing.state.profile !== profile) {
                process.stderr.write(`FATAL: Port ${httpConfig.port} is managed by profile ${existing.state.profile}. ` +
                    'Set GOOGLE_MCP_PORT to a different port for this profile.\n');
                process.exit(1);
            }
            process.stderr.write(`Shared HTTP service is already healthy at ${existing.state.url}; attach clients to that instance.\n`);
            process.exit(0);
        }
    }
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
            auth: { token: httpToken, noAuth: httpConfig.noAuth, allowedOrigins: httpConfig.allowedOrigins },
            endpoint: httpConfig.endpoint,
            host: httpConfig.host,
            port: httpConfig.port,
            profile,
            logger,
        });
        const published = await publishHttpState(createPublishedState(httpConfig, { version: packageVersion }));
        ownsHttpState = true;
        const httpRuntime = runtime;
        runtime = Object.freeze({
            ...httpRuntime,
            async close() {
                try { await httpRuntime.close(); }
                finally {
                    await removeHttpState({ expectedPid: process.pid });
                    ownsHttpState = false;
                }
            },
        });
        readyMs = Math.round(process.uptime() * 1000);
        logger.info(`MCP Server running over HTTP at ${published.url} in ${readyMs}ms.`);
        // "bearer-token", hyphenated: the log redactor treats `Bearer <word>`
        // as a credential and would rewrite the unhyphenated phrase to
        // "Bearer [REDACTED] required".
        logger.info(`Auth: ${httpConfig.noAuth ? 'DISABLED (GOOGLE_MCP_HTTP_NO_AUTH) — do not use on a shared machine' : `bearer-token required (${httpTokenInfo.source})`}; bound to ${httpConfig.host}.`);
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
    if (startError?.code === 'EADDRINUSE' && httpConfig) {
        process.stderr.write(`FATAL: Port ${httpConfig.port} is already in use by an unmanaged or unhealthy process. ` +
            'Stop that process or set GOOGLE_MCP_PORT to a free loopback port, then update client URLs.\n');
    } else {
        logger.error('FATAL: Server failed to start:', startError.message || startError);
    }
    process.exit(1);
}

process.on('exit', () => {
    if (ownsHttpState) removeHttpStateSync({ expectedPid: process.pid });
});
