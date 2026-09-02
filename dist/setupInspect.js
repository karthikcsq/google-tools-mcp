// Read-only setup inspection.  Do not call authorize(): it refreshes and saves
// tokens, which would make doctor and returning-user detection destructive.
import * as fs from 'fs/promises';
import * as path from 'path';
import { OAuth2Client } from 'google-auth-library';
import { getConfigDir, getConfigFiles, getConfigWarnings } from './config.js';
import { getTokenPath, loadClientSecrets, SCOPES } from './auth.js';
import { CODEX_MCP_PROTOCOL_VERSION, entriesEqual } from './clientAdapters.js';
import { getHttpServiceStatus } from './httpLifecycle.js';

// dist/auth.js checks SERVICE_ACCOUNT_PATH before anything OAuth, so a
// service-account installation is a first-class, fully supported runtime
// configuration with no client secrets and no token.json. Inspection has to
// follow the same branch, otherwise doctor calls a working install broken and
// setup routes the operator into an OAuth wizard they do not need.
export function resolveAuthSource(env = process.env) {
    return String(env.SERVICE_ACCOUNT_PATH || '').trim() ? 'service-account' : 'oauth';
}

// Read-only, like every other check here: the key file is parsed and shape-
// checked, never used to mint a token. Problems are fixed strings rather than
// interpolated error text, so nothing from the filesystem reaches the report.
export async function inspectServiceAccount({ env = process.env, readFile = fs.readFile } = {}) {
    const keyPath = String(env.SERVICE_ACCOUNT_PATH || '').trim();
    const impersonateUser = String(env.GOOGLE_IMPERSONATE_USER || '').trim() || undefined;
    const base = { source: 'service-account', path: keyPath, impersonateUser };
    try {
        const key = JSON.parse(await readFile(keyPath, 'utf8'));
        if (!key?.client_email || !key?.private_key) {
            return { ...base, healthy: false, problem: 'service account key file has no client_email/private_key' };
        }
        return { ...base, healthy: true, clientEmail: key.client_email };
    } catch (error) {
        return { ...base, healthy: false, problem: error?.code === 'ENOENT'
            ? 'service account key file not found at SERVICE_ACCOUNT_PATH'
            : 'service account key file could not be read or parsed' };
    }
}

export async function checkCredentials({ load = loadClientSecrets, env = process.env, readFile = fs.readFile } = {}) {
    if (resolveAuthSource(env) === 'service-account') {
        const serviceAccount = await inspectServiceAccount({ env, readFile });
        return { configured: serviceAccount.healthy, source: 'service-account', serviceAccount, problem: serviceAccount.problem };
    }
    try { await load(); return { configured: true, source: 'oauth' }; }
    catch { return { configured: false, source: 'oauth' }; }
}

