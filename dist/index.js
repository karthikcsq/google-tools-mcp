#!/usr/bin/env node
// src/index.ts
//
// Single entry point for the Google Docs MCP Server.
//
// Usage:
//   gdrive-tools-mcp          Start the MCP server (default)
//   gdrive-tools-mcp auth     Run the interactive OAuth flow
import { FastMCP } from 'fastmcp';
import { buildCachedToolsListPayload, collectToolsWhileRegistering, installCachedToolsListHandler, } from './cachedToolsList.js';
import { registerAllTools } from './tools/index.js';
import { logger } from './logger.js';
// --- Auth subcommand ---
if (process.argv[2] === 'auth') {
    const { runAuthFlow } = await import('./auth.js');
    try {
        await runAuthFlow();
        logger.info('Authorization complete. You can now start the MCP server.');
        process.exit(0);
    }
    catch (error) {
        logger.error('Authorization failed:', error.message || error);
        process.exit(1);
    }
}
// --- Server startup ---
// Set up process-level unhandled error/rejection handlers to prevent crashes
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
});
process.on('unhandledRejection', (reason, _promise) => {
    logger.error('Unhandled Promise Rejection:', reason);
});
const server = new FastMCP({
    name: 'gdrive-tools-mcp',
    version: '1.0.0',
});
const registeredTools = [];
collectToolsWhileRegistering(server, registeredTools);
registerAllTools(server);
try {
    logger.info('Starting gdrive-tools-mcp server...');
    const cachedToolsList = await buildCachedToolsListPayload(registeredTools);
    await server.start({ transportType: 'stdio' });
    installCachedToolsListHandler(server, cachedToolsList);
    logger.info('MCP Server running using stdio. Awaiting client connection...');
    logger.info('Google auth will run automatically on first tool call.');
}
catch (startError) {
    logger.error('FATAL: Server failed to start:', startError.message || startError);
    process.exit(1);
}
