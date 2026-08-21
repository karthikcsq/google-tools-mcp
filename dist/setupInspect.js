// Read-only setup inspection.  Do not call authorize(): it refreshes and saves
// tokens, which would make doctor and returning-user detection destructive.
import * as fs from 'fs/promises';
import * as path from 'path';
import { google } from 'googleapis';
import { getConfigDir, getConfigFiles } from './config.js';
import { getTokenPath, loadClientSecrets, SCOPES } from './auth.js';
import { entriesEqual } from './clientAdapters.js';

export async function checkCredentials({ load = loadClientSecrets } = {}) {
    try { await load(); return { configured: true }; }
    catch { return { configured: false }; }
}

export async function inspectToken({ tokenPath = getTokenPath(), readFile = fs.readFile, OAuth2 = google.auth.OAuth2, credentialsLoader = loadClientSecrets } = {}) {
    let token;
    try { token = JSON.parse(await readFile(tokenPath, 'utf8')); }
    catch (error) { return { status: error?.code === 'ENOENT' ? 'missing' : 'invalid' }; }
    if (!Array.isArray(token.scopes)) return { status: 'scope-mismatch', missingScopes: [...SCOPES] };
    const missingScopes = SCOPES.filter(scope => !token.scopes.includes(scope));
    if (missingScopes.length) return { status: 'scope-mismatch', missingScopes };
    if (!token.refresh_token) return { status: 'invalid', reason: 'missing refresh token' };
    try {
        const secrets = await credentialsLoader();
        const client = new OAuth2(secrets.client_id, secrets.client_secret);
        client.setCredentials(token);
        await client.refreshAccessToken();
        return { status: 'valid' };
    } catch {
        return { status: 'refresh-failed' };
    }
}

export function checkLaunchTarget(entry, { exists = (target) => fs.access(target).then(() => true).catch(() => false) } = {}) {
    const joined = [entry?.command, ...(entry?.args || [])].join(' ');
    if (/\bnpx\b.*@latest\b/i.test(joined)) return { healthy: false, problem: 'moving npm @latest target' };
    if (entry?.command && path.isAbsolute(entry.command)) return Promise.resolve(exists(entry.command)).then(ok => ok ? { healthy: true } : { healthy: false, problem: `missing executable: ${entry.command}` });
    if (entry?.args?.[0] && path.isAbsolute(entry.args[0])) return Promise.resolve(exists(entry.args[0])).then(ok => ok ? { healthy: true } : { healthy: false, problem: `missing launch path: ${entry.args[0]}` });
    return { healthy: true };
}

export async function checkClientEntry(adapter, desired) {
    const current = await adapter.get();
    if (current.status === 'missing') return { adapter: adapter.name, status: 'missing' };
    if (current.status === 'unknown') return { adapter: adapter.name, status: 'unknown', raw: current.raw };
    const target = await checkLaunchTarget(current.entry);
    return { adapter: adapter.name, status: entriesEqual(current.entry, desired) && target.healthy ? 'healthy' : 'different', current, target };
}

export function configLocations() { return { configDir: getConfigDir(), files: getConfigFiles() }; }

export async function checkGlobalInstall({ run, access = fs.access } = {}) {
    if (!run) return { status: 'unknown' };
    try {
        const root = String(await run('npm root -g')).trim();
        const indexPath = path.join(root, 'google-tools-mcp', 'dist', 'index.js');
        await access(indexPath);
        return { status: 'current', indexPath };
    } catch {
        return { status: 'missing' };
    }
}

export async function inspectSetup({ adapters = [], desiredEntry = null } = {}) {
    const credentials = await checkCredentials();
    const token = await inspectToken();
    const clients = [];
    for (const adapter of adapters) {
        if (!await adapter.detect()) continue;
        const current = await adapter.get();
        if (current.status === 'found') {
            const target = await checkLaunchTarget(current.entry);
            clients.push({ client: adapter.name, status: target.healthy ? 'configured' : 'problem', problem: target.problem, entry: current.entry,
                matchesRecommended: desiredEntry ? entriesEqual(current.entry, desiredEntry) : undefined });
        } else clients.push({ client: adapter.name, status: current.status, raw: current.raw });
    }
    const problems = [
        ...(credentials.configured ? [] : ['OAuth credentials are not configured']),
        ...(token.status === 'valid' ? [] : [`OAuth token: ${token.status}`]),
        ...clients.filter(client => client.status === 'problem' || client.status === 'unknown').map(client => `${client.client}: ${client.problem || 'could not inspect entry'}`),
    ];
    return { healthy: problems.length === 0, credentials, token, clients, config: configLocations(), problems };
}
