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
import { FastMCP } from 'fastmcp';
import { registerAllTools } from './tools/index.js';
import { logger } from './logger.js';

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
process.stdin.on('close', () => {
    logger.info('stdin closed — MCP client disconnected. Shutting down.');
    process.exit(0);
});
process.stdin.on('end', () => {
    logger.info('stdin ended — MCP client disconnected. Shutting down.');
    process.exit(0);
});
process.on('exit', (code) => {
    logger.info(`Process exiting with code ${code}.`);
});

// --- Server startup ---
const server = new FastMCP({
    name: 'google-tools-mcp',
    version: '1.0.0',
});

await registerAllTools(server);

try {
    logger.info('Starting google-tools-mcp server...');
    await server.start({ transportType: 'stdio' });
    // process.uptime() covers the whole life of this node process, including
    // module load time, so a slow number here means the server itself is
    // slow to boot. If this is fast (~1s) but the MCP client still reports a
    // long time-to-connect, the delay is happening before this process even
    // started — e.g. npx re-resolving the dependency tree on every launch.
    // See https://github.com/karthikcsq/google-tools-mcp/issues/46
    const readyMs = Math.round(process.uptime() * 1000);
    logger.info(`MCP Server running using stdio in ${readyMs}ms. Awaiting client connection...`);
    if (readyMs > 5000) {
        logger.warn(`Startup took ${readyMs}ms. If the MCP client also reports a long connection time, ` +
            'this process itself is slow — check for antivirus/disk contention. If this number is small ' +
            'but the client-reported connect time is much larger (e.g. near 30000ms), the delay is happening ' +
            'before this process starts (commonly npx re-resolving the dependency tree on every launch); ' +
            'see the README troubleshooting section for a fix.');
    }
    logger.info('Google auth will run automatically on first tool call.');
} catch (startError) {
    logger.error('FATAL: Server failed to start:', startError.message || startError);
    process.exit(1);
}
