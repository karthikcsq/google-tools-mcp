#!/usr/bin/env node
// google-tools-mcp — Combined Google Workspace MCP server
//
// Provides lazy-loaded tool categories for Drive, Docs, Sheets, and Gmail.
// Only a discovery tool is exposed at startup; individual tools are loaded on demand.
//
// Usage:
//   google-tools-mcp          Start the MCP server (default)
//   google-tools-mcp auth     Run the interactive OAuth flow
import { FastMCP } from 'fastmcp';
import { collectToolsWhileRegistering, installCachedToolsListHandler } from './cachedToolsList.js';
import { registerAllTools } from './tools/index.js';
import { logger } from './logger.js';

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

// --- Server startup ---
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
});
process.on('unhandledRejection', (reason, _promise) => {
    logger.error('Unhandled Promise Rejection:', reason);
});

const server = new FastMCP({
    name: 'google-tools-mcp',
    version: '1.0.0',
});

const registeredTools = [];
collectToolsWhileRegistering(server, registeredTools);
registerAllTools(server);

try {
    logger.info('Starting google-tools-mcp server...');
    await server.start({ transportType: 'stdio' });
    installCachedToolsListHandler(server, registeredTools);
    logger.info('MCP Server running using stdio. Awaiting client connection...');
    logger.info('Google auth will run automatically on first tool call.');
    logger.info(`${registeredTools.length} tools registered at startup (discovery + logout). Call load_google_tools to load more.`);
} catch (startError) {
    logger.error('FATAL: Server failed to start:', startError.message || startError);
    process.exit(1);
}
