#!/usr/bin/env node
// Verify the npm tarball in the same no-Git, --omit=dev shape a consumer gets.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeStdioCandidate } from '../dist/service/probeCandidate.js';

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
);

function npmInvocation(env) {
    // `npm run` provides the Node entrypoint even on Windows, where spawning
    // npm.cmd directly is not supported by child_process without a shell.
    if (path.isAbsolute(String(env.npm_execpath || ''))) {
        return { command: process.execPath, prefix: [env.npm_execpath] };
    }
    if (process.platform !== 'win32') return { command: 'npm', prefix: [] };
    throw new Error('package:consumer-check must run through npm on Windows.');
}

function run(command, args, { cwd, env = process.env } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0) resolve(stdout);
            else
                reject(
                    new Error(
                        `${command} ${args.join(' ')} failed (${code}): ${stderr.trim()}`,
                    ),
                );
        });
    });
}

export async function verifyPackedConsumer({
    root = repoRoot,
    env = process.env,
} = {}) {
    const scratch = await fs.mkdtemp(
        path.join(os.tmpdir(), 'google-tools-mcp-consumer-'),
    );
    const packageDirectory = path.join(scratch, 'packages');
    const consumerDirectory = path.join(scratch, 'consumer');
    const npm = npmInvocation(env);
    const scopedEnv = {
        ...env,
        npm_config_cache: path.join(scratch, 'npm-cache'),
    };
    try {
        await fs.mkdir(packageDirectory, { recursive: true });
        await fs.mkdir(consumerDirectory, { recursive: true });
        const packed = JSON.parse(
            await run(
                npm.command,
                [
                    ...npm.prefix,
                    'pack',
                    '--json',
                    '--ignore-scripts',
                    '--pack-destination',
                    packageDirectory,
                ],
                {
                    cwd: root,
                    env: { ...scopedEnv, HUSKY: '0' },
                },
            ),
        );
        const manifests = Array.isArray(packed)
            ? packed
            : Object.values(packed);
        const filename = manifests.length === 1 ? manifests[0]?.filename : null;
        if (!filename)
            throw new Error('npm pack did not return a tarball filename.');
        const tarball = path.join(packageDirectory, filename);
        await run(npm.command, [...npm.prefix, 'init', '-y'], {
            cwd: consumerDirectory,
            env: { ...scopedEnv, HUSKY: '1' },
        });
        await run(
            npm.command,
            [...npm.prefix, 'install', '--omit=dev', tarball],
            { cwd: consumerDirectory, env: { ...scopedEnv, HUSKY: '1' } },
        );

        const installedRoot = path.join(
            consumerDirectory,
            'node_modules',
            'google-tools-mcp',
        );
        const [installedManifest, husky] = await Promise.all([
            fs
                .readFile(path.join(installedRoot, 'package.json'), 'utf8')
                .then(JSON.parse),
            fs
                .access(path.join(installedRoot, 'node_modules', 'husky'))
                .then(() => true)
                .catch(() => false),
        ]);
        const sourceManifest = JSON.parse(
            await fs.readFile(path.join(root, 'package.json'), 'utf8'),
        );
        if (installedManifest.version !== sourceManifest.version)
            throw new Error(
                'Installed consumer version differs from the packed version.',
            );
        if (husky)
            throw new Error(
                'Consumer unexpectedly installed Husky as a production dependency.',
            );
        if (installedManifest.scripts?.prepare) {
            await run(npm.command, [...npm.prefix, 'run', 'prepare'], {
                cwd: installedRoot,
                env: scopedEnv,
            });
        }

        const probe = await probeStdioCandidate({
            entrypoint: path.join(installedRoot, 'dist', 'index.js'),
            configDir: path.join(scratch, 'candidate-config'),
            expectedVersion: installedManifest.version,
        });
        return Object.freeze({ version: installedManifest.version, ...probe });
    } finally {
        await fs.rm(scratch, { recursive: true, force: true });
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    verifyPackedConsumer()
        .then((result) => {
            process.stdout.write(`${JSON.stringify(result)}\n`);
        })
        .catch((error) => {
            process.stderr.write(
                `Packed consumer verification failed: ${error.message}\n`,
            );
            process.exitCode = 1;
        });
}
