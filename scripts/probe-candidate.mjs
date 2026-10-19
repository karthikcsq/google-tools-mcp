#!/usr/bin/env node
// Thin command-line wrapper for the packaged stdio candidate probe.
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { probeStdioCandidate } from '../dist/service/probeCandidate.js';

function usage() {
    return 'Usage: node scripts/probe-candidate.mjs --entry <absolute-or-relative-path> [--expected-version <version>]\n';
}

function parseArguments(argv) {
    const options = { entrypoint: null, expectedVersion: null };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) return null;
        if (flag === '--entry' && options.entrypoint === null) {
            options.entrypoint = path.resolve(value);
        } else if (
            flag === '--expected-version' &&
            options.expectedVersion === null
        ) {
            options.expectedVersion = value;
        } else {
            return null;
        }
        index += 1;
    }
    return options.entrypoint ? options : null;
}

async function main(argv) {
    const options = parseArguments(argv);
    if (!options) {
        process.stderr.write(usage());
        return 1;
    }
    const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'google-tools-mcp-candidate-'),
    );
    try {
        const result = await probeStdioCandidate({
            entrypoint: options.entrypoint,
            configDir: path.join(root, 'config'),
            expectedVersion: options.expectedVersion,
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return 0;
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

main(process.argv.slice(2))
    .then((code) => {
        process.exitCode = code;
    })
    .catch((error) => {
        process.stderr.write(`Candidate MCP probe failed: ${error.message}\n`);
        process.exitCode = 1;
    });
