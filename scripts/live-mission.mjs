#!/usr/bin/env node
// live-mission: run ONE ad-hoc, agent-authored mission against the real Google
// APIs, inside the live-smoke safety envelope, and emit a structured report.
//
//   npm run live-mission -- live/missions/my-mission.mjs
//   npm run live-mission -- live/missions/my-mission.mjs --keep
//
// WHY THIS EXISTS, given live-smoke and live-call already do:
//
//   live-smoke   runs checked-in scenarios with assertions. It proves the things
//                we already thought to assert. It cannot discover friction we did
//                not anticipate, because every step was written by someone who
//                already knew the answer.
//   live-call    runs ONE tool in ONE process. Session state (the read tracker,
//                read handles) dies with the process, so a create-then-write
//                sequence -- the most common real agent workflow, and the exact
//                thing #87 and #135 are about -- cannot be exercised at all.
//   live-mission runs a whole multi-step task in ONE process, with real control
//                flow, written by an agent that was given a GOAL and not a script.
//                That is what a future MCP client session actually looks like.
//
// A mission is the same shape as a live/ scenario, minus the assertions:
//
//   export const name = 'meeting-notes';
//   export const goal = 'Produce a formatted meeting-notes doc, then revise it.';
//   export async function run(ctx) { ... }
//
// The report is the product. It records every tool call, every failure, every
// retry and every note the mission left behind, so the orchestrator can see what
// the tools cost an agent rather than only whether they eventually worked.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { bootstrap, REPO_ROOT, RESULTS_DIR } from './live-smoke/bootstrap.mjs';
import { createContext, AssertionFailure, ScenarioSkipped } from './live-smoke/context.mjs';

const LIVE_DIR = path.join(REPO_ROOT, 'live');

// Tools whose successful result names a resource this runner must clean up.
//
// Checked-in live/ scenarios call ctx.track() by hand, which is fine because a
// human reviewed them. A mission is written by an agent chasing a goal, and
// "remember to register every file you create for cleanup" is exactly the kind
// of bookkeeping an agent drops. Forgetting it leaks real files into a real
// Drive, so the runner does it automatically instead of trusting the mission.
// Kept in sync with the same map in scripts/live-smoke/call.mjs.
const CREATING_TOOLS = new Map([
    ['createDocument', 'drive'],
    ['createFolder', 'drive'],
    ['createDocumentFromTemplate', 'drive'],
    ['createSpreadsheet', 'drive'],
    ['createPresentation', 'drive'],
    ['copyFile', 'drive'],
    ['uploadFile', 'drive'],
    ['createDraft', 'draft'],
]);

/**
 * Wrap ctx.call / ctx.tryCall so any successful creating-tool call registers
 * its new resource for cleanup, whether or not the mission remembered to.
 */
function autoTrackCreations(ctx, registry) {
    const seen = new Set(registry.map((item) => item.id));
    const register = (toolName, result) => {
        const kind = CREATING_TOOLS.get(toolName);
        if (!kind) return;
        let id;
        try {
            id = JSON.parse(typeof result === 'string' ? result : JSON.stringify(result))?.id;
        } catch {
            // Not every creating tool returns JSON; a tool that does not name an
            // id cannot be auto-tracked, and the mission must track it by hand.
            return;
        }
        if (typeof id !== 'string' || !id || seen.has(id)) return;
        seen.add(id);
        ctx.track(id, kind);
    };

    const innerCall = ctx.call;
    const innerTryCall = ctx.tryCall;
    ctx.call = async (toolName, args) => {
        const result = await innerCall(toolName, args);
        register(toolName, result);
        return result;
    };
    ctx.tryCall = async (toolName, args) => {
        const outcome = await innerTryCall(toolName, args);
        if (outcome?.ok) register(toolName, outcome.result);
        return outcome;
    };
}