export async function inspectToken({ tokenPath = getTokenPath(), readFile = fs.readFile, OAuth2 = OAuth2Client, credentialsLoader = loadClientSecrets, env = process.env } = {}) {
    // There is no OAuth token in a service-account installation, and reading or
    // refreshing one would be meaningless rather than merely absent.
    if (resolveAuthSource(env) === 'service-account') return { status: 'not-applicable', source: 'service-account' };
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

const PACKAGE_BIN = /^google-tools-mcp(?:\.(?:cmd|exe|ps1))?$/i;
const NPX_BIN = /^npx(?:\.cmd|\.exe|\.ps1)?$/i;
const NPX_PACKAGE_ARG = /^google-tools-mcp(?:@[^\s]+)?$/;
const PACKAGE_INDEX = /[\\/]google-tools-mcp[\\/]dist[\\/]index\.js$/i;
const ANY_DIST_INDEX = /[\\/]dist[\\/]index\.js$/i;

/**
 * Does this stdio entry start google-tools-mcp, by any of the ways the README
 * documents? The recommended entry is `<node> <this install's dist/index.js>`,
 * which is what setup writes, but the README also gives the bare
 * `google-tools-mcp` bin, `npx -y google-tools-mcp`, a hand-resolved absolute
 * path to either, and `<node> /path/to/a/clone/dist/index.js`. Every one of
 * those runs this server. The clone case is recognised by the package.json
 * two directories up naming this package, read with the injectable `readFile`.
 */
export async function launchesThisPackage(entry, { readFile = fs.readFile } = {}) {
    if (!entry || typeof entry !== 'object' || entry.url || typeof entry.command !== 'string') return false;
    const command = path.basename(entry.command);
    const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    if (PACKAGE_BIN.test(command)) return true;
    if (NPX_BIN.test(command)) return args.some(arg => NPX_PACKAGE_ARG.test(arg));
    for (const arg of args) {
        if (PACKAGE_INDEX.test(arg)) return true;
        if (!ANY_DIST_INDEX.test(arg) || !path.isAbsolute(arg)) continue;
        try {
            const manifest = JSON.parse(await readFile(path.join(path.dirname(path.dirname(arg)), 'package.json'), 'utf8'));
            if (manifest?.name === 'google-tools-mcp') return true;
        } catch {
            // Not readable or not JSON: not a clone of this package that we can vouch for.
        }
    }
    return false;
}

/**
 * Why a found entry is not the recommended one, sorted into a `problem` (the
 * registration will not work, or not the way the docs promise) or a `note`
 * (it works, it is just not what setup would have written). Doctor used to
 * call every difference a problem and exit 1, which made it report a
 * README-documented registration as broken, and made `npx -y google-tools-mcp
 * doctor` fail against the very entry `npx -y google-tools-mcp setup` had just
 * written, because "recommended" is computed from whichever copy of the
 * package happens to be running doctor.
 */
export async function describeEntryDifference(clientName, current, recommended, { readFile = fs.readFile } = {}) {
    // HTTP registrations carry the URL and the token; a difference there is a
    // difference in what the client talks to, so it stays a problem.
    if (recommended?.url || current?.url) return { problem: 'entry differs from recommended configuration' };
    if (!(await launchesThisPackage(current, { readFile }))) return { problem: 'entry differs from recommended configuration' };
    if (clientName === 'Codex' && recommended?.env?.CODEX_MCP_PROTOCOL_VERSION
        && current?.env?.CODEX_MCP_PROTOCOL_VERSION !== recommended.env.CODEX_MCP_PROTOCOL_VERSION) {
        return { problem: `Codex stdio registration needs CODEX_MCP_PROTOCOL_VERSION=${CODEX_MCP_PROTOCOL_VERSION} in its env block` };
    }
    const viaNpx = NPX_BIN.test(path.basename(String(current.command)));
    return { note: viaNpx
        ? 'launches google-tools-mcp through npx, which re-resolves dependencies on every start; run setup to switch to a direct node launch'
        : 'launches google-tools-mcp, but not through the entry setup would write; run setup to converge if you want that' };
}

export async function checkClientEntry(adapter, desired) {
    const current = await adapter.get();
    if (current.status === 'missing') return { adapter: adapter.name, status: desired ? 'problem' : 'missing', problem: desired ? 'missing client entry' : undefined, recommended: desired };
    if (current.status === 'unknown') return { adapter: adapter.name, status: desired ? 'problem' : 'unknown', problem: desired ? 'unrecognized client entry' : undefined, raw: current.raw, recommended: desired };
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

export async function inspectSetup({ adapters = [], desiredEntry = null, desiredEntries = null, inspectHttp = getHttpServiceStatus, httpExpected = false, credentialsCheck = checkCredentials, tokenCheck = inspectToken, configWarnings = getConfigWarnings() } = {}) {
    const credentials = await credentialsCheck();
    const token = await tokenCheck();
    const clients = [];
    for (const adapter of adapters) {
        if (!await adapter.detect()) continue;
        const current = await adapter.get();
        const expectsRecommended = desiredEntry !== null || desiredEntries !== null;
        const desiredResult = typeof desiredEntries === 'function' ? desiredEntries(adapter) : (desiredEntries?.[adapter.name] || desiredEntry);
        const wrappedDesired = desiredResult && typeof desiredResult === 'object' && Object.hasOwn(desiredResult, 'desiredEntry');
        const recommended = wrappedDesired ? desiredResult.desiredEntry : desiredResult;
        const desiredProblem = wrappedDesired ? desiredResult.problem : (expectsRecommended && !recommended ? 'recommended client entry could not be constructed' : undefined);
        if (current.status === 'found') {
            const target = await checkLaunchTarget(current.entry);
            const matchesRecommended = recommended ? entriesEqual(current.entry, recommended) : undefined;
            const difference = matchesRecommended === false ? await describeEntryDifference(adapter.name, current.entry, recommended) : {};
            const problem = desiredProblem || target.problem || difference.problem;
            clients.push({ client: adapter.name, status: problem ? 'problem' : 'configured', problem, note: difference.note, entry: current.entry,
                matchesRecommended, recommended });
        } else {
            const problem = desiredProblem || (recommended ? (current.status === 'missing' ? 'missing client entry' : 'unrecognized client entry') : undefined);
            clients.push({ client: adapter.name, status: problem ? 'problem' : current.status, problem, raw: current.raw, recommended });
        }
    }
    // The caller already knows the effective transport before any client is
    // detected -- dist/index.js resolves it via resolveDoctorTransport()
    // ahead of calling inspectSetup(). Gating the HTTP health check purely on
    // "does a currently-detected client happen to have a url entry" meant a
    // persisted GOOGLE_MCP_TRANSPORT=http install reported healthy without
    // ever checking the shared service when no supported client CLI was
    // installed on the machine running `doctor` (finding 20): zero detected
    // clients means an empty `clients` array, so `.some()` is vacuously
    // false regardless of what transport is actually configured.
    const usesHttp = httpExpected || clients.some(client => client.entry?.url);
    const http = usesHttp ? await inspectHttp() : null;
    const problems = [
        ...(credentials.configured ? [] : [credentials.source === 'service-account'
            ? `Service account: ${credentials.problem || 'not usable'}`
            : 'OAuth credentials are not configured']),
        ...(token.status === 'valid' || token.status === 'not-applicable' ? [] : [`OAuth token: ${token.status}`]),
        ...clients.filter(client => client.status === 'problem' || client.status === 'unknown').map(client => `${client.client}: ${client.problem || 'could not inspect entry'}`),
        ...(http && !http.healthy ? [`Shared HTTP service: ${http.diagnostic}`] : []),
        ...configWarnings.map(warning => `Config: ${warning}`),
    ];
    return { healthy: problems.length === 0, credentials, token, clients, http, config: { ...configLocations(), warnings: configWarnings }, problems };
}
