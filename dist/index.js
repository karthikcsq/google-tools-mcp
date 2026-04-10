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
    logger.info('MCP Server running using stdio. Awaiting client connection...');
    logger.info('Google auth will run automatically on first tool call.');
} catch (startError) {
    logger.error('FATAL: Server failed to start:', startError.message || startError);
    process.exit(1);
}
