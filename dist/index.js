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

// --- Transport selection ---
// Default is stdio (one server spawned per MCP client, the classic model).
// Set GOOGLE_MCP_TRANSPORT=http to run a single long-lived HTTP server that
// many clients share over a localhost URL — one process instead of one per
// session. Accepts "http" or "httpStream" (both map to FastMCP httpStream).
const transportEnv = (process.env.GOOGLE_MCP_TRANSPORT || 'stdio').toLowerCase();
const useHttp = transportEnv === 'http' || transportEnv === 'httpstream';
const httpPort = Number(process.env.GOOGLE_MCP_PORT) || 3939;
const httpEndpoint = process.env.GOOGLE_MCP_ENDPOINT || '/mcp';

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
const server = new FastMCP({
    name: 'google-tools-mcp',
    version: '1.0.0',
});

await registerAllTools(server);

try {
    logger.info('Starting google-tools-mcp server...');
    if (useHttp) {
        await server.start({
            transportType: 'httpStream',
            httpStream: { port: httpPort, endpoint: httpEndpoint },
        });
        logger.info(`MCP Server running over HTTP at http://localhost:${httpPort}${httpEndpoint}`);
        logger.info('Shared mode: point every client at this URL instead of spawning per-session stdio servers.');
    } else {
        await server.start({ transportType: 'stdio' });
        logger.info('MCP Server running using stdio. Awaiting client connection...');
    }
    logger.info('Google auth will run automatically on first tool call.');
} catch (startError) {
    logger.error('FATAL: Server failed to start:', startError.message || startError);
    process.exit(1);
}
