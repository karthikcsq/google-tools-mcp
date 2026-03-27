// Precompute tools/list payload to avoid repeated toJsonSchema() calls.
// Supports rebuilding the cache when new tools are dynamically loaded.
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toJsonSchema } from 'xsschema';
import { logger } from './logger.js';

export function collectToolsWhileRegistering(server, out) {
    const add = server.addTool.bind(server);
    server.addTool = (tool) => {
        out.push(tool);
        add(tool);
    };
}

export async function buildCachedToolsListPayload(tools) {
    return {
        tools: await Promise.all(tools.map(async (tool) => ({
            annotations: tool.annotations,
            description: tool.description,
            inputSchema: tool.parameters
                ? await toJsonSchema(tool.parameters)
                : {
                    additionalProperties: false,
                    properties: {},
                    type: 'object',
                },
            name: tool.name,
        }))),
    };
}

export function installCachedToolsListHandler(server, registeredTools) {
    const session = server.sessions[0];
    if (!session) {
        logger.warn('No MCP session; skipping tools/list cache install.');
        return;
    }

    // Build the initial cache from whatever tools are registered at startup
    let cachedPayload = null;

    session.server.setRequestHandler(ListToolsRequestSchema, async () => {
        // Rebuild cache when tool count changes (new tools dynamically loaded)
        if (!cachedPayload || cachedPayload.tools.length !== registeredTools.length) {
            logger.debug(`Rebuilding tools/list cache (${registeredTools.length} tools)...`);
            cachedPayload = await buildCachedToolsListPayload(registeredTools);
        }
        return cachedPayload;
    });

    logger.debug(`Installed dynamic tools/list cache handler (${registeredTools.length} tools initially).`);
}
