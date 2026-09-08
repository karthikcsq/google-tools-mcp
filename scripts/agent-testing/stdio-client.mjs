import { PROTOCOL_VERSION } from './common.mjs';

export class StdioRpcClient {
    constructor(child, { timeoutMs = 30_000 } = {}) {
        this.child = child;
        this.timeoutMs = timeoutMs;
        this.nextId = 1;
        this.pending = new Map();
        this.buffer = '';
        this.protocolFailures = [];
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => this.#onData(chunk));
        child.once('exit', (code, signal) => this.#failAll(new Error(`MCP stdio server exited (${code ?? signal ?? 'unknown'}).`)));
        child.once('error', (error) => this.#failAll(error));
    }

    #onData(chunk) {
        this.buffer += chunk;
        for (;;) {
            const lineEnd = this.buffer.indexOf('\n');
            if (lineEnd < 0) return;
            const line = this.buffer.slice(0, lineEnd).trim();
            this.buffer = this.buffer.slice(lineEnd + 1);
            if (!line) continue;
            let message;
            try { message = JSON.parse(line); }
            catch {
                const error = new Error('MCP stdio server wrote malformed JSON to stdout.');
                this.protocolFailures.push({ line: line.slice(0, 500), error: error.message });
                this.#failAll(error);
                return;
            }
            const pending = this.pending.get(message.id);
            if (!pending) continue;
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            pending.resolve(message);
        }
    }

    #failAll(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    request(method, params = {}) {
        const id = this.nextId++;
        const payload = {
            jsonrpc: '2.0', id, method,
            params: { ...params, _meta: {
                'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
                'io.modelcontextprotocol/clientCapabilities': {},
            } },
        };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP stdio request timed out after ${this.timeoutMs}ms: ${method}`));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
                if (!error) return;
                const pending = this.pending.get(id);
                if (!pending) return;
                this.pending.delete(id); clearTimeout(timer); reject(error);
            });
        });
    }

    discover() { return this.request('server/discover'); }
    listTools() { return this.request('tools/list'); }
    callTool(name, args) { return this.request('tools/call', { name, arguments: args }); }

    async close() {
        this.child.stdin.end();
        if (this.child.exitCode !== null) return;
        await new Promise((resolve) => {
            const timer = setTimeout(() => { this.child.kill(); resolve(); }, 3_000);
            this.child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
    }
}
