import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildClientEntry } from './clientAdapters.js';
import { getConfigDir, getLoadedConfigKeys } from './config.js';
import { redactDiagnostic } from './errors.js';

export async function resolveDoctorTransport({ env = process.env, getHttpStatus } = {}) {
    const configured = String(env.GOOGLE_MCP_TRANSPORT || '').trim().toLowerCase();
    if (configured === 'http' || configured === 'httpstream') return 'http';
    if (configured) return 'stdio';
    const status = await getHttpStatus?.();
    return status?.healthy ? 'http' : 'stdio';
}

export async function readPersistedHttpToken({ configDir = getConfigDir(), lstat = fs.lstat, readFile = fs.readFile } = {}) {
    const tokenPath = path.join(configDir, 'http-token');
    try {
        const stat = await lstat(tokenPath);
        if (stat.isSymbolicLink() || !stat.isFile()) return null;
        return String(await readFile(tokenPath, 'utf8')).trim() || null;
    } catch {
        return null;
    }
}

export async function createDoctorDesiredEntryResolver({ launch, transport, env = process.env, configDir = getConfigDir(), lstat = fs.lstat, readFile = fs.readFile, loadedConfigKeys = env === process.env ? getLoadedConfigKeys() : [] } = {}) {
    const environmentToken = String(env.GOOGLE_MCP_HTTP_TOKEN || '').trim();
    const tokenIsInherited = Boolean(environmentToken) && !loadedConfigKeys.includes('GOOGLE_MCP_HTTP_TOKEN');
    // With GOOGLE_MCP_HTTP_NO_AUTH=1 the running server checks no bearer token,
    // so there is nothing to read from disk and nothing Codex must inherit.
    // Demanding it anyway reported a correct URL-only entry as unhealthy.
    const noAuth = Boolean(transport?.noAuth);
    const persistedToken = transport?.transport === 'http' && !noAuth && !environmentToken
        ? await readPersistedHttpToken({ configDir, lstat, readFile })
        : null;
    return (adapter) => {
        try {
            const desiredEntry = buildClientEntry(adapter.name, {
                ...transport, launch, token: environmentToken || persistedToken || transport?.token,
            });
            const problem = transport?.transport === 'http' && adapter.name === 'Codex' && !noAuth && !tokenIsInherited
                ? 'GOOGLE_MCP_HTTP_TOKEN is missing from the Codex launch environment'
                : undefined;
            return { desiredEntry, problem };
        } catch {
            return { desiredEntry: null, problem: 'recommended client entry could not be constructed' };
        }
    };
}

export function formatDoctorReport(report, json = false) {
    const safe = redactDiagnostic(report);
    if (json) return `${JSON.stringify(safe, null, 2)}\n`;
    return [safe.healthy ? 'Setup is healthy.' : 'Setup problems found:',
        ...(safe.problems || []).map(problem => `- ${problem}`),
        ...(safe.clients || []).map(client => `- ${client.client}: ${client.status}${client.raw ? ` (${client.raw})` : ''}`)].join('\n') + '\n';
}
