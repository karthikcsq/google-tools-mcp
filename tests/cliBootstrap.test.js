import { describe, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ENTRYPOINT = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const PACKAGE_VERSION = createRequire(import.meta.url)('../package.json').version;

async function runCommand(args, { env = {}, config = '' } = {}) {
    const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-cli-bootstrap-'));
    const configDir = path.join(configRoot, 'google-tools-mcp');
    await fs.mkdir(configDir, { recursive: true });
    if (config) await fs.writeFile(path.join(configDir, '.env'), config, 'utf8');
    const childEnv = {
        ...process.env,
        CI: 'true',
        XDG_CONFIG_HOME: configRoot,
        GOOGLE_MCP_LOG_FILE: '0',
        GOOGLE_MCP_JSONL_FILE: '0',
    };
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete childEnv[key];
        else childEnv[key] = value;
    }
    const child = spawn(process.execPath, [ENTRYPOINT, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    try {
        const code = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`command did not exit: ${args.join(' ')}`)), 3000);
            child.once('error', (error) => { clearTimeout(timer); reject(error); });
            child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
        });
        return { code, stdout, stderr };
    } finally {
        child.kill('SIGTERM');
        await fs.rm(configRoot, { recursive: true, force: true });
    }
}

describe('early CLI bootstrap', () => {
    it.each([
        [['--version'], 0],
        [['-v'], 0],
        [['--help'], 0],
        [['--unknown-option'], 1],
        [['setup', '--invalid-option'], 1],
        [['update', '--invalid-option'], 1],
        [['status', '--unknown-option'], 1],
    ])('exits before runtime imports for %p', async (args, expectedCode) => {
        const result = await runCommand(args, {
            // config.js rejects this during module initialization. Early commands
            // must never reach it, even when stdin remains open in the child.
            env: { GOOGLE_MCP_PROFILE: '../unsafe-profile' },
            config: 'THIS IS NOT A VALID ENV LINE\n',
        });
        expect(result.code).toBe(expectedCode);
        expect(result.stderr).not.toContain('Invalid GOOGLE_MCP_PROFILE');
        expect(result.stderr).not.toContain('WARNING:');
        expect(`${result.stdout}${result.stderr}`).not.toContain('MCP Server running');
    });

    it('prints the manifest version and includes it in help', async () => {
        await expect(runCommand(['--version'])).resolves.toMatchObject({ code: 0, stdout: `${PACKAGE_VERSION}\n` });
        await expect(runCommand(['--help'])).resolves.toMatchObject({ code: 0, stdout: expect.stringContaining(`google-tools-mcp ${PACKAGE_VERSION}`) });
    });

    it('reports stdio status as a neutral shared-service result', async () => {
        const result = await runCommand(['status', '--json'], {
            env: { GOOGLE_MCP_TRANSPORT: undefined },
            config: 'GOOGLE_MCP_TRANSPORT=stdio\n',
        });
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            healthy: true,
            transport: 'stdio',
            service: { status: 'not-applicable', reason: 'stdio-transport' },
            oauth: { status: 'not-inspected', reason: 'run-doctor' },
        });
    });
});
