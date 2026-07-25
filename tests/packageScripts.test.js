// Contract tests for package.json scripts and executable entry point.
// The `start` script and `bin` entry are the one executable contract this
// repo exposes for running the hand-edited dist/ source directly, so pin
// their values and confirm the referenced file actually exists.
import { describe, it, expect, beforeAll } from '@jest/globals';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

describe('package.json scripts', () => {
    let pkg;
    beforeAll(() => {
        pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
    });

    it('defines a start script that runs the dist entry point', () => {
        expect(pkg.scripts.start).toBe('node dist/index.js');
    });

    it('exposes the bin entry pointing at the same dist entry point', () => {
        expect(pkg.bin['google-tools-mcp']).toBe('dist/index.js');
    });

    it('start script and bin resolve to the same entry file', () => {
        const startTarget = pkg.scripts.start.replace(/^node\s+/, '');
        expect(startTarget).toBe(pkg.bin['google-tools-mcp']);
    });

    it('the referenced entry file exists on disk', () => {
        expect(existsSync(resolve(repoRoot, 'dist/index.js'))).toBe(true);
    });
});
