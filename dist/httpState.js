import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getConfigDir } from './config.js';
import { generateToken } from './httpAuth.js';

const TOKEN_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_STATE_BYTES = 16 * 1024;

export function getHttpStatePaths(configDir = getConfigDir()) {
    return Object.freeze({
        configDir,
        statePath: path.join(configDir, 'http-server.json'),
        tokenPath: path.join(configDir, 'http-token'),
    });
}

async function ensurePrivateDirectory(configDir) {
    await fsp.mkdir(configDir, { recursive: true, mode: DIRECTORY_MODE });
    await fsp.chmod(configDir, DIRECTORY_MODE).catch((error) => {
        if (process.platform !== 'win32') throw error;
    });
}

async function assertRegularPrivateFile(filePath) {
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Refusing unsafe HTTP operations file: ${filePath}`);
    }
    await fsp.chmod(filePath, TOKEN_MODE).catch((error) => {
        if (process.platform !== 'win32') throw error;
    });
    return stat;
}

async function atomicWrite(filePath, content) {
    await ensurePrivateDirectory(path.dirname(filePath));
    const temporary = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
    let handle;
    try {
        handle = await fsp.open(temporary, 'wx', TOKEN_MODE);
        await handle.writeFile(content, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await fsp.rename(temporary, filePath);
        await assertRegularPrivateFile(filePath);
    } finally {
        await handle?.close().catch(() => {});
        await fsp.rm(temporary, { force: true }).catch(() => {});
    }
}

function validateToken(value) {
    const token = String(value || '').trim();
    if (!/^[A-Za-z0-9._~-]{24,512}$/.test(token)) {
        throw new Error('The persisted HTTP bearer token is invalid; rotate it before starting the service.');
    }
    return token;
}

export async function ensureHttpToken({ configDir = getConfigDir(), env = process.env, generate = generateToken, create = true } = {}) {
    const explicit = String(env.GOOGLE_MCP_HTTP_TOKEN || '').trim();
    if (explicit) return Object.freeze({ token: explicit, source: 'environment', persisted: false, path: null });

    const { tokenPath } = getHttpStatePaths(configDir);
    await ensurePrivateDirectory(configDir);
    try {
        await assertRegularPrivateFile(tokenPath);
        return Object.freeze({ token: validateToken(await fsp.readFile(tokenPath, 'utf8')), source: 'file', persisted: true, path: tokenPath });
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }

    if (!create) return Object.freeze({ token: null, source: 'missing', persisted: false, path: tokenPath });

    const token = validateToken(generate());
    let handle;
    try {
        handle = await fsp.open(tokenPath, 'wx', TOKEN_MODE);
        await handle.writeFile(`${token}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await assertRegularPrivateFile(tokenPath);
        return Object.freeze({ token, source: 'file', persisted: true, path: tokenPath, created: true });
    } catch (error) {
        await handle?.close().catch(() => {});
        if (error?.code !== 'EEXIST') throw error;
        await assertRegularPrivateFile(tokenPath);
        return Object.freeze({ token: validateToken(await fsp.readFile(tokenPath, 'utf8')), source: 'file', persisted: true, path: tokenPath });
    }
}

function normalizeState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('HTTP service state is not an object.');
    const pid = Number(value.pid);
    const port = Number(value.port);
    const host = String(value.host || '').trim();
    const endpoint = String(value.endpoint || '').trim();
    const profile = String(value.profile || '').trim();
    const startedAt = String(value.startedAt || '');
    const version = String(value.version || '');
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('HTTP service state has an invalid pid.');
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('HTTP service state has an invalid port.');
    if (!host || !endpoint.startsWith('/') || !profile || !version || !Number.isFinite(Date.parse(startedAt))) {
        throw new Error('HTTP service state is incomplete.');
    }
    const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const url = new URL(`http://${urlHost}:${port}${endpoint}`).toString();
    return Object.freeze({ pid, port, host, endpoint, url, startedAt, version, profile });
}

export async function readHttpState({ configDir = getConfigDir() } = {}) {
    const { statePath } = getHttpStatePaths(configDir);
    try {
        await assertRegularPrivateFile(statePath);
        const stat = await fsp.stat(statePath);
        if (stat.size > MAX_STATE_BYTES) throw new Error('HTTP service state exceeds its size limit.');
        return normalizeState(JSON.parse(await fsp.readFile(statePath, 'utf8')));
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

export async function publishHttpState(state, { configDir = getConfigDir() } = {}) {
    const normalized = normalizeState(state);
    const { statePath } = getHttpStatePaths(configDir);
    const serializable = {
        pid: normalized.pid, port: normalized.port, host: normalized.host,
        endpoint: normalized.endpoint, startedAt: normalized.startedAt,
        version: normalized.version, profile: normalized.profile,
    };
    await atomicWrite(statePath, `${JSON.stringify(serializable, null, 2)}\n`);
    return normalized;
}

export async function removeHttpState({ configDir = getConfigDir(), expectedPid } = {}) {
    const { statePath } = getHttpStatePaths(configDir);
    if (expectedPid !== undefined) {
        const current = await readHttpState({ configDir }).catch(() => null);
        if (current && current.pid !== expectedPid) return false;
    }
    try { await fsp.unlink(statePath); return true; }
    catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

export function removeHttpStateSync({ configDir = getConfigDir(), expectedPid } = {}) {
    const { statePath } = getHttpStatePaths(configDir);
    try {
        if (expectedPid !== undefined) {
            const current = normalizeState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
            if (current.pid !== expectedPid) return false;
        }
        fs.unlinkSync(statePath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        return false;
    }
}

export function isProcessAlive(pid, { kill = process.kill } = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { kill(pid, 0); return true; }
    catch (error) { return error?.code === 'EPERM'; }
}
