// Real loopback MCP transport for live scenarios that must exercise HTTP-only
// behavior such as explicit read handles. It starts the production v2 HTTP
// server on an ephemeral loopback port; scenarios never call its fetch handler
// directly, so Node's request parser and transport wrapper are in the path.
import { randomBytes } from 'node:crypto';

import { prepareMcpServerFactory, startV2HttpServer, MCP_PROTOCOL_VERSION } from '../../dist/mcpServer.js';
import { truncateDeep } from './journal.mjs';

const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

export async function startLoopbackMcp({ guard, journal, scenario }) {
    const token = randomBytes(32).toString('base64url');
    const factory = await prepareMcpServerFactory({ logger: SILENT });
    const runtime = await startV2HttpServer(factory, {
        host: '127.0.0.1',
        port: 0,
        auth: { token },
        profile: 'live-smoke',
        logger: SILENT,
    });
    const address = runtime.server.address();
    if (!address || typeof address === 'string' || !Number.isSafeInteger(address.port)) {
        await runtime.close();
        throw new Error('Live loopback MCP server did not expose an ephemeral TCP port.');
    }
    const endpoint = `http://127.0.0.1:${address.port}/mcp`;
    let requestId = 0;
    journal.write({ kind: 'loopback-mcp-start', scenario, endpoint: '127.0.0.1:ephemeral' });

    async function call(name, args) {
        // Auth refresh can replace a Google client, so retain the same
        // re-instrument-before-call safety boundary as ctx.call().
        await guard.ensureInstrumented();
        requestId += 1;
        const started = Date.now();
        let response;
        let body;
        try {
            response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json',
                    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
                    'mcp-method': 'tools/call',
                    'mcp-name': name,
                },
                body: JSON.stringify({
                    jsonrpc: '2.0', id: requestId, method: 'tools/call',
                    params: {
                        name, arguments: args,
                        _meta: {
                            'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
                            'io.modelcontextprotocol/clientCapabilities': {},
                        },
                    },
                }),
            });
            body = await response.json();
        } catch (error) {
            journal.write({
                kind: 'loopback-mcp-call', scenario, tool: name, args: truncateDeep(args), ok: false,
                durationMs: Date.now() - started, error: error?.message || String(error),
            });
            throw error;
        }
        const result = body?.result;
        journal.write({
            kind: 'loopback-mcp-call', scenario, tool: name, args: truncateDeep(args),
            status: response.status, ok: response.ok && !result?.isError,
            durationMs: Date.now() - started, result: truncateDeep(result),
        });
        if (!response.ok || !result) {
            throw new Error(`Loopback MCP ${name} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
        }
        return result;
    }

    return Object.freeze({
        endpoint,
        call,
        async close() {
            journal.write({ kind: 'loopback-mcp-stop', scenario });
            await runtime.close();
        },
    });
}
