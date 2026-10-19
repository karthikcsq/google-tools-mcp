import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const RESULTS_ROOT = path.join(REPO_ROOT, 'live-smoke-results', 'agent-test');
export const PROTOCOL_VERSION = '2026-07-28';

export function randomToken() {
    return crypto.randomBytes(32).toString('base64url');
}

export function makeRunId(now = new Date()) {
    const stamp = now.toISOString().replace(/[:.]/g, '-').replace('Z', '');
    return `agent-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

export async function ensurePrivateDir(dir) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => {});
    return dir;
}

export async function writePrivateJson(file, value) {
    await ensurePrivateDir(path.dirname(file));
    const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(temporary, 0o600).catch(() => {});
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600).catch(() => {});
}

export async function readPrivateJson(file) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing unsafe session file: ${file}`);
    return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function appendJsonl(file, entry) {
    await fs.appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(file, 0o600).catch(() => {});
}

function redactKey(key) {
    return /(?:token|secret|authorization|credential|cookie|password|api[_-]?key)/i.test(key);
}

export function redact(value, depth = 0) {
    if (typeof value === 'string') {
        const cleaned = value
            .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[redacted]')
            .replace(/((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s&]+/gi, '$1[redacted]');
        return cleaned.length > 600 ? `${cleaned.slice(0, 400)}…[truncated]` : cleaned;
    }
    if (value === null || typeof value !== 'object') return value;
    if (depth > 7) return '[depth limit]';
    if (Array.isArray(value)) return value.slice(0, 40).map((item) => redact(item, depth + 1));
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = redactKey(key) ? '[redacted]' : redact(item, depth + 1);
    return output;
}

export function publicManifest(manifest) {
    const { controlToken, nativeMcp, ...safe } = manifest;
    return {
        ...safe,
        ...(nativeMcp ? { nativeMcp: { url: nativeMcp.url, transport: 'streamable-http', credential: 'stored in private manifest' } } : {}),
        control: { endpoint: manifest.controlUrl, credential: 'stored in private manifest' },
    };
}

export function isInside(child, parent) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function sourceFingerprint() {
    const include = ['dist', 'scripts', 'package.json', 'package-lock.json'];
    const hash = crypto.createHash('sha256');
    const walk = async (directory) => {
        const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            const target = path.join(directory, entry.name);
            const relative = path.relative(REPO_ROOT, target).replaceAll(path.sep, '/');
            if (relative.startsWith('live-smoke-results/') || relative.includes('/node_modules/')) continue;
            if (entry.isDirectory()) await walk(target);
            else if (entry.isFile()) {
                hash.update(relative); hash.update('\0'); hash.update(await fs.readFile(target)); hash.update('\0');
            }
        }
    };
    for (const name of include) {
        const target = path.join(REPO_ROOT, name);
        const stat = await fs.stat(target).catch(() => null);
        if (!stat) continue;
        if (stat.isDirectory()) await walk(target);
        else {
            hash.update(name); hash.update('\0'); hash.update(await fs.readFile(target)); hash.update('\0');
        }
    }
    return `sha256:${hash.digest('hex')}`;
}

export async function codeIdentity() {
    const execFileAsync = promisify(execFile);
    let head = null;
    try {
        const safeDirectory = REPO_ROOT.replaceAll('\\', '/');
        const { stdout } = await execFileAsync('git', ['-c', `safe.directory=${safeDirectory}`, 'rev-parse', 'HEAD'], {
            cwd: REPO_ROOT, windowsHide: true, timeout: 5_000,
        });
        head = stdout.trim() || null;
    } catch {
        // Reports remain useful in source snapshots that have no git metadata.
    }
    return { head, dirtyFingerprint: await sourceFingerprint(), identitySource: 'HEAD plus deterministic runtime-source digest' };
}

export function resultIsError(envelope) {
    return Boolean(envelope?.error || envelope?.result?.isError);
}

export function resultErrorText(envelope) {
    const content = envelope?.result?.content;
    if (Array.isArray(content)) return content.map((item) => item?.text).filter(Boolean).join('\n');
    return envelope?.error?.message || null;
}

/**
 * Compact discovery for a human tester. The real MCP tools/list envelope is
 * preserved, but schemas are intentionally omitted from a search result so a
 * tester can choose a name before asking `describe` for its full contract.
 */
export function compactToolSearch(envelope, search) {
    const query = String(search || '').trim().toLocaleLowerCase();
    if (!query) throw new Error('list --search requires non-empty text.');
    const tools = Array.isArray(envelope?.result?.tools) ? envelope.result.tools : [];
    const normalize = (value) => String(value || '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLocaleLowerCase();
    const compact = tools
        .filter((tool) => normalize(`${tool?.name || ''} ${tool?.description || ''}`).includes(query))
        .map((tool) => ({ name: tool.name, description: tool.description || '' }));
    return { ...envelope, result: { ...envelope.result, tools: compact } };
}
