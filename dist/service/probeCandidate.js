// Dependency-free protocol probe for an unpacked or installed candidate.
// It intentionally exercises the executable a consumer starts, rather than
// importing the candidate's server modules into the release/update process.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const CANDIDATE_PROTOCOL_VERSION = '2026-07-28';
export const MAX_CANDIDATE_STDOUT_BYTES = 4 * 1024 * 1024;

const INHERITED_HTTP_SETTINGS = [
    'GOOGLE_MCP_HTTP_TOKEN',
    'GOOGLE_MCP_HTTP_NO_AUTH',
    'GOOGLE_MCP_HTTP_HOST',
    'GOOGLE_MCP_HTTP_ALLOWED_ORIGINS',
    'GOOGLE_MCP_PORT',
    'GOOGLE_MCP_ENDPOINT',
];

function modernRequest(id, method) {
    return `${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: {
            _meta: {
                'io.modelcontextprotocol/protocolVersion':
                    CANDIDATE_PROTOCOL_VERSION,
                'io.modelcontextprotocol/clientCapabilities': {},
            },
        },
    })}\n`;
}

function candidateError(message) {
    return new Error(`Candidate MCP probe failed: ${message}`);
}

function hasValidToolCatalog(tools) {
    return (
        Array.isArray(tools) &&
        tools.length > 0 &&
        tools.every(
            (tool) =>
                typeof tool?.name === 'string' &&
                /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tool.name),
        )
    );
}

function waitForChildExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        child.once('close', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

async function stopDirectChild(child) {
    if (!child) return;
    if (child.stdin?.writable) child.stdin.end();
    await waitForChildExit(child, 2_000);
    if (child.exitCode === null && !child.signalCode) {
        try {
            child.kill('SIGTERM');
        } catch {}
        await waitForChildExit(child, 5_000);
    }
}

/**
 * Run modern MCP discovery and tools/list through a candidate's stdio binary.
 * The caller owns `configDir`, which must be an isolated absolute directory.
 * Only this function's direct child is ever signalled during cleanup.
 */
export async function probeStdioCandidate({
    entrypoint,
    configDir,
    profile = 'candidate',
    expectedVersion = null,
    timeoutMs = 40_000,
    env = process.env,
    spawnImpl = spawn,
    nodePath = process.execPath,
} = {}) {
    if (!path.isAbsolute(String(entrypoint || ''))) {
        throw candidateError('entrypoint must be an absolute path.');
    }
    if (!path.isAbsolute(String(configDir || ''))) {
        throw candidateError('configDir must be an absolute path.');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
        throw candidateError('timeoutMs must be at least 1000 milliseconds.');
    }

    const isolatedConfigDir = path.resolve(configDir);
    await fs.mkdir(isolatedConfigDir, { recursive: true, mode: 0o700 });
    const candidateEnv = { ...env };
    for (const key of INHERITED_HTTP_SETTINGS) delete candidateEnv[key];
    Object.assign(candidateEnv, {
        CI: 'true',
        NO_UPDATE_NOTIFIER: '1',
        GOOGLE_MCP_CONFIG_DIR: isolatedConfigDir,
        GOOGLE_MCP_PROFILE: String(profile || 'candidate'),
        GOOGLE_MCP_WORKSPACE_DIR: path.join(isolatedConfigDir, 'workspace'),
        GOOGLE_MCP_TRANSPORT: 'stdio',
        GOOGLE_MCP_LOG_FILE: '0',
        GOOGLE_MCP_JSONL_FILE: '0',
        LOG_LEVEL: 'silent',
        // Older candidates use XDG_CONFIG_HOME. Newer candidates honor the
        // explicit config directory above; both stay inside the caller's root.
        XDG_CONFIG_HOME: path.join(isolatedConfigDir, 'xdg'),
    });

    let child;
    try {
        child = spawnImpl(nodePath, [path.resolve(entrypoint)], {
            cwd: isolatedConfigDir,
            env: candidateEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });

        const result = await new Promise((resolve, reject) => {
            let buffer = '';
            let totalStdoutBytes = 0;
            let expectedId = 1;
            let settled = false;
            const settle = (callback, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                callback(value);
            };
            const timer = setTimeout(() => {
                settle(
                    reject,
                    candidateError(
                        `timed out before ${expectedId === 1 ? 'server/discover' : 'tools/list'} completed.`,
                    ),
                );
            }, timeoutMs);
            const send = (id, method) => {
                try {
                    child.stdin.write(modernRequest(id, method));
                } catch {
                    settle(reject, candidateError(`could not send ${method}.`));
                }
            };

            child.once('error', () =>
                settle(
                    reject,
                    candidateError('could not start the candidate process.'),
                ),
            );
            child.stdin.once('error', () =>
                settle(
                    reject,
                    candidateError(
                        'candidate stdin closed before the protocol probe completed.',
                    ),
                ),
            );
            child.once('close', () => {
                if (!settled)
                    settle(
                        reject,
                        candidateError(
                            'candidate exited before discovery and tools/list completed.',
                        ),
                    );
            });
            child.stderr.on('data', () => {});
            child.stdout.on('data', (chunk) => {
                totalStdoutBytes += Buffer.byteLength(chunk);
                buffer += chunk.toString();
                if (totalStdoutBytes > MAX_CANDIDATE_STDOUT_BYTES) {
                    settle(
                        reject,
                        candidateError(
                            'candidate exceeded the stdout response limit.',
                        ),
                    );
                    return;
                }
                let boundary;
                while ((boundary = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, boundary).trim();
                    buffer = buffer.slice(boundary + 1);
                    if (!line || settled) continue;
                    let message;
                    try {
                        message = JSON.parse(line);
                    } catch {
                        settle(
                            reject,
                            candidateError(
                                'candidate wrote non-protocol data to stdout.',
                            ),
                        );
                        return;
                    }
                    if (message.id !== expectedId) continue;
                    if (message.error || !message.result) {
                        settle(
                            reject,
                            candidateError(
                                `${expectedId === 1 ? 'server/discover' : 'tools/list'} returned an error.`,
                            ),
                        );
                        return;
                    }
                    if (expectedId === 1) {
                        if (
                            !Array.isArray(message.result.supportedVersions) ||
                            !message.result.supportedVersions.includes(
                                CANDIDATE_PROTOCOL_VERSION,
                            )
                        ) {
                            settle(
                                reject,
                                candidateError(
                                    'server/discover did not advertise the modern protocol.',
                                ),
                            );
                            return;
                        }
                        const serverInfo =
                            message.result._meta?.[
                                'io.modelcontextprotocol/serverInfo'
                            ];
                        if (
                            expectedVersion &&
                            (serverInfo?.name !== 'google-tools-mcp' ||
                                serverInfo.version !== expectedVersion)
                        ) {
                            settle(
                                reject,
                                candidateError(
                                    'server/discover did not identify the expected package version.',
                                ),
                            );
                            return;
                        }
                        expectedId = 2;
                        send(2, 'tools/list');
                    } else if (!hasValidToolCatalog(message.result.tools)) {
                        settle(
                            reject,
                            candidateError(
                                'tools/list did not return a nonempty valid tool catalog.',
                            ),
                        );
                    } else {
                        settle(
                            resolve,
                            Object.freeze({
                                healthy: true,
                                toolCount: message.result.tools.length,
                            }),
                        );
                    }
                }
            });
            // Start only after listeners exist. stdin remains open until both
            // replies arrive, so this avoids shell pipeline EOF timing races.
            send(1, 'server/discover');
        });
        return result;
    } finally {
        await stopDirectChild(child);
    }
}
