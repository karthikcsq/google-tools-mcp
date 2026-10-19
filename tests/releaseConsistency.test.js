import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    compareVersions,
    distributionTagForVersion,
    findReleaseProblems,
    parseChangelogVersions,
    parseVersion,
} from '../scripts/check-release.mjs';

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
        expect(
            findReleaseProblems({
                packageVersion: '3.5.0',
                changelog: CHANGELOG,
                tag: 'v3.5.0',
            }),
        ).toEqual([]);
    });

    it('accepts a tag written without the leading v', () => {
        expect(
            findReleaseProblems({
                packageVersion: '3.5.0',
                changelog: CHANGELOG,
                tag: '3.5.0',
            }),
        ).toEqual([]);
    });

    it('rejects a tag that does not match package.json', () => {
        const problems = findReleaseProblems({
            packageVersion: '3.5.0',
            changelog: CHANGELOG,
            tag: 'v3.5.1',
        });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain(
            'Tag v3.5.1 does not match package.json version 3.5.0',
        );
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
        expect(problems[0]).toContain(
            "CHANGELOG.md's newest entry is [3.5.0] but package.json is 3.5.1",
        );
    });

    it('rejects a newest entry that is not greater than the one below it', () => {
        const outOfOrder = CHANGELOG.replace(
            '## [3.5.0] - 2026-09-05',
            '## [3.4.3] - 2026-09-05',
        );
        const problems = findReleaseProblems({
            packageVersion: '3.4.3',
            changelog: outOfOrder,
            tag: 'v3.4.3',
        });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain(
            'is not greater than the entry below it, [3.4.4]',
        );
    });

    it('rejects a duplicated version heading', () => {
        const duplicated = CHANGELOG.replace(
            '## [3.4.4] - 2026-09-03',
            '## [3.5.0] - 2026-09-03',
        );
        const problems = findReleaseProblems({
            packageVersion: '3.5.0',
            changelog: duplicated,
            tag: 'v3.5.0',
        });
        expect(problems).toContain(
            'CHANGELOG.md has more than one entry for [3.5.0].',
        );
    });

    it('rejects a changelog with no release heading at all', () => {
        const problems = findReleaseProblems({
            packageVersion: '3.5.0',
            changelog: '# Changelog\n\nNothing here yet.\n',
            tag: 'v3.5.0',
        });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain(
            'no `## [X.Y.Z[-PRERELEASE]] - YYYY-MM-DD` release heading',
        );
    });

    it('accepts a prerelease when the tag and newest changelog entry agree', () => {
        const prereleaseChangelog = CHANGELOG.replace(
            '3.5.0',
            '3.5.0-rc.1',
        ).replace('3.4.4', '3.5.0-beta.11');
        expect(
            findReleaseProblems({
                packageVersion: '3.5.0-rc.1',
                changelog: prereleaseChangelog,
                tag: 'v3.5.0-rc.1',
            }),
        ).toEqual([]);
    });

    it('uses SemVer prerelease precedence and ignores build metadata', () => {
        const ordered = [
            '1.0.0-alpha',
            '1.0.0-alpha.1',
            '1.0.0-alpha.beta',
            '1.0.0-beta',
            '1.0.0-beta.2',
            '1.0.0-beta.11',
            '1.0.0-rc.1',
            '1.0.0',
        ].map(parseVersion);

        for (let index = 0; index < ordered.length - 1; index += 1) {
            expect(compareVersions(ordered[index], ordered[index + 1])).toBe(
                -1,
            );
        }
        expect(
            compareVersions(
                parseVersion('1.0.0+build.1'),
                parseVersion('1.0.0+build.2'),
            ),
        ).toBe(0);
    });

    it('rejects invalid SemVer identifiers instead of treating them as prereleases', () => {
        const invalidChangelog = CHANGELOG.replace('3.5.0', '3.5.0-01');
        const problems = findReleaseProblems({
            packageVersion: '3.5.0-01',
            changelog: invalidChangelog,
            tag: 'v3.5.0-01',
        });
        expect(problems).toEqual(
            expect.arrayContaining([
                expect.stringContaining(
                    'package.json version "3.5.0-01" is not a valid Semantic Version',
                ),
            ]),
        );
    });

    it('ignores bracketed prose that is not a dated release heading', () => {
        const withProse = CHANGELOG.replace(
            'Something new.',
            '## [not a release]\n\nSee [3.9.9] elsewhere.',
        );
        expect(parseChangelogVersions(withProse)).toEqual(['3.5.0', '3.4.4']);
    });

    it('publishes prereleases to next without misclassifying stable build metadata', () => {
        expect(distributionTagForVersion('4.0.0-rc.1')).toBe('next');
        expect(distributionTagForVersion('4.0.0')).toBe('latest');
        expect(distributionTagForVersion('4.0.0+build-tag')).toBe('latest');
        expect(() => distributionTagForVersion('4.0.0-01')).toThrow(
            /Invalid Semantic Version/,
        );
    });

    it('holds for the real package.json and CHANGELOG.md on this branch', async () => {
        const packageVersion = JSON.parse(
            await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
        ).version;
        const changelog = await fs.readFile(
            path.join(repoRoot, 'CHANGELOG.md'),
            'utf8',
        );

        expect(
            findReleaseProblems({
                packageVersion,
                changelog,
                tag: `v${packageVersion}`,
            }),
        ).toEqual([]);
    });
});
