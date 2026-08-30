// Package-tarball guard (issue #74). The five pre-consolidation Gmail
// forks at dist/tools/{drafts,labels,messages,settings,threads}.js were
// deleted because they are dead code (`dist/tools/index.js` imports Gmail
// tools only via explicit `./gmail/*.js` paths). package.json's
// `files: ["dist"]` ships the entire dist/ tree verbatim, so the only way
// to be sure they never come back into the published package is to check
// the actual tarball manifest, not just the working tree.
//
// This is also the home for any future "no *.test.js under dist/" guard
// (issue #56) — coordinate additions here rather than opening a second
// package-contents test file.
import { describe, it, expect, beforeAll } from '@jest/globals';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const DEAD_GMAIL_FORKS = [
    'dist/tools/drafts.js',
    'dist/tools/labels.js',
    'dist/tools/messages.js',
    'dist/tools/settings.js',
    'dist/tools/threads.js',
];

describe('npm package tarball contents', () => {
    let files;

    beforeAll(() => {
        // execSync (not execFileSync) so the platform's own shell resolves
        // `npm` to `npm.cmd`/`npm.ps1` on Windows without a manual args-array
        // + shell:true combination (which Node flags as unsafe generically,
        // even though these args are fixed literals, not user input).
        const stdout = execSync('npm pack --dry-run --json', {
            cwd: repoRoot,
            encoding: 'utf8',
            windowsHide: true,
        });
        const [manifest] = JSON.parse(stdout);
        files = manifest.files.map(f => f.path);
    }, 60000);

    it('does not contain the deleted pre-consolidation Gmail tool forks', () => {
        for (const deadPath of DEAD_GMAIL_FORKS) {
            expect(files).not.toContain(deadPath);
        }
    });

    it('still contains the live Gmail tool modules', () => {
        expect(files).toContain('dist/tools/gmail/drafts.js');
        expect(files).toContain('dist/tools/gmail/labels.js');
        expect(files).toContain('dist/tools/gmail/messages.js');
        expect(files).toContain('dist/tools/gmail/settings.js');
        expect(files).toContain('dist/tools/gmail/threads.js');
    });

    it('still contains the entry point referenced by package.json bin/start', () => {
        expect(files).toContain('dist/index.js');
    });
});
