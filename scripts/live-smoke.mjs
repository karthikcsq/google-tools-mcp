#!/usr/bin/env node
// live-smoke: run the pre-merge live scenarios against real Google APIs, using
// the dist/ of the worktree this script lives in.
//
//   npm run live-smoke                       every scenario
//   npm run live-smoke -- docs               one cluster
//   npm run live-smoke -- issue-118-...      one scenario, by file name or scenario name
//   npm run live-smoke -- --list             what exists, without calling anything
//   npm run live-smoke -- docs --keep        skip cleanup so the artifacts can be inspected
//
// Determinism rules this runner enforces:
//   * scenarios run in a stable order (cluster order, then file name);
//   * every document is seeded from a checked-in fixture under live/fixtures/,
//     never from text generated at run time;
//   * nothing reads pre-existing Drive state -- each scenario creates what it
//     needs inside the sandbox;
//   * created names carry the run id, so two concurrent runs cannot collide;
//   * a failure anywhere makes the process exit non-zero.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { bootstrap, REPO_ROOT } from './live-smoke/bootstrap.mjs';
import { createContext, AssertionFailure, ScenarioSkipped } from './live-smoke/context.mjs';

const CLUSTERS = ['docs', 'drive', 'gmail', 'checklist'];
const LIVE_DIR = path.join(REPO_ROOT, 'live');

function discover() {
    const found = [];
    for (const cluster of CLUSTERS) {
        const dir = path.join(LIVE_DIR, cluster);
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir)
            .filter((f) => f.endsWith('.mjs'))
            .sort((a, b) => a.localeCompare(b, 'en'));
        for (const file of files) found.push({ cluster, file, fullPath: path.join(dir, file) });
    }
    return found;
}

async function loadScenario(entry) {
    const mod = await import(pathToFileURL(entry.fullPath).href);
    const scenario = mod.default ?? mod.scenario ?? mod;
    for (const key of ['name', 'run']) {
        if (!scenario?.[key]) throw new Error(`${entry.fullPath} does not export a "${key}".`);
    }
    return {
        cluster: entry.cluster,
        file: entry.file,
        slug: entry.file.replace(/\.mjs$/, ''),
        name: scenario.name,
        issue: scenario.issue ?? '',
        description: scenario.description ?? '',
        expectedOnBase: scenario.expectedOnBase ?? 'pass',
        run: scenario.run,
    };
}

function selectScenarios(all, selectors) {
    if (!selectors.length) return all;
    const wanted = new Set(selectors.map((s) => s.replace(/\.mjs$/, '')));
    const picked = all.filter((s) => wanted.has(s.cluster) || wanted.has(s.slug) || wanted.has(s.name) || wanted.has(String(s.issue)));
    const matched = new Set();
    for (const s of picked) {
        for (const w of wanted) {
            if (w === s.cluster || w === s.slug || w === s.name || w === String(s.issue)) matched.add(w);
        }
    }
    const unknown = [...wanted].filter((w) => !matched.has(w));
    if (unknown.length) {
        throw new Error(`Unknown cluster or scenario: ${unknown.join(', ')}\nKnown clusters: ${CLUSTERS.join(', ')}`);
    }
    return picked;
}

