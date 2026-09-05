import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findReleaseProblems, parseChangelogVersions } from '../scripts/check-release.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHANGELOG = [
    '# Changelog',
    '',
    '## [3.5.0] - 2026-09-05',
    '',
    'Something new.',
    '',
    '## [3.4.4] - 2026-09-03',
    '',
    'Something older.',
    '',
].join('\n');

describe('check-release', () => {
    it('passes when the tag, package.json, and the newest changelog entry agree', () => {
        expect(findReleaseProblems({
            packageVersion: '3.5.0',
            changelog: CHANGELOG,
            tag: 'v3.5.0',
        })).toEqual([]);
    });

    it('accepts a tag written without the leading v', () => {
        expect(findReleaseProblems({
            packageVersion: '3.5.0',
            changelog: CHANGELOG,
            tag: '3.5.0',
        })).toEqual([]);
    });

    it('rejects a tag that does not match package.json', () => {
        const problems = findReleaseProblems({
            packageVersion: '3.5.0',
            changelog: CHANGELOG,
            tag: 'v3.5.1',
        });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('Tag v3.5.1 does not match package.json version 3.5.0');
    });

    // The gap this script exists to close: the old workflow compared the tag
    // against package.json and nothing else, so a bumped package.json with no
    // changelog entry shipped green.
    it('rejects a package.json bump whose changelog entry was never added', () => {
        const problems = findReleaseProblems({
            packageVersion: '3.5.1',
            changelog: CHANGELOG,
            tag: 'v3.5.1',
        });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("CHANGELOG.md's newest entry is [3.5.0] but package.json is 3.5.1");
    });

    it('rejects a newest entry that is not greater than the one below it', () => {
        const outOfOrder = CHANGELOG.replace('## [3.5.0] - 2026-09-05', '## [3.4.3] - 2026-09-05');
        const problems = findReleaseProblems({
            packageVersion: '3.4.3',
            changelog: outOfOrder,
            tag: 'v3.4.3',
        });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('is not greater than the entry below it, [3.4.4]');
    });

    it('rejects a duplicated version heading', () => {
        const duplicated = CHANGELOG.replace('## [3.4.4] - 2026-09-03', '## [3.5.0] - 2026-09-03');
        const problems = findReleaseProblems({
            packageVersion: '3.5.0',
            changelog: duplicated,
            tag: 'v3.5.0',
        });
        expect(problems).toContain('CHANGELOG.md has more than one entry for [3.5.0].');
    });

    it('rejects a changelog with no release heading at all', () => {
        const problems = findReleaseProblems({
            packageVersion: '3.5.0',
            changelog: '# Changelog\n\nNothing here yet.\n',
            tag: 'v3.5.0',
        });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('no `## [X.Y.Z] - YYYY-MM-DD` release heading');
    });

    it('rejects a prerelease version, which this release flow does not handle', () => {
        const problems = findReleaseProblems({
            packageVersion: '3.5.0-beta.1',
            changelog: CHANGELOG,
            tag: 'v3.5.0-beta.1',
        });
        expect(problems[0]).toContain('is not a bare X.Y.Z release version');
    });

    it('ignores bracketed prose that is not a dated release heading', () => {
        const withProse = CHANGELOG.replace(
            'Something new.',
            '## [not a release]\n\nSee [3.9.9] elsewhere.',
        );
        expect(parseChangelogVersions(withProse)).toEqual(['3.5.0', '3.4.4']);
    });

    it('holds for the real package.json and CHANGELOG.md on this branch', async () => {
        const packageVersion = JSON.parse(
            await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
        ).version;
        const changelog = await fs.readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');

        expect(findReleaseProblems({ packageVersion, changelog, tag: `v${packageVersion}` })).toEqual([]);
    });
});
