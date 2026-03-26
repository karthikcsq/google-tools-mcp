// Precompute tools/list payload once at startup to avoid repeated toJsonSchema() calls.
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
export function installCachedToolsListHandler(server, listPayload) {
    const session = server.sessions[0];
    if (!session) {
        logger.warn('No MCP session; skipping tools/list cache install.');
        return;
    }
    session.server.setRequestHandler(ListToolsRequestSchema, async () => listPayload);
    logger.debug(`Installed cached tools/list (${listPayload.tools.length} tools).`);
}
