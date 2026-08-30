import { describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

jest.setTimeout(60_000);

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG_SOURCE = path.join(REPOSITORY_ROOT, 'dist', 'config.js');
const ENTRYPOINT = path.join(REPOSITORY_ROOT, 'dist', 'index.js');
const STARTUP_VARIABLES = [
    'GOOGLE_MCP_TRANSPORT', 'GOOGLE_MCP_PORT', 'GOOGLE_MCP_ENDPOINT',
    'GOOGLE_MCP_HTTP_TOKEN', 'GOOGLE_MCP_HTTP_HOST', 'GOOGLE_MCP_HTTP_ALLOWED_ORIGINS', 'GOOGLE_MCP_HTTP_NO_AUTH',
    'GOOGLE_MCP_LOG_FILE', 'LOG_LEVEL', 'GOOGLE_MAPS_API_KEY',
    'GOOGLE_MCP_WORKSPACE_DIR', 'GOOGLE_MCP_ENABLE_LEGACY_ALIASES',
];

async function makeConfigFixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-config-'));
    const packageDist = path.join(root, 'package', 'dist');
    const cwd = path.join(root, 'cwd');
    const xdg = path.join(root, 'xdg');
    await Promise.all([mkdir(packageDist, { recursive: true }), mkdir(cwd), mkdir(xdg)]);
    await copyFile(CONFIG_SOURCE, path.join(packageDist, 'config.js'));
    return { root, packageRoot: path.join(root, 'package'), cwd, xdg, configUrl: pathToFileURL(path.join(packageDist, 'config.js')).href };
}

function runConfig(fixture, env = {}) {
    const script = [
        `import { getConfigDir, getLoadedConfigFiles, getLoadedConfigKeys } from ${JSON.stringify(fixture.configUrl)};`,
        'const configDir = getConfigDir(); const loadedProfile = process.env.GOOGLE_MCP_PROFILE; process.env.GOOGLE_MCP_PROFILE = "mutated-after-load"; process.stdout.write(JSON.stringify({ env: process.env, loadedProfile, configDir, configDirAfterMutation: getConfigDir(), loaded: getLoadedConfigFiles(), loadedKeys: getLoadedConfigKeys() }));',
    ].join('\n');
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
            cwd: fixture.cwd,
            env: { PATH: process.env.PATH, XDG_CONFIG_HOME: fixture.xdg, ...env },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => {
            if (code !== 0) reject(new Error(`config child exited ${code}: ${stderr}`));
            else resolve({ result: JSON.parse(stdout), stderr });
        });
    });
}

