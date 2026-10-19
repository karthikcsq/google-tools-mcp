import { describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
    CANDIDATE_PROTOCOL_VERSION,
    MAX_CANDIDATE_STDOUT_BYTES,
    probeStdioCandidate,
} from '../dist/service/probeCandidate.js';

jest.setTimeout(60_000);

const ENTRYPOINT = fileURLToPath(new URL('../dist/index.js', import.meta.url));

class FakeCandidate extends EventEmitter {
    constructor({
        tools = [{ name: 'one' }, { name: 'two' }],
        serverInfo = null,
    } = {}) {
        super();
        this.exitCode = null;
        this.signalCode = null;
        this.stdin = new PassThrough();
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.stdin.on('data', (chunk) => {
            const request = JSON.parse(chunk.toString());
            if (request.id === 1) {
                this.stdout.write(
                    `${JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        result: {
                            supportedVersions: [CANDIDATE_PROTOCOL_VERSION],
                            ...(serverInfo
                                ? {
                                      _meta: {
                                          'io.modelcontextprotocol/serverInfo':
                                              serverInfo,
                                      },
                                  }
                                : {}),
                        },
                    })}\n`,
                );
            }
            if (request.id === 2) {
                this.stdout.write(
                    `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools } })}\n`,
                );
            }
        });
        this.stdin.once('end', () => {
            this.exitCode = 0;
            this.emit('close', 0, null);
        });
    }

    kill(signal) {
        this.signalCode = signal;
        this.emit('close', null, signal);
        return true;
    }
}

describe('packed candidate stdio probe', () => {
    it('sanitizes inherited HTTP settings and verifies discovery then tools/list through stdio', async () => {
        const root = await fs.mkdtemp(
            path.join(os.tmpdir(), 'google-tools-mcp-probe-unit-'),
        );
        try {
            let spawnOptions;
            const spawnImpl = jest.fn((_nodePath, _args, options) => {
                spawnOptions = options;
                return new FakeCandidate();
            });
            const result = await probeStdioCandidate({
                entrypoint: path.join(root, 'candidate', 'dist', 'index.js'),
                configDir: path.join(root, 'isolated-config'),
                env: {
                    GOOGLE_MCP_HTTP_TOKEN: 'must-not-reach-candidate',
                    GOOGLE_MCP_HTTP_NO_AUTH: '1',
                    GOOGLE_MCP_PORT: '9999',
                },
                spawnImpl,
            });

            expect(result).toEqual({ healthy: true, toolCount: 2 });
            expect(spawnOptions.cwd).toBe(path.join(root, 'isolated-config'));
            expect(spawnOptions.env).toMatchObject({
                GOOGLE_MCP_CONFIG_DIR: path.join(root, 'isolated-config'),
                GOOGLE_MCP_PROFILE: 'candidate',
                GOOGLE_MCP_TRANSPORT: 'stdio',
                GOOGLE_MCP_WORKSPACE_DIR: path.join(
                    root,
                    'isolated-config',
                    'workspace',
                ),
                GOOGLE_MCP_LOG_FILE: '0',
                GOOGLE_MCP_JSONL_FILE: '0',
            });
            expect(spawnOptions.env.GOOGLE_MCP_HTTP_TOKEN).toBeUndefined();
            expect(spawnOptions.env.GOOGLE_MCP_HTTP_NO_AUTH).toBeUndefined();
            expect(spawnOptions.env.GOOGLE_MCP_PORT).toBeUndefined();
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('runs discovery and tools/list against the actual candidate entrypoint with stdin open', async () => {
        const root = await fs.mkdtemp(
            path.join(os.tmpdir(), 'google-tools-mcp-probe-live-'),
        );
        try {
            const expectedVersion = JSON.parse(
                await fs.readFile(
                    new URL('../package.json', import.meta.url),
                    'utf8',
                ),
            ).version;
            const result = await probeStdioCandidate({
                entrypoint: ENTRYPOINT,
                configDir: path.join(root, 'isolated-config'),
                expectedVersion,
                timeoutMs: 40_000,
            });
            expect(result.healthy).toBe(true);
            expect(result.toolCount).toBe(160);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('bounds total stdout even when each complete notification is small', async () => {
        const root = await fs.mkdtemp(
            path.join(os.tmpdir(), 'google-tools-mcp-probe-noise-'),
        );
        try {
            const candidate = new FakeCandidate();
            candidate.stdin.removeAllListeners('data');
            candidate.stdin.on('data', () => {
                const line =
                    JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'notifications/log',
                        params: { message: 'x'.repeat(65536) },
                    }) + String.fromCharCode(10);
                for (
                    let bytes = 0;
                    bytes <= MAX_CANDIDATE_STDOUT_BYTES;
                    bytes += Buffer.byteLength(line)
                ) {
                    candidate.stdout.write(line);
                }
            });
            await expect(
                probeStdioCandidate({
                    entrypoint: path.join(root, 'index.js'),
                    configDir: path.join(root, 'config'),
                    spawnImpl: () => candidate,
                }),
            ).rejects.toThrow(/stdout response limit/);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('rejects an empty catalog and a discovery result that does not identify the expected version', async () => {
        const root = await fs.mkdtemp(
            path.join(os.tmpdir(), 'google-tools-mcp-probe-reject-'),
        );
        const base = {
            entrypoint: path.join(root, 'candidate', 'dist', 'index.js'),
            configDir: path.join(root, 'config'),
        };
        try {
            await expect(
                probeStdioCandidate({
                    ...base,
                    spawnImpl: () => new FakeCandidate({ tools: [] }),
                }),
            ).rejects.toThrow(/nonempty valid tool catalog/);
            await expect(
                probeStdioCandidate({
                    ...base,
                    expectedVersion: '9.9.9',
                    spawnImpl: () =>
                        new FakeCandidate({
                            serverInfo: {
                                name: 'google-tools-mcp',
                                version: '0.0.0',
                            },
                        }),
                }),
            ).rejects.toThrow(/expected package version/);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});
