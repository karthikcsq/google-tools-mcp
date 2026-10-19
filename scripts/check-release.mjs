#!/usr/bin/env node
/**
 * Release consistency gate.
 *
 * CONTRIBUTING.md and CHANGELOG.md both state the same rule: the version at the
 * top of the changelog, the version in package.json, and the release tag are
 * always the same version. Nothing enforced it. The publish workflow compared the
 * tag against package.json only, so a pull request that bumped package.json but
 * forgot its changelog entry produced a green release with a changelog that
 * never mentioned the version it shipped.
 *
 * Deliberately dependency-free so the publish workflow can run it before
 * `npm ci`, and so a bad tag costs seconds rather than a full install.
 *
 *   node scripts/check-release.mjs                 # package.json vs CHANGELOG
 *   node scripts/check-release.mjs --tag v3.5.0-rc.1    # also check the tag
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const NUMERIC_IDENTIFIER = '(?:0|[1-9]\\d*)';
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(
    `^(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})` +
        `(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?` +
        '(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$',
);

/** Parse a SemVer 2.0.0 version into comparable parts, or return null. */
export function parseVersion(value) {
    const match = SEMVER.exec(value);
    if (!match) return null;
    return {
        core: [match[1], match[2], match[3]],
        prerelease: match[4] === undefined ? null : match[4].split('.'),
        build: match[5] === undefined ? null : match[5].split('.'),
    };
}

/** Select npm's release channel from parsed SemVer, never from shell globbing. */
export function distributionTagForVersion(value) {
    const parsed = parseVersion(value);
    if (!parsed) throw new Error(`Invalid Semantic Version: ${value}`);
    return parsed.prerelease === null ? 'latest' : 'next';
}

function compareNumericIdentifiers(a, b) {
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    return a === b ? 0 : a < b ? -1 : 1;
}

function isNumericIdentifier(value) {
    return /^(?:0|[1-9]\d*)$/.test(value);
}

/** -1, 0, or 1 following SemVer 2.0.0 precedence. Build metadata is ignored. */
export function compareVersions(a, b) {
    for (let i = 0; i < 3; i += 1) {
        const coreComparison = compareNumericIdentifiers(a.core[i], b.core[i]);
        if (coreComparison !== 0) return coreComparison;
    }

    if (a.prerelease === null && b.prerelease === null) return 0;
    if (a.prerelease === null) return 1;
    if (b.prerelease === null) return -1;

    const length = Math.min(a.prerelease.length, b.prerelease.length);
    for (let i = 0; i < length; i += 1) {
        const left = a.prerelease[i];
        const right = b.prerelease[i];
        if (left === right) continue;

        const leftNumeric = isNumericIdentifier(left);
        const rightNumeric = isNumericIdentifier(right);
        if (leftNumeric && rightNumeric)
            return compareNumericIdentifiers(left, right);
        if (leftNumeric) return -1;
        if (rightNumeric) return 1;
        return left < right ? -1 : 1;
    }

    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length < b.prerelease.length ? -1 : 1;
}

/**
 * Every `## [SEMVER] - YYYY-MM-DD` heading, in file order. The date is required:
 * it is what distinguishes a release heading from any other `## [...]` line that
 * might appear in prose, and every existing entry has one.
 */
export function parseChangelogVersions(changelog) {
    const headings = [
        ...changelog.matchAll(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})\s*$/gm),
    ];
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
            `package.json version "${packageVersion}" is not a valid Semantic Version. ` +
                'Use X.Y.Z, optionally followed by a SemVer prerelease or build identifier.',
        );
    }

    const changelogVersions = parseChangelogVersions(changelog);
    if (changelogVersions.length === 0) {
        problems.push(
            'CHANGELOG.md has no `## [X.Y.Z[-PRERELEASE]] - YYYY-MM-DD` release heading. ' +
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
        problems.push(
            `CHANGELOG.md's newest entry [${topVersion}] is not a valid Semantic Version.`,
        );
    }

    // Catches the entry that was copied from the one below it and never
    // renumbered, and an entry filed out of order.
    if (parsedTop && previousVersion !== undefined) {
        const parsedPrevious = parseVersion(previousVersion);
        if (
            parsedPrevious &&
            compareVersions(parsedTop, parsedPrevious) !== 1
        ) {
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
            problems.push(
                `CHANGELOG.md has more than one entry for [${version}].`,
            );
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