function pad(value, width) {
    const text = String(value ?? '');
    return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function oneLine(text, max = 96) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

async function runCleanup({ registry, guard, tools, journal, keep }) {
    if (keep) {
        journal.progress(`\n--keep: leaving ${registry.length} created item(s) in place.`);
        return { attempted: 0, cleaned: 0, failures: [], skipped: true };
    }
    const failures = [];
    let cleaned = 0;
    const originals = await guard.rawDrive();
    const silent = { log: { debug() {}, info() {}, warn() {}, error() {} } };
    // Reverse creation order: files before the folders that hold them.
    for (const item of registry.slice().reverse()) {
        try {
            if (item.kind === 'draft') {
                await tools.get('deleteDraft').execute({ id: item.id }, silent);
            } else {
                // Re-verify containment at cleanup time. Boundary 4: this step
                // trashes exactly what the run created and nothing else.
                if (!(await guard.isInsideTestFolder(item.id))) {
                    failures.push({ ...item, reason: 'no longer inside the test folder; refused to trash' });
                    continue;
                }
                await originals['files.update']({ fileId: item.id, requestBody: { trashed: true }, supportsAllDrives: true });
            }
            cleaned += 1;
            journal.write({ kind: 'cleanup', id: item.id, resource: item.kind, scenario: item.scenario, ok: true });
        } catch (error) {
            const reason = error?.message || String(error);
            if (/not ?found|404/i.test(reason)) { cleaned += 1; continue; }
            failures.push({ ...item, reason });
            journal.write({ kind: 'cleanup', id: item.id, resource: item.kind, scenario: item.scenario, ok: false, error: reason });
        }
    }
    return { attempted: registry.length, cleaned, failures, skipped: false };
}

async function main() {
    const argv = process.argv.slice(2);
    const keep = argv.includes('--keep');
    const listOnly = argv.includes('--list');
    const selectors = argv.filter((a) => !a.startsWith('--'));

    const entries = discover();
    const all = [];
    for (const entry of entries) all.push(await loadScenario(entry));
    const selected = selectScenarios(all, selectors);

    if (listOnly) {
        const width = Math.max(20, ...all.map((s) => s.slug.length));
        for (const cluster of CLUSTERS) {
            const inCluster = all.filter((s) => s.cluster === cluster);
            if (!inCluster.length) continue;
            process.stdout.write(`${cluster}\n`);
            for (const s of inCluster) {
                process.stdout.write(`  ${pad(s.slug, width)}  ${pad(s.issue ? `#${s.issue}` : '', 6)}  ${s.expectedOnBase === 'fail' ? 'expected-fail' : 'expected-pass'}  ${oneLine(s.description, 70)}\n`);
            }
        }
        return 0;
    }

    const boot = await bootstrap({ label: 'scenarios' });
    const { tools, guard, journal, folderId, runId, self } = boot;
    const registry = [];
    const results = [];

    journal.progress(`  scenarios  ${selected.length} of ${all.length}\n`);

    try {
        for (const scenario of selected) {
            journal.progress(`  [${scenario.cluster}] ${scenario.slug}${scenario.issue ? ` (#${scenario.issue})` : ''}`);
            const ctx = createContext({ scenario, tools, guard, journal, folderId, self, registry });
            ctx.runId = runId;
            ctx.fixture = (name) => fs.readFileSync(path.join(LIVE_DIR, 'fixtures', name), 'utf8');
            ctx.title = (label) => `${label} ${runId}`;
            const started = Date.now();
            journal.lockStdout();
            let status = 'pass';
            let reason = '';
            try {
                await scenario.run(ctx);
                reason = 'assertions held';
            } catch (error) {
                if (error instanceof ScenarioSkipped || error?.skipped) {
                    status = 'skip';
                    reason = error.message;
                } else if (error instanceof AssertionFailure || error?.assertion) {
                    status = 'fail';
                    reason = error.message;
                } else if (error?.safety) {
                    status = 'fail';
                    reason = `SAFETY REFUSAL: ${error.message}`;
                } else {
                    status = 'fail';
                    reason = `${error?.name || 'Error'}: ${error?.message || String(error)}`;
                    journal.write({ kind: 'scenario-error', scenario: scenario.name, stack: error?.stack });
                }
            } finally {
                journal.unlockStdout();
            }
            const durationMs = Date.now() - started;
            results.push({ ...scenario, status, reason, durationMs });
            journal.write({ kind: 'scenario-result', scenario: scenario.name, cluster: scenario.cluster, issue: scenario.issue, status, reason, durationMs, expectedOnBase: scenario.expectedOnBase });
            journal.progress(`      ${status.toUpperCase()} in ${(durationMs / 1000).toFixed(1)}s — ${oneLine(reason, 140)}\n`);
        }
    } finally {
        const cleanup = await runCleanup({ registry, guard, tools, journal, keep });

        // Boundary check, reported rather than assumed: what is left in the
        // sandbox after cleanup.
        let leftover = null;
        if (!keep) {
            try {
                const raw = await tools.get('listFolderContents').execute(
                    { folderId, includeSubfolders: true, includeFiles: true, maxResults: 100 },
                    { log: { debug() {}, info() {}, warn() {}, error() {} } },
                );
                leftover = JSON.parse(raw);
            } catch (error) {
                journal.progress(`  could not list the test folder after cleanup: ${error.message}`);
            }
        }

        // Same check for drafts, and done by id rather than by search: the
        // Gmail drafts.list response carries no subject, so the only honest
        // verification is to ask for each draft this run created and confirm it
        // is gone.
        let leftoverDrafts = null;
        if (!keep) {
            const draftIds = registry.filter((item) => item.kind === 'draft').map((item) => item.id);
            leftoverDrafts = [];
            for (const id of draftIds) {
                try {
                    await tools.get('getDraft').execute({ id }, { log: { debug() {}, info() {}, warn() {}, error() {} } });
                    leftoverDrafts.push(id);
                } catch {
                    // Gone, which is what cleanup was supposed to achieve.
                }
            }
        }

        // --- summary (the only thing that goes to stdout) ------------------
        const nameWidth = Math.max(18, ...results.map((r) => r.slug.length));
        const lines = [];
        lines.push('');
        lines.push(`live-smoke  run ${runId}  folder ${folderId}`);
        lines.push('');
        lines.push(`${pad('SCENARIO', nameWidth)}  ${pad('ISSUE', 6)}  ${pad('RESULT', 6)}  ${pad('BASE', 13)}  REASON`);
        lines.push(`${'-'.repeat(nameWidth)}  ${'-'.repeat(6)}  ${'-'.repeat(6)}  ${'-'.repeat(13)}  ${'-'.repeat(60)}`);
        for (const r of results) {
            const base = r.expectedOnBase === 'fail' ? 'expected-fail' : 'expected-pass';
            lines.push(`${pad(r.slug, nameWidth)}  ${pad(r.issue ? `#${r.issue}` : '-', 6)}  ${pad(r.status.toUpperCase(), 6)}  ${pad(base, 13)}  ${oneLine(r.reason)}`);
        }
        const passed = results.filter((r) => r.status === 'pass').length;
        const failed = results.filter((r) => r.status === 'fail').length;
        const skipped = results.filter((r) => r.status === 'skip').length;
        const unexpected = results.filter((r) => (r.status === 'fail') !== (r.expectedOnBase === 'fail') && r.status !== 'skip');
        lines.push('');
        lines.push(`${passed} passed, ${failed} failed, ${skipped} skipped, of ${results.length}.`);
        lines.push(`${unexpected.length} scenario(s) disagreed with expectedOnBase${unexpected.length ? `: ${unexpected.map((r) => r.slug).join(', ')}` : ''}.`);
        if (cleanup.skipped) {
            lines.push(`Cleanup skipped (--keep): ${registry.length} item(s) left in the test folder.`);
        } else {
            lines.push(`Cleanup: trashed ${cleanup.cleaned} of ${cleanup.attempted} created item(s).`);
            if (cleanup.failures.length) {
                lines.push('Could NOT clean up:');
                for (const f of cleanup.failures) lines.push(`  - ${f.kind} ${f.id} (${f.scenario}): ${f.reason}`);
            }
            if (leftover) {
                const remaining = (leftover.folders?.length ?? 0) + (leftover.files?.length ?? 0);
                lines.push(`Test folder after cleanup: ${remaining} item(s)${remaining ? ` — ${[...(leftover.folders || []), ...(leftover.files || [])].map((f) => `${f.name} (${f.id})`).join(', ')}` : ''}.`);
            }
            if (leftoverDrafts) {
                lines.push(`Drafts this run created and did not delete: ${leftoverDrafts.length}${leftoverDrafts.length ? ` — ${leftoverDrafts.join(', ')}` : ''}.`);
            }
        }
        lines.push(`Stdout leaks from tool code paths: ${journal.stdoutLeaks}.`);
        lines.push(`Guard: ${guard.stats.parentLookups} containment lookup(s), ${guard.stats.denials.length} refusal(s), ${guard.stats.quota.waits} quota wait(s), ${guard.stats.quota.retries} rate-limit retry(ies).`);
        for (const d of guard.stats.denials) lines.push(`  refused ${d.client}.${d.method}: ${oneLine(d.reason, 120)}`);
        lines.push(`Journal: ${journal.file}`);
        lines.push('');

        journal.toStdout(`${lines.join('\n')}`);
        journal.write({ kind: 'run-end', passed, failed, skipped, cleanup: { cleaned: cleanup.cleaned, attempted: cleanup.attempted, failures: cleanup.failures }, stdoutLeaks: journal.stdoutLeaks });
        await journal.close();

        process.exitCode = failed > 0 || cleanup.failures.length > 0 || (leftoverDrafts?.length ?? 0) > 0 ? 1 : 0;
    }
    return process.exitCode ?? 0;
}

main().catch((error) => {
    if (error?.refusal) process.stderr.write(`${error.message}\n`);
    else process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = error?.refusal ? 2 : 1;
});
