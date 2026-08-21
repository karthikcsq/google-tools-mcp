// MCP client configuration adapters.  They deliberately use the clients'
// own commands instead of editing private config formats.
import { exec } from 'child_process';

function defaultRun(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) reject(new Error(stderr || error.message));
            else resolve(stdout);
        });
    });
}

function shellQuote(value) {
    return /[\s"]/u.test(value) ? `"${String(value).replaceAll('"', '\\"')}"` : String(value);
}

export function launchDisplay(entry) {
    return [entry.command, ...(entry.args || [])].map(shellQuote).join(' ');
}

export function normalizeClientEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const source = entry.config && typeof entry.config === 'object' ? entry.config : entry;
    const { name, serverName, ...rest } = source;
    if (!rest.command && !rest.url) return null;
    return rest;
}

export function entriesEqual(actual, desired) {
    return JSON.stringify(normalizeClientEntry(actual)) === JSON.stringify(normalizeClientEntry(desired));
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
            catch (error) { return parseClientEntry(error.message); }
        },
        add(entry) { return run(commands.add(entry)); },
        remove() { return run(commands.remove); },
        addCommand(entry) { return commands.add(entry); },
        removeCommand: commands.remove,
    };
}

export function createClientAdapters({ run = defaultRun } = {}) {
    return [
        adapter('Codex', {
            version: 'codex --version',
            get: 'codex mcp get google --json',
            remove: 'codex mcp remove google',
            add: (entry) => `codex mcp add google -- ${launchDisplay(entry)}`,
        }, run),
        adapter('Claude Code', {
            version: 'claude --version',
            get: 'claude mcp get -s user google --json',
            remove: 'claude mcp remove -s user google',
            add: (entry) => `claude mcp add -s user google -- ${launchDisplay(entry)}`,
        }, run),
    ];
}

export async function reconcileClientEntry(adapter, desired, { confirm = async () => true, backup = async () => {} } = {}) {
    const current = await adapter.get();
    if (current.status === 'missing') {
        if (!await confirm({ action: 'add', adapter, desired })) return { ok: true, status: 'declined' };
        try { await adapter.add(desired); return { ok: true, status: 'added' }; }
        catch (error) { return { ok: false, status: 'add-failed', manualCommand: adapter.addCommand(desired), error }; }
    }
    if (current.status === 'found' && entriesEqual(current.entry, desired)) return { ok: true, status: 'unchanged', current };
    if (!await confirm({ action: 'replace', adapter, current, desired })) return { ok: true, status: 'declined', current };
    await backup(current);
    try { await adapter.remove(); }
    catch (error) { return { ok: false, status: 'remove-failed', current, manualCommand: adapter.removeCommand, error }; }
    try { await adapter.add(desired); return { ok: true, status: 'replaced', current }; }
    catch (error) {
        try {
            await adapter.add(current.entry);
            return { ok: false, status: 'add-failed-rolled-back', current, manualCommand: adapter.addCommand(desired), error };
        } catch (rollbackError) {
            return { ok: false, status: 'rollback-failed', current, manualCommand: adapter.addCommand(current.entry), error, rollbackError };
        }
    }
}
