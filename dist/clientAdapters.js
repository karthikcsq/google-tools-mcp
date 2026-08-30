// MCP client configuration adapters.  They deliberately use the clients'
// own commands instead of editing private config formats.
//
// Every command is an argv array. Nothing here is ever executed as a shell
// string: `GOOGLE_MCP_ENDPOINT` alone allows `;`, and launch paths, env values,
// and URLs all come from config files, so a rendered command line would let a
// legitimate value split into a second command. The `*Command` accessors exist
// only to show or hand a human something to paste.
import { formatShellCommand, runArgv, shellQuote } from './shellSafe.js';

export const CODEX_MCP_PROTOCOL_VERSION = '2026-07-28';
export const CODEX_HTTP_TOKEN_ENV_VAR = 'GOOGLE_MCP_HTTP_TOKEN';

function defaultRun(argv) {
    return runArgv(argv);
}

export function launchDisplay(entry) {
    return formatShellCommand([entry.command, ...(entry.args || [])]);
}

// The fields a google-tools-mcp registration is allowed to carry. Everything
// else a client reports about itself is its own bookkeeping.
const SUPPORTED_ENTRY_FIELDS = ['command', 'args', 'env', 'url', 'bearer_token_env_var', 'headers'];

// Current Codex serializes both stdio and HTTP settings under a nested
// `transport` object and surrounds it with its own metadata (`enabled`, startup
// and tool timeouts, tool filters, and a `type` discriminator). See
// https://github.com/openai/codex/blob/41ab01a2eaff4d4c0fc88d56a0027d1244c33e82/codex-rs/cli/src/mcp_cmd.rs
// Without this step neither `command` nor `url` exists at the top level, so a
// correct entry normalized to null and never compared equal: setup offered to
// remove and re-add it on every run, and doctor called it different forever.
function flattenNestedTransport(source) {
    const transport = source?.transport;
    if (!transport || typeof transport !== 'object' || Array.isArray(transport)) return source;
    const merged = {};
    for (const key of SUPPORTED_ENTRY_FIELDS) {
        const value = Object.hasOwn(transport, key) ? transport[key]
            : Object.hasOwn(source, key) ? source[key] : undefined;
        // `bearer_token_env_var: null` is how Codex spells "no bearer token" on
        // a URL-only registration, which is the same thing as absent.
        if (value !== undefined && value !== null) merged[key] = value;
    }
    return merged;
}

export function normalizeClientEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const source = entry.config && typeof entry.config === 'object' ? entry.config : entry;
    const { name, serverName, token, ...rest } = flattenNestedTransport(source);
    if (!rest.command && !rest.url) return null;
    return rest;
}

export function entriesEqual(actual, desired) {
    return deeplyEqual(normalizeClientEntry(actual), normalizeClientEntry(desired));
}

function deeplyEqual(left, right) {
    if (Object.is(left, right)) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
            left.every((value, index) => deeplyEqual(value, right[index]));
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length &&
        leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && deeplyEqual(left[key], right[key]));
}

export function parseClientEntry(output) {
    const text = String(output || '').trim();
    if (!text) return { status: 'missing' };
    for (const candidate of [text, ...text.split('\n').map(line => line.trim()).filter(Boolean).reverse()]) {
        try {
            const parsed = JSON.parse(candidate);
            return { status: 'found', entry: normalizeClientEntry(parsed), raw: text };
        } catch {}
    }
    if (/not found|no.*server|does not exist/i.test(text)) return { status: 'missing', raw: text };
    return { status: 'unknown', raw: text };
}

function adapter(name, commands, run = defaultRun) {
    return {
        name,
        async detect() {
            try { await run(commands.version); return true; } catch { return false; }
        },
        async get() {
            try { return parseClientEntry(await run(commands.get)); }
            catch (error) { return { status: 'unknown', raw: String(error?.message || error || 'Client inspection failed.') }; }
        },
        add(entry) { return run(commands.add(entry, { redact: false })); },
        remove() { return run(commands.remove); },
        // argv accessors are what gets executed; *Command accessors are display only.
        addArgv(entry, options = {}) { return commands.add(entry, options); },
        addCommand(entry, options = {}) { return formatShellCommand(commands.add(entry, options)); },
        getArgv: commands.get,
        removeArgv: commands.remove,
        getCommand: formatShellCommand(commands.get),
        removeCommand: formatShellCommand(commands.remove),
    };
}