function usage() {
    return [
        'Usage: npm run live-mission -- <path/to/mission.mjs> [--keep]',
        '',
        'A mission module exports:',
        '  name  (string)              short slug for the report file',
        '  goal  (string)              the plain-language objective, for the report',
        '  run   (async ctx => void)   the work',
        '',
        'Inside run(ctx):',
        '  await ctx.call(tool, args)     throws on failure',
        '  await ctx.tryCall(tool, args)  returns {ok, result, error} and never throws',
        '  await ctx.createDoc(title, md) seeded doc inside the sandbox, auto-cleaned',
        '  ctx.title(label)               label + run id, so concurrent runs cannot collide',
        '  ctx.folderId                   the sandbox folder id',
        '  ctx.note(text)                 record an observation in the report',
        '  ctx.friction(tool, text)       record that a tool cost more than it should have',
        '',
        'Everything created inside the sandbox is trashed at the end unless --keep.',
    ].join('\n');
}

/**
 * Re-read the run journal and turn it into the per-tool friction summary that
 * makes a report worth reading: how many times each tool was called, how many
 * of those failed, and every distinct error message it produced.
 */
function summarizeCalls(journalFile) {
    const perTool = new Map();
    const calls = [];
    if (!fs.existsSync(journalFile)) return { perTool: [], calls };
    for (const line of fs.readFileSync(journalFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.kind !== 'tool-call') continue;
        calls.push({
            tool: entry.tool,
            args: entry.args,
            outcome: entry.outcome,
            ok: entry.ok,
            durationMs: entry.durationMs,
            error: entry.error,
        });
        const stat = perTool.get(entry.tool) ?? { tool: entry.tool, calls: 0, failures: 0, errors: [] };
        stat.calls += 1;
        if (!entry.ok) {
            stat.failures += 1;
            const message = String(entry.error ?? 'unknown');
            if (!stat.errors.includes(message)) stat.errors.push(message);
        }
        perTool.set(entry.tool, stat);
    }
    const sorted = [...perTool.values()].sort(
        (a, b) => b.failures - a.failures || a.tool.localeCompare(b.tool),
    );
    return { perTool: sorted, calls };
}

async function runCleanup({ registry, guard, tools, journal, keep }) {
    if (keep) {
        journal.progress(`\n--keep: leaving ${registry.length} created item(s) in place.`);
        return { attempted: registry.length, cleaned: 0, failures: [], skipped: true };
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
                // Re-verify containment at cleanup time: trash exactly what this
                // run created inside the sandbox, and nothing else, ever.
                if (!(await guard.isInsideTestFolder(item.id))) {
                    failures.push({ ...item, reason: 'no longer inside the test folder; refused to trash' });
                    continue;
                }
                await originals['files.update']({ fileId: item.id, requestBody: { trashed: true }, supportsAllDrives: true });
            }
            cleaned += 1;
        } catch (error) {
            const reason = error?.message || String(error);
            if (/not ?found|404/i.test(reason)) { cleaned += 1; continue; }
            failures.push({ ...item, reason });
        }
    }
    return { attempted: registry.length, cleaned, failures, skipped: false };
}

