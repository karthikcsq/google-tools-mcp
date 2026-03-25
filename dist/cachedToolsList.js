// FastMCP's default tools/list handler runs toJsonSchema() for every tool on every request.
// Hosts that poll tools/list frequently (or many concurrent sessions) then burn a full CPU core.
// We precompute the list once before stdio connects, then replace the handler to return that snapshot.
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