export function createClientAdapters({ run = defaultRun } = {}) {
    return [
        adapter('Codex', {
            version: ['codex', '--version'],
            get: ['codex', 'mcp', 'get', 'google', '--json'],
            remove: ['codex', 'mcp', 'remove', 'google'],
            add: (entry) => entry.url
                ? ['codex', 'mcp', 'add', 'google', '--url', entry.url,
                    // A no-auth loopback registration has no bearer token to name.
                    ...(entry.bearer_token_env_var ? ['--bearer-token-env-var', entry.bearer_token_env_var] : [])]
                : ['codex', 'mcp', 'add', 'google',
                    ...Object.entries(entry.env || {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
                    '--', entry.command, ...(entry.args || [])],
        }, run),
        adapter('Claude Code', {
            version: ['claude', '--version'],
            get: ['claude', 'mcp', 'get', '-s', 'user', 'google', '--json'],
            remove: ['claude', 'mcp', 'remove', '-s', 'user', 'google'],
            add: (entry, { redact = false } = {}) => entry.url
                ? ['claude', 'mcp', 'add', '-s', 'user', '--transport', 'http', 'google', entry.url,
                    ...(entry.headers?.Authorization
                        ? ['--header', `Authorization: Bearer ${redact ? '[REDACTED]' : entry.headers.Authorization.replace(/^Bearer\s+/i, '')}`]
                        : [])]
                : ['claude', 'mcp', 'add', '-s', 'user', 'google', '--', entry.command, ...(entry.args || [])],
        }, run),
    ];
}

export function buildClientEntry(clientName, { transport = 'stdio', launch, url, token, noAuth = false } = {}) {
    if (transport === 'http') {
        if (!url) throw new TypeError('HTTP client registration requires a URL.');
        // GOOGLE_MCP_HTTP_NO_AUTH=1 is a supported loopback mode. There is no
        // authentication value for a client to carry, so requiring one would
        // make a valid running configuration impossible to converge on.
        if (clientName === 'Codex') {
            return noAuth ? { url } : { url, bearer_token_env_var: CODEX_HTTP_TOKEN_ENV_VAR };
        }
        if (clientName === 'Claude Code') {
            if (noAuth) return { type: 'http', url };
            if (!token) throw new TypeError('Claude Code HTTP registration requires a bearer token.');
            return { type: 'http', url, headers: { Authorization: `Bearer ${token}` } };
        }
        if (noAuth) return { url };
        return { url, headers: token ? { Authorization: `Bearer ${token}` } : undefined };
    }
    if (!launch?.command) throw new TypeError('stdio client registration requires a launch command.');
    return {
        command: launch.command,
        args: launch.args || [],
        ...(clientName === 'Codex' ? { env: { CODEX_MCP_PROTOCOL_VERSION } } : {}),
    };
}

/**
 * Render the instruction that puts the bearer token into Codex's launch
 * environment WITHOUT rendering the token itself. Issue #83 required the
 * generated fixed token to be stored with restrictive permissions and never
 * printed; setup already knows the private file it lives in, so the command
 * reads that file instead of putting its bytes into terminal scrollback.
 */
export function codexTokenEnvironmentCommand({ tokenPath, platform = process.platform } = {}) {
    if (!tokenPath) {
        const comment = platform === 'win32' ? 'REM' : '#';
        return `${comment} Set ${CODEX_HTTP_TOKEN_ENV_VAR} in the environment Codex launches from. Its value is deliberately not printed here.`;
    }
    return platform === 'win32'
        ? `setx ${CODEX_HTTP_TOKEN_ENV_VAR} ((Get-Content -Raw ${shellQuote(tokenPath, platform)}).Trim())`
        : `export ${CODEX_HTTP_TOKEN_ENV_VAR}="$(cat ${shellQuote(tokenPath, platform)})"`;
}

function replacementCommand(adapter, entry, options = {}) {
    return `${adapter.removeCommand}\n${adapter.addCommand(entry, options)}`;
}

export async function reconcileClientEntry(adapter, desired, { confirm = async () => true, backup = async () => {}, tokenPath = null, noAuth = false } = {}) {
    const current = await adapter.get();
    if (current.status === 'unknown') return { ok: false, status: 'unknown', current, manualCommand: adapter.getCommand || 'Re-run setup after the client entry can be inspected.' };
    if (current.status === 'found' && entriesEqual(current.entry, desired)) return { ok: true, status: 'unchanged', current };
    // Codex can name a bearer-token environment variable in its registration
    // but cannot store the value, so an authenticated HTTP setup needs one
    // manual step. With authentication disabled there is no value to place, and
    // the URL-only entry is added like any other.
    if (adapter.name === 'Codex' && desired.url && !noAuth) {
        const registration = [
            ...(current.status === 'found' ? [adapter.removeCommand] : []),
            adapter.addCommand(desired, { redact: true }),
        ].join('\n');
        return { ok: false, status: 'unsupported-http-auth', current,
            explanation: 'Codex HTTP registrations can name a bearer-token environment variable, but cannot store that variable value in the registration.',
            manualCommand: `${codexTokenEnvironmentCommand({ tokenPath })}\n${registration}` };
    }
    if (current.status === 'missing') {
        if (!await confirm({ action: 'add', adapter, desired })) return { ok: false, status: 'declined', manualCommand: adapter.addCommand(desired, { redact: true }) };
        try { await adapter.add(desired); return { ok: true, status: 'added' }; }
        catch (error) { return { ok: false, status: 'add-failed', manualCommand: adapter.addCommand(desired, { redact: true }), error }; }
    }
    if (!await confirm({ action: 'replace', adapter, current, desired })) return { ok: false, status: 'declined', current, manualCommand: replacementCommand(adapter, desired, { redact: true }) };
    await backup(current);
    try { await adapter.remove(); }
    catch (error) { return { ok: false, status: 'remove-failed', current, manualCommand: replacementCommand(adapter, desired, { redact: true }), error }; }
    try { await adapter.add(desired); return { ok: true, status: 'replaced', current }; }
    catch (error) {
        try {
            await adapter.add(current.entry);
            return { ok: false, status: 'add-failed-rolled-back', current, manualCommand: replacementCommand(adapter, desired, { redact: true }), error };
        } catch (rollbackError) {
            return { ok: false, status: 'rollback-failed', current, manualCommand: replacementCommand(adapter, desired, { redact: true }), error, rollbackError };
        }
    }
}