async function main() {
    const argv = process.argv.slice(2);
    const keep = argv.includes('--keep');
    const targets = argv.filter((a) => !a.startsWith('--'));
    if (targets.length !== 1) {
        process.stderr.write(`${usage()}\n`);
        return 2;
    }

    const missionPath = path.resolve(REPO_ROOT, targets[0]);
    if (!fs.existsSync(missionPath)) {
        process.stderr.write(`No such mission file: ${missionPath}\n`);
        return 2;
    }
    const mod = await import(pathToFileURL(missionPath).href);
    const mission = mod.default ?? mod;
    if (typeof mission.run !== 'function') {
        process.stderr.write(`${missionPath} does not export a run(ctx) function.\n`);
        return 2;
    }
    const missionName = mission.name ?? path.basename(missionPath, '.mjs');

    const boot = await bootstrap({ label: `mission ${missionName}` });
    const { tools, guard, journal, folderId, runId, self } = boot;
    const registry = [];
    const notes = [];
    const frictions = [];

    const ctx = createContext({
        scenario: { name: missionName },
        tools, guard, journal, folderId, self, registry,
    });
    ctx.runId = runId;
    ctx.fixture = (name) => fs.readFileSync(path.join(LIVE_DIR, 'fixtures', name), 'utf8');
    ctx.title = (label) => `${label} ${runId}`;
    ctx.note = (text) => {
        notes.push(String(text));
        journal.write({ kind: 'mission-note', mission: missionName, text: String(text) });
    };
    ctx.friction = (tool, text) => {
        frictions.push({ tool: String(tool), text: String(text) });
        journal.write({ kind: 'mission-friction', mission: missionName, tool: String(tool), text: String(text) });
    };
    autoTrackCreations(ctx, registry);

    journal.progress(`\n  mission    ${missionName}`);
    if (mission.goal) journal.progress(`  goal       ${mission.goal}`);
    journal.progress('');

    const started = Date.now();
    let status = 'pass';
    let reason = 'mission completed';
    journal.lockStdout();
    try {
        await mission.run(ctx);
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
            journal.write({ kind: 'mission-error', mission: missionName, stack: error?.stack });
        }
    } finally {
        journal.unlockStdout();
    }
    const durationMs = Date.now() - started;

    const cleanup = await runCleanup({ registry, guard, tools, journal, keep });
    await journal.close();

    const { perTool, calls } = summarizeCalls(journal.file);
    const report = {
        mission: missionName,
        goal: mission.goal ?? null,
        runId,
        status,
        reason,
        durationMs,
        account: self?.emailAddress ?? null,
        sandboxFolderId: folderId,
        totals: {
            toolCalls: calls.length,
            failedCalls: calls.filter((c) => !c.ok).length,
            distinctTools: perTool.length,
            safetyRefusals: calls.filter((c) => c.outcome === 'safety-refused').length,
            stdoutLeaks: journal.stdoutLeaks,
        },
        perTool,
        notes,
        frictions,
        cleanup,
        journalFile: path.relative(REPO_ROOT, journal.file),
        calls,
    };

    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const reportFile = path.join(RESULTS_DIR, `mission-${missionName}-${runId}.json`);
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

    const line = (t) => journal.toStdout(`${t}\n`);
    line('');
    line(`  mission     ${missionName}`);
    line(`  status      ${status.toUpperCase()}  (${reason})`);
    line(`  duration    ${durationMs}ms`);
    line(`  tool calls  ${report.totals.toolCalls} total, ${report.totals.failedCalls} failed, across ${report.totals.distinctTools} tools`);
    if (report.totals.safetyRefusals) line(`  SAFETY      ${report.totals.safetyRefusals} refusal(s) -- see the report`);
    if (journal.stdoutLeaks) line(`  STDOUT LEAK ${journal.stdoutLeaks} write(s) from the tool code path`);
    if (perTool.some((t) => t.failures)) {
        line('');
        line('  tools that failed at least once:');
        for (const t of perTool.filter((x) => x.failures)) {
            line(`    ${t.tool}  ${t.failures}/${t.calls} failed`);
            for (const e of t.errors.slice(0, 3)) line(`      - ${e.replace(/\s+/g, ' ').slice(0, 160)}`);
        }
    }
    if (frictions.length) {
        line('');
        line('  friction recorded by the mission:');
        for (const f of frictions) line(`    [${f.tool}] ${f.text.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    if (notes.length) {
        line('');
        line('  notes:');
        for (const n of notes) line(`    - ${n.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    line('');
    line(`  cleanup     ${cleanup.skipped ? 'skipped (--keep)' : `${cleanup.cleaned}/${cleanup.attempted} trashed`}`);
    for (const f of cleanup.failures) line(`    LEFT BEHIND ${f.kind} ${f.id}: ${f.reason}`);
    line(`  report      ${path.relative(REPO_ROOT, reportFile)}`);
    line('');

    // A mission that failed is a finding, not a runner error. The runner only
    // exits non-zero when it could not do its own job: a safety refusal, a
    // stdout leak from the tool code path, or cleanup leaving something behind.
    const runnerFailed = report.totals.safetyRefusals > 0
        || journal.stdoutLeaks > 0
        || cleanup.failures.length > 0;
    return runnerFailed ? 1 : 0;
}

main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
        if (error?.refusal) {
            process.stderr.write(`\n${error.message}\n`);
            process.exitCode = 2;
            return;
        }
        process.stderr.write(`\nlive-mission crashed: ${error?.stack || error}\n`);
        process.exitCode = 1;
    });
