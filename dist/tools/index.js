import { registerDocsTools } from './docs/index.js';
import { registerDriveTools } from './drive/index.js';
import { registerSheetsTools } from './sheets/index.js';
import { registerUtilsTools } from './utils/index.js';
import { registerExtrasTools } from './extras/index.js';
/**
 * Registers all tools with the FastMCP server.
 */
export function registerAllTools(server) {
    registerDocsTools(server);
    registerDriveTools(server);
    registerSheetsTools(server);
    registerUtilsTools(server);
    registerExtrasTools(server);
}
