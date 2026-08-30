import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    Protocol,
    parseJSONRPCMessage,
} from '@modelcontextprotocol/server';
import { MCP_PROTOCOL_VERSION } from './mcpServer.js';

const CLIENT_INFO = Object.freeze({ name: 'google-tools-mcp-operations', version: '1' });

/**
 * A one-request-per-POST transport for the SDK's Protocol client primitive.
 * It owns generic JSON-RPC framing only; discovery result decoding and schema
 * validation remain inside the SDK Protocol implementation.
 */
export class ModernHttpClientTransport {
    constructor(url, { token, fetchImpl = globalThis.fetch, timeoutMs = 5_000 } = {}) {
        this.url = String(url);
        this.token = token;
        this.fetchImpl = fetchImpl;
        this.timeoutMs = timeoutMs;
        this.hasPerRequestStream = true;
        this.closed = false;
        this.onclose = undefined;
        this.onerror = undefined;
        this.onmessage = undefined;
    }

    async start() {}

    async send(message, options = {}) {
        if (this.closed) throw new Error('HTTP MCP client transport is closed.');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const abort = () => controller.abort();
        options.requestSignal?.addEventListener('abort', abort, { once: true });
        try {
            const headers = {
                accept: 'application/json, text/event-stream',
                'content-type': 'application/json',
                'mcp-method': message.method || '',
                'mcp-protocol-version': MCP_PROTOCOL_VERSION,
                ...(message.method === 'tools/call' && message.params?.name
                    ? { 'mcp-name': String(message.params.name) } : {}),
                ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
                ...(options.headers || {}),
            };
            const response = await this.fetchImpl(this.url, {
                method: 'POST', headers, body: JSON.stringify(message), signal: controller.signal,
            });
            const text = await response.text();
            if (!text) {
                if (!response.ok) throw new Error(`HTTP MCP request failed with status ${response.status}.`);
                return;
            }
            let parsed;
            try { parsed = JSON.parse(text); }
            catch { throw new Error(`HTTP MCP response was not JSON (status ${response.status}).`); }
            const incoming = parseJSONRPCMessage(parsed);
            this.onmessage?.(incoming);
        } finally {
            clearTimeout(timer);
            options.requestSignal?.removeEventListener('abort', abort);
        }
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        this.onclose?.();
    }
}

/** Minimal modern client role built on the installed official SDK Protocol. */
export class ModernMcpClient extends Protocol {
    constructor({ clientInfo = CLIENT_INFO } = {}) {
        super({ supportedProtocolVersions: [MCP_PROTOCOL_VERSION] });
        this.clientInfo = clientInfo;
    }

    buildContext(context) { return context; }
    assertCapabilityForMethod() {}
    assertNotificationCapability() {}
    assertRequestHandlerCapability() {}
    _outboundMetaEnvelope() {
        return {
            [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
            [CLIENT_INFO_META_KEY]: this.clientInfo,
            [CLIENT_CAPABILITIES_META_KEY]: {},
        };
    }

    discover(options) { return this.request({ method: 'server/discover', params: {} }, options); }
    listTools(options) { return this.request({ method: 'tools/list', params: {} }, options); }
    callTool(name, args = {}, options) {
        return this.request(
            { method: 'tools/call', params: { name, arguments: args } },
            { ...options, headers: { ...(options?.headers || {}), 'mcp-name': name } },
        );
    }
}

export async function connectModernHttpClient(url, options = {}) {
    const transport = new ModernHttpClientTransport(url, options);
    const client = new ModernMcpClient(options);
    await client.connect(transport);
    return client;
}
