#!/usr/bin/env node
// src/index.ts
//
// Gmail MCP Server with lazy-loading auth and multi-profile support.
// Forked from @shinzolabs/gmail-mcp.
//
// Usage:
//   mcp-gmail          Start the MCP server (default)
//   mcp-gmail auth     Run the interactive OAuth flow
import { FastMCP } from 'fastmcp';
import { buildCachedToolsListPayload, collectToolsWhileRegistering, installCachedToolsListHandler } from './cachedToolsList.js';
import { registerAllTools } from './tools/index.js';
import { logger } from './logger.js';

// --- Auth subcommand ---
if (process.argv[2] === 'auth') {
    const { runAuthFlow } = await import('./auth.js');
    try {
        await runAuthFlow();
        logger.info('Gmail authorization complete. You can now start the MCP server.');
        process.exit(0);
    } catch (error) {
        logger.error('Authorization failed:', error.message || error);
        process.exit(1);
    }
}

// --- Server startup ---
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
});
process.on('unhandledRejection', (reason, _promise) => {
    logger.error('Unhandled Promise Rejection:', reason);
});

const server = new FastMCP({
    name: 'mcp-gmail',
    version: '1.0.0',
});

const registeredTools = [];
collectToolsWhileRegistering(server, registeredTools);
registerAllTools(server);

try {
    logger.info('Starting mcp-gmail server...');
    const cachedToolsList = await buildCachedToolsListPayload(registeredTools);
    await server.start({ transportType: 'stdio' });
    installCachedToolsListHandler(server, cachedToolsList);
    logger.info('MCP Server running using stdio. Awaiting client connection...');
    logger.info('Gmail auth will run automatically on first tool call.');
} catch (startError) {
    logger.error('FATAL: Server failed to start:', startError.message || startError);
    process.exit(1);
}