async function freePort() {
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

describe('shared startup configuration', () => {
    it('loads every startup setting from the user config file', async () => {
        const fixture = await makeConfigFixture();
        try {
            const userDir = path.join(fixture.xdg, 'google-tools-mcp');
            await mkdir(userDir);
            await writeFile(path.join(userDir, '.env'), STARTUP_VARIABLES.map((key, index) => `${key}=file-${index}`).join('\n'));
            const { result } = await runConfig(fixture);
            for (const [index, key] of STARTUP_VARIABLES.entries()) {
                expect(result.env[key]).toBe(`file-${index}`);
            }
            expect(result.loadedKeys).toEqual(expect.arrayContaining(STARTUP_VARIABLES));
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    it('keeps real environment values, including empty strings, over config files', async () => {
        const fixture = await makeConfigFixture();
        try {
            const userDir = path.join(fixture.xdg, 'google-tools-mcp');
            await mkdir(userDir);
            await writeFile(path.join(userDir, '.env'), 'GOOGLE_MCP_TRANSPORT=http\nGOOGLE_MCP_PORT=5555');
            const { result } = await runConfig(fixture, { GOOGLE_MCP_TRANSPORT: '', GOOGLE_MCP_PORT: '4444' });
            expect(result.env.GOOGLE_MCP_TRANSPORT).toBe('');
            expect(result.env.GOOGLE_MCP_PORT).toBe('4444');
            expect(result.loadedKeys).not.toContain('GOOGLE_MCP_TRANSPORT');
            expect(result.loadedKeys).not.toContain('GOOGLE_MCP_PORT');
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    it('uses user config before cwd and package-root config', async () => {
        const fixture = await makeConfigFixture();
        try {
            const userDir = path.join(fixture.xdg, 'google-tools-mcp');
            await mkdir(userDir);
            await Promise.all([
                writeFile(path.join(userDir, '.env'), 'CONFIG_PRECEDENCE=user'),
                writeFile(path.join(fixture.cwd, '.env'), 'CONFIG_PRECEDENCE=cwd'),
                writeFile(path.join(fixture.packageRoot, '.env'), 'CONFIG_PRECEDENCE=package'),
            ]);
            const { result } = await runConfig(fixture);
            expect(result.env.CONFIG_PRECEDENCE).toBe('user');
            expect(result.loaded).toHaveLength(3);
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    it('ignores profiles from config files and keeps the config directory immutable', async () => {
        const fixture = await makeConfigFixture();
        try {
            const userDir = path.join(fixture.xdg, 'google-tools-mcp');
            await mkdir(userDir);
            await writeFile(path.join(userDir, '.env'), 'GOOGLE_MCP_PROFILE=ignored');
            const { result, stderr } = await runConfig(fixture);
            expect(result.configDir).toBe(userDir);
            expect(result.configDirAfterMutation).toBe(userDir);
            expect(result.loadedProfile).toBeUndefined();
            expect(stderr).toContain(`Ignoring GOOGLE_MCP_PROFILE in config file ${path.join(userDir, '.env')}`);
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    // Finding 14: GOOGLE_MCP_PROFILE was used as an unchecked path component,
    // so a profile containing ".." could move getConfigDir() (and every
    // mkdir/chmod that follows it in logger.js/httpState.js) outside
    // ~/.config/google-tools-mcp entirely.
    it('rejects a path-traversal GOOGLE_MCP_PROFILE and never touches the escaped directory', async () => {
        const fixture = await makeConfigFixture();
        try {
            // configBaseDir is <xdg>/google-tools-mcp, so "../shared" resolves
            // to a sibling of it -- <xdg>/shared -- which must never be created.
            const escapedDir = path.join(fixture.xdg, 'shared');
            await expect(runConfig(fixture, { GOOGLE_MCP_PROFILE: '../shared' }))
                .rejects.toThrow(/Invalid GOOGLE_MCP_PROFILE/);
            await expect(access(escapedDir)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    it('rejects every other unsafe GOOGLE_MCP_PROFILE shape (dot-segments, absolute paths, separators)', async () => {
        const fixture = await makeConfigFixture();
        try {
            for (const bad of ['..', '.', '/etc/passwd', 'a/b', 'a\\b', path.join(fixture.root, 'x')]) {
                await expect(runConfig(fixture, { GOOGLE_MCP_PROFILE: bad }))
                    .rejects.toThrow(/Invalid GOOGLE_MCP_PROFILE/);
            }
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    it('accepts a plain profile name and resolves it as a direct child of the config base directory', async () => {
        const fixture = await makeConfigFixture();
        try {
            const { result } = await runConfig(fixture, { GOOGLE_MCP_PROFILE: 'work' });
            expect(result.configDir).toBe(path.join(fixture.xdg, 'google-tools-mcp', 'work'));
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    // Finding 17: a cwd .env is a materially lower trust boundary than the
    // user config directory -- it's wherever the client happened to be
    // launched from, often a cloned repository the operator does not
    // control. Security/lifecycle settings must not be reachable from it.
    it('ignores security/lifecycle settings from a cwd .env but still loads them from the user config directory', async () => {
        const fixture = await makeConfigFixture();
        try {
            const userDir = path.join(fixture.xdg, 'google-tools-mcp');
            await mkdir(userDir);
            const restricted = [
                'GOOGLE_MCP_TRANSPORT=http', 'GOOGLE_MCP_HTTP_NO_AUTH=1', 'GOOGLE_MCP_HTTP_HOST=0.0.0.0',
                'GOOGLE_MCP_HTTP_ALLOWED_ORIGINS=https://evil.example', 'GOOGLE_MCP_HTTP_TOKEN=cwd-token',
                'GOOGLE_MCP_PORT=9999', 'GOOGLE_MCP_ENDPOINT=/evil', 'GOOGLE_MCP_LOG_FILE=/tmp/evil.log',
                'GOOGLE_MCP_JSONL_FILE=/tmp/evil.jsonl', 'GOOGLE_MCP_OAUTH_PORT=9998',
                'SERVICE_ACCOUNT_PATH=/tmp/evil-key.json', 'GOOGLE_IMPERSONATE_USER=admin@evil.example',
            ];
            await writeFile(path.join(fixture.cwd, '.env'), [...restricted, 'CWD_ONLY_KEY=still-loads'].join('\n'));
            const { result, stderr } = await runConfig(fixture);

            for (const line of restricted) {
                const [key] = line.split('=');
                expect(result.env[key]).toBeUndefined();
                expect(result.loadedKeys).not.toContain(key);
                expect(stderr).toContain(`Ignoring ${key} in lower-trust config file ${path.join(fixture.cwd, '.env')}`);
            }
            // A non-restricted key from the same lower-trust file still loads.
            expect(result.env.CWD_ONLY_KEY).toBe('still-loads');
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    it('still loads security/lifecycle settings from the user config directory .env', async () => {
        const fixture = await makeConfigFixture();
        try {
            const userDir = path.join(fixture.xdg, 'google-tools-mcp');
            await mkdir(userDir);
            await writeFile(path.join(userDir, '.env'), 'GOOGLE_MCP_TRANSPORT=http\nGOOGLE_MCP_HTTP_NO_AUTH=1');
            const { result } = await runConfig(fixture);
            expect(result.env.GOOGLE_MCP_TRANSPORT).toBe('http');
            expect(result.env.GOOGLE_MCP_HTTP_NO_AUTH).toBe('1');
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    it('warns when a config path cannot be read while missing files remain silent', async () => {
        const fixture = await makeConfigFixture();
        try {
            const userDir = path.join(fixture.xdg, 'google-tools-mcp');
            await mkdir(path.join(userDir, '.env'), { recursive: true });
            const { stderr } = await runConfig(fixture);
            expect(stderr).toContain(`Unable to read config file ${path.join(userDir, '.env')} (EISDIR).`);
            expect(stderr).not.toContain(path.join(fixture.cwd, '.env'));
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    it('warns with file and line for malformed assignments while loading valid lines', async () => {
        const fixture = await makeConfigFixture();
        try {
            const userDir = path.join(fixture.xdg, 'google-tools-mcp');
            await mkdir(userDir);
            await writeFile(path.join(userDir, '.env'), 'GOOD_KEY=loaded\nnot an assignment\n BAD-KEY=nope\n');
            const { result, stderr } = await runConfig(fixture);
            expect(result.env.GOOD_KEY).toBe('loaded');
            expect(stderr).toContain(`${path.join(userDir, '.env')}:2`);
            expect(stderr).toContain(`${path.join(userDir, '.env')}:3`);
        } finally { await rm(fixture.root, { recursive: true, force: true }); }
    });

    it('applies a Windows-safe user config file before the entrypoint selects HTTP transport', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-startup-config-'));
        const xdg = path.join(root, 'xdg');
        const port = await freePort();
        const envKeys = [...STARTUP_VARIABLES, 'GOOGLE_MCP_PROFILE'];
        try {
            const userDir = path.join(xdg, 'google-tools-mcp');
            await mkdir(userDir, { recursive: true });
            await writeFile(path.join(userDir, '.env'), `GOOGLE_MCP_TRANSPORT=http\nGOOGLE_MCP_PORT=${port}\nLOG_LEVEL=debug`);
            const child = spawn(process.execPath, [ENTRYPOINT], {
                cwd: REPOSITORY_ROOT,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, CI: 'true', XDG_CONFIG_HOME: xdg, ...Object.fromEntries(envKeys.map((key) => [key, undefined])) },
            });
            let stderr = '';
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`server never became ready: ${stderr}`)), 40_000);
                const check = () => {
                    if (stderr.includes(`running over HTTP at http://127.0.0.1:${port}/mcp`)) {
                        clearTimeout(timer);
                        child.stderr.off('data', check);
                        resolve();
                    }
                };
                child.stderr.on('data', check);
                check();
            });
            const exited = once(child, 'exit');
            child.kill('SIGKILL');
            await exited;
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('lets a real stdio transport environment override the user config file', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-env-override-'));
        const xdg = path.join(root, 'xdg');
        try {
            const userDir = path.join(xdg, 'google-tools-mcp');
            await mkdir(userDir, { recursive: true });
            await writeFile(path.join(userDir, '.env'), 'GOOGLE_MCP_TRANSPORT=http');
            const child = spawn(process.execPath, [ENTRYPOINT], {
                cwd: REPOSITORY_ROOT,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, CI: 'true', XDG_CONFIG_HOME: xdg, GOOGLE_MCP_TRANSPORT: 'stdio' },
            });
            let stderr = '';
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`server never became ready: ${stderr}`)), 40_000);
                const check = () => {
                    if (stderr.includes('running using stdio')) {
                        clearTimeout(timer);
                        child.stderr.off('data', check);
                        resolve();
                    }
                };
                child.stderr.on('data', check);
                check();
            });
            const exited = once(child, 'exit');
            child.kill('SIGKILL');
            await exited;
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
