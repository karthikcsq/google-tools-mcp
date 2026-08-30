import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const MODERN_PROTOCOL_VERSION = '2026-07-28';
export const FIXTURE_INSTRUCTIONS = 'Compatibility fixture instructions.';

const CACHE_HINT = Object.freeze({ ttlMs: 60_000, cacheScope: 'private' });
const NOOP_LOG = Object.freeze({
    debug() {},
    info() {},
    warn() {},
    error() {},
});

const FIXTURE_TOOLS = Object.freeze([
    {
        name: 'alphaEcho',
        description: 'Return the supplied text with an alpha prefix.',
        inputSchema: z.object({ text: z.string() }),
        async execute({ text }) {
            return { content: [{ type: 'text', text: `alpha:${text}` }] };
        },
    },
    {
        name: 'zetaEcho',
        description: 'Return the supplied text with a zeta prefix.',
        inputSchema: z.object({ text: z.string() }),
        async execute({ text }) {
            return { content: [{ type: 'text', text: `zeta:${text}` }] };
        },
    },
]);

function normalizeToolResult(result) {
    return typeof result === 'string'
        ? { content: [{ type: 'text', text: result }] }
        : result;
}

/**
 * A deliberately small server built only from the v2 public API. Its explicit
 * listChanged:false is significant: McpServer otherwise advertises true when
 * tools are registered, even though this fixture never changes its catalog.
 */
export function buildCompatibilityFixtureServer() {
    const server = new McpServer(
        { name: 'google-tools-mcp-compatibility-fixture', version: '0.0.0' },
        {
            capabilities: { tools: { listChanged: false } },
            instructions: FIXTURE_INSTRUCTIONS,
            cacheHints: {
                'server/discover': CACHE_HINT,
                'tools/list': CACHE_HINT,
            },
        }
    );

    for (const tool of [...FIXTURE_TOOLS].sort((left, right) => left.name.localeCompare(right.name))) {
        server.registerTool(
            tool.name,
            { description: tool.description, inputSchema: tool.inputSchema },
            tool.execute
        );
    }

    return server;
}

export function createCompatibilityFixtureHandler() {
    // The default `legacy: 'stateless'` is part of the compatibility proof.
    return createMcpHandler(buildCompatibilityFixtureServer);
}

export function modernMeta() {
    return {
        'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
    };
}

export function modernRequest({ id, method, params = {}, includeProtocolHeader = true, headers = {}, signal }) {
    const requestHeaders = {
        'content-type': 'application/json',
        'mcp-method': method,
        ...headers,
    };
    if (includeProtocolHeader) requestHeaders['mcp-protocol-version'] = MODERN_PROTOCOL_VERSION;

    return new Request('http://compatibility.test/mcp', {
        method: 'POST',
        headers: requestHeaders,
        signal,
        body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method,
            params: { ...params, _meta: modernMeta() },
        }),
    });
}

export function legacyRequest({ id, method, params = {} }) {
    return new Request('http://compatibility.test/mcp', {
        method: 'POST',
        headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
}

export function parseLegacySseResponse(text) {
    const dataLine = text.split(/\r?\n/).find((line) => line.startsWith('data: '));
    if (!dataLine) throw new Error(`Expected an MCP SSE data frame, received: ${text}`);
    return JSON.parse(dataLine.slice('data: '.length));
}

/**
 * Test-only compatibility adapter. It preserves the current tool-module seam
 * (`addTool({ name, description, parameters, execute })`) while exercising
 * McpServer.registerTool with every real application schema. The production
 * facade is intentionally deferred to the next migration phase.
 */
export function createOfficialSdkRegistrationAdapter() {
    const officialServer = new McpServer(
        { name: 'google-tools-mcp-registration-spike', version: '0.0.0' },
        { capabilities: { tools: { listChanged: false } } }
    );
    const definitions = [];

    return {
        definitions,
        officialServer,
        adapter: {
            addTool(definition) {
                definitions.push(definition);
                return officialServer.registerTool(
                    definition.name,
                    {
                        description: definition.description,
                        inputSchema: definition.parameters,
                    },
                    async (args) => normalizeToolResult(await definition.execute(args, { log: NOOP_LOG }))
                );
            },
        },
    };
}
