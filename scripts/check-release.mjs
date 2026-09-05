#!/usr/bin/env node
/**
 * Release consistency gate.
 *
 * CONTRIBUTING.md and CHANGELOG.md both state the same rule: the version at the
 * top of the changelog, the version in package.json, and the release tag are
 * always the same number. Nothing enforced it. The publish workflow compared the
 * tag against package.json only, so a pull request that bumped package.json but
 * forgot its changelog entry produced a green release with a changelog that
 * never mentioned the version it shipped.
 *
 * Deliberately dependency-free so the publish workflow can run it before
 * `npm ci`, and so a bad tag costs seconds rather than a full install.
 *
 *   node scripts/check-release.mjs                 # package.json vs CHANGELOG
 *   node scripts/check-release.mjs --tag v3.5.0    # also check the tag
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Parse `X.Y.Z` into comparable parts, or null if it is not a bare release version. */
function parseVersion(value) {
    const match = SEMVER.exec(value);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** -1, 0, or 1. Both arguments must already have come back from parseVersion. */
function compareVersions(a, b) {
    for (let i = 0; i < 3; i += 1) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
}

/**
 * Every `## [X.Y.Z] - YYYY-MM-DD` heading, in file order. The date is required:
 * it is what distinguishes a release heading from any other `## [...]` line that
 * might appear in prose, and every existing entry has one.
 */
export function parseChangelogVersions(changelog) {
    const headings = [...changelog.matchAll(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})\s*$/gm)];
    return headings.map((heading) => heading[1]);
}

/**
 * Returns a list of human-readable problems. Empty means the release is
 * consistent. Kept pure so tests can drive it without touching the filesystem.
 */
export function findReleaseProblems({ packageVersion, changelog, tag = null }) {
    const problems = [];

    const parsedPackage = parseVersion(packageVersion);
    if (!parsedPackage) {
        problems.push(
            `package.json version "${packageVersion}" is not a bare X.Y.Z release version. ` +
            'Prereleases and build metadata are not part of this release flow.',
        );
    }

    const changelogVersions = parseChangelogVersions(changelog);
    if (changelogVersions.length === 0) {
        problems.push(
            'CHANGELOG.md has no `## [X.Y.Z] - YYYY-MM-DD` release heading. ' +
            'Every release needs its own entry; see the bump rules at the top of that file.',
        );
        return problems;
    }

    const [topVersion, previousVersion] = changelogVersions;

    if (topVersion !== packageVersion) {
        problems.push(
            `CHANGELOG.md's newest entry is [${topVersion}] but package.json is ${packageVersion}. ` +
            'A pull request moves both to its own version in the same change.',
        );
    }

    const parsedTop = parseVersion(topVersion);
    if (!parsedTop) {
        problems.push(`CHANGELOG.md's newest entry [${topVersion}] is not a bare X.Y.Z version.`);
    }

    // Catches the entry that was copied from the one below it and never
    // renumbered, and an entry filed out of order.
    if (parsedTop && previousVersion !== undefined) {
        const parsedPrevious = parseVersion(previousVersion);
        if (parsedPrevious && compareVersions(parsedTop, parsedPrevious) !== 1) {
            problems.push(
                `CHANGELOG.md's newest entry [${topVersion}] is not greater than the entry ` +
                `below it, [${previousVersion}]. Entries run newest first, one bump per change.`,
            );
        }
    }

    // Two entries claiming the same version means one of them silently lost its
    // own release notes, which is invisible once the release is out.
    const seen = new Set();
    for (const version of changelogVersions) {
        if (seen.has(version)) {
            problems.push(`CHANGELOG.md has more than one entry for [${version}].`);
            break;
        }
        seen.add(version);
    }

    if (tag !== null) {
        const tagVersion = tag.startsWith('v') ? tag.slice(1) : tag;
        if (tagVersion !== packageVersion) {
            problems.push(
                `Tag ${tag} does not match package.json version ${packageVersion}. ` +
                'Tag the commit whose package.json already holds the version being released.',
            );
        }
    }

    return problems;
}

function main(argv) {
    const tagIndex = argv.indexOf('--tag');
    const tag = tagIndex === -1 ? null : argv[tagIndex + 1];
    if (tagIndex !== -1 && (tag === undefined || tag.startsWith('--'))) {
        console.error('check-release: --tag needs a value, e.g. --tag v3.5.0');
        return 1;
    }

    const packageVersion = JSON.parse(
        readFileSync(join(repoRoot, 'package.json'), 'utf8'),
    ).version;
    const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');

    const problems = findReleaseProblems({ packageVersion, changelog, tag });

    if (problems.length > 0) {
        console.error('Release is not consistent:\n');
        for (const problem of problems) console.error(`  - ${problem}`);
        console.error('\nSee RELEASING.md, "Release a version".');
        return 1;
    }

    console.log(
        `Release ${packageVersion} is consistent` +
        `${tag ? ` with tag ${tag}` : ''}: package.json and CHANGELOG.md agree.`,
    );
    return 0;
}

// Only run when invoked directly, so the test suite can import the pure helpers.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    process.exit(main(process.argv.slice(2)));
}
