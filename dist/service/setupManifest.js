// Owned setup metadata for diagnostics and upgrade reconciliation. This file
// records selections and paths only, never OAuth material or HTTP tokens.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const FILE_NAME = 'http-setup-manifest.json';
const BACKUP_DIRECTORY = 'setup-reconcile-backups';

function normalizeClient(value) {
    const name = String(value || '').toLowerCase().replace(/[^a-z]/g, '');
    if (name === 'codex') return 'codex';
    if (name === 'claude' || name === 'claudecode') return 'claude';
    throw new Error(`Unsupported setup client: ${value}`);
}

export function getSetupManifestPath(configDir) {
    if (!path.isAbsolute(String(configDir || ''))) throw new Error('Setup manifest requires an absolute config directory.');
    return path.join(path.resolve(configDir), FILE_NAME);
}

function normalizeManifest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Setup manifest is invalid.');
    const profile = String(value.profile || '').trim();
    const transport = String(value.transport || '').trim();
    const selectedClients = Array.isArray(value.selectedClients) ? [...new Set(value.selectedClients.map(normalizeClient))] : [];
    // `null` records either stdio or a historical/manual HTTP registration.
    // A non-empty identity is written only by the supervised setup core and
    // is the proof required before managed update may touch a service.
    const supervisor = value.supervisor === null || value.supervisor === undefined
        ? null : String(value.supervisor).trim();
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(profile) || !['stdio', 'http'].includes(transport) || !selectedClients.length
        || (supervisor !== null && !/^[A-Za-z0-9._-]{1,160}$/.test(supervisor))) {
        throw new Error('Setup manifest is incomplete.');
    }
    return Object.freeze({ schemaVersion: 1, profile, transport, selectedClients,
        updatedAt: String(value.updatedAt || ''), supervisor });
}

export async function readSetupManifest({ configDir, readFile = fs.readFile } = {}) {
    try { return normalizeManifest(JSON.parse(await readFile(getSetupManifestPath(configDir), 'utf8'))); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

export async function writeSetupManifest({ configDir, profile, transport, selectedClients, supervisor = null, updatedAt = new Date().toISOString() } = {}, {
    mkdir = fs.mkdir, chmod = fs.chmod, writeFile = fs.writeFile, rename = fs.rename, unlink = fs.unlink,
} = {}) {
    const manifest = normalizeManifest({ profile, transport, selectedClients, supervisor, updatedAt });
    const target = getSetupManifestPath(configDir);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(target), 0o700).catch((error) => { if (process.platform !== 'win32') throw error; });
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
        await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await chmod(temporary, 0o600).catch((error) => { if (process.platform !== 'win32') throw error; });
        await rename(temporary, target);
        await chmod(target, 0o600).catch((error) => { if (process.platform !== 'win32') throw error; });
    } finally { await unlink(temporary).catch(() => {}); }
    return manifest;
}

/** Records exact owned entries in a private recovery file before reconciliation.
 * This is intentionally not used for display: headers/env values can be
 * credentials and stay inside the profile directory with mode 0600. */
export async function writeSetupTransactionBackup({ configDir, profile, transport, entries, createdAt = new Date().toISOString() } = {}) {
    const directory = path.join(path.resolve(configDir), BACKUP_DIRECTORY);
    const target = path.join(directory, `${createdAt.replace(/[:.]/g, '-')}.json`);
    await fs.mkdir(path.resolve(configDir), { recursive: true, mode: 0o700 });
    await fs.chmod(path.resolve(configDir), 0o700).catch((error) => { if (process.platform !== 'win32') throw error; });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700).catch((error) => { if (process.platform !== 'win32') throw error; });
    await fs.writeFile(target, `${JSON.stringify({ schemaVersion: 1, profile, transport, createdAt, entries }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.chmod(target, 0o600).catch((error) => { if (process.platform !== 'win32') throw error; });
    return target;
}

function transportEnvText(existing, transport) {
    const lines = String(existing || '').split(/(?<=\n)/);
    let replaced = false;
    const output = lines.map((line) => {
        if (!/^\s*GOOGLE_MCP_TRANSPORT\s*=/.test(line)) return line;
        replaced = true;
        return `GOOGLE_MCP_TRANSPORT=${transport}\n`;
    });
    if (!replaced) output.push(`${output.length && !output.at(-1).endsWith('\n') ? '\n' : ''}GOOGLE_MCP_TRANSPORT=${transport}\n`);
    return output.join('');
}

export async function persistEffectiveTransport({ configDir, transport } = {}) {
    if (!['stdio', 'http'].includes(transport)) throw new Error('Transport must be stdio or http.');
    const target = path.join(path.resolve(configDir), '.env');
    let previous = null;
    try { previous = await fs.readFile(target, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(target), 0o700).catch((error) => { if (process.platform !== 'win32') throw error; });
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
        await fs.writeFile(temporary, transportEnvText(previous, transport), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, target);
        await fs.chmod(target, 0o600).catch((error) => { if (process.platform !== 'win32') throw error; });
    } finally { await fs.unlink(temporary).catch(() => {}); }
    return Object.freeze({ target, previous });
}

export async function restoreEffectiveTransport(record) {
    if (!record?.target) return false;
    if (record.previous === null) { await fs.unlink(record.target).catch(() => {}); return true; }
    await fs.writeFile(record.target, record.previous, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(record.target, 0o600).catch((error) => { if (process.platform !== 'win32') throw error; });
    return true;
}
