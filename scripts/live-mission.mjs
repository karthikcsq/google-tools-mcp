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
import { classifyCreation } from './live-smoke/createdResource.mjs';
import { runCleanup, listLeftovers, listLeftoverDrafts, keepCommands } from './live-smoke/cleanup.mjs';

const LIVE_DIR = path.join(REPO_ROOT, 'live');

/**
 * Wrap ctx.call / ctx.tryCall so any successful creating-tool call registers
 * its new resource for cleanup, whether or not the mission remembered to.
 *
 * Checked-in live/ scenarios call ctx.track() by hand, which is fine because a
 * human reviewed them. A mission is written by an agent chasing a goal, and
 * "remember to register every file you create for cleanup" is exactly the kind
 * of bookkeeping an agent drops. Forgetting it leaks real files into a real
 * Drive, so the runner does it automatically instead of trusting the mission.
 *
 * `untracked` collects any creating call whose id could not be found. That has
 * to be loud: a silent skip is how the runner came to print "cleanup 5/5" for a
 * run that had actually left a presentation behind, because it only ever
 * counted the resources it managed to notice.
 */
function autoTrackCreations(ctx, registry, untracked) {
    const seen = new Set(registry.map((item) => item.id));
    const register = (toolName, result) => {
        const creation = classifyCreation(toolName, result);
        if (!creation) return;
        if (!creation.id) {
            untracked.push({ tool: toolName, preview: String(result ?? '').replace(/\s+/g, ' ').slice(0, 160) });
            return;
        }
        if (seen.has(creation.id)) return;
        seen.add(creation.id);
        ctx.track(creation.id, creation.kind);
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
        '',
        'Exit code: a FAILED MISSION EXITS 0 (it is a finding). The runner exits 1 only when it',
        'could not do its own job: a safety refusal the mission did not declare via',
        '`export const expectsSafetyRefusals = N`, a stdout write from the tool code path,',
        'cleanup leaving something behind, a creating call whose result named no id it could',
        'register (UNTRACKED), or an item of this run still in the sandbox after cleanup.',
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
    // Creating calls that succeeded but whose id the runner could not find.
    // Each one is something real, sitting in the sandbox, that cleanup will
    // never reach.
    const untracked = [];

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
    autoTrackCreations(ctx, registry, untracked);

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
    // Independent of the registry: what is actually still in the sandbox. The
    // registry only ever describes what the runner noticed, so "cleanup N/N"
    // on its own cannot tell a clean sandbox from a blind runner.
    const leftover = keep ? null : await listLeftovers({ tools, folderId, registry, runId, journal });
    const drafts = keep ? { left: [], unverified: [] } : await listLeftoverDrafts({ tools, registry });
    const leftoverDrafts = drafts.left;
    await journal.close();

    const { perTool, calls } = summarizeCalls(journal.file);
    const report = {
        mission: missionName,
        goal: mission.goal ?? null,
        runId,
        status,
        reason,
        durationMs,
        // bootstrap() already unwrapped getProfile's JSON down to the address
        // string; reading `.emailAddress` off a string made this null in every
        // report the runner has ever written.
        account: typeof self === 'string' ? self : null,
        sandboxFolderId: folderId,
        totals: {
            toolCalls: calls.length,
            failedCalls: calls.filter((c) => !c.ok).length,
            distinctTools: perTool.length,
            // Both layers of the envelope: the guard refusing an API call
            // ('safety-refused') and the runner refusing a tool by name before
            // execute() ('blocked'). The block list is layer 1 of the envelope;
            // a mission that reaches for sendMessage must show up here.
            safetyRefusals: calls.filter((c) => c.outcome === 'safety-refused' || c.outcome === 'blocked').length,
            expectedSafetyRefusals: Number(mission.expectsSafetyRefusals ?? 0),
            stdoutLeaks: journal.stdoutLeaks,
        },
        perTool,
        notes,
        frictions,
        cleanup,
        // Every id the runner registered, so a --keep run (or a failed cleanup)
        // names exactly what is sitting in the sandbox.
        registry: registry.map(({ id, kind }) => ({ id, kind })),
        leftover: leftover ? { owned: leftover.owned, foreign: leftover.foreign, unverified: leftover.unverified } : null,
        leftoverDrafts,
        unverifiedDrafts: drafts.unverified,
        untracked,
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
    if (cleanup.skipped) {
        for (const item of registry) line(`    KEPT ${item.kind} ${item.id}`);
        for (const command of keepCommands(registry)) line(`    ${command}`);
    }
    for (const f of cleanup.failures) line(`    LEFT BEHIND ${f.kind} ${f.id}: ${f.reason}`);
    if (leftover?.all) {
        line(`  sandbox     ${leftover.all.length} item(s) after cleanup`);
        for (const f of leftover.owned) line(`    LEFT BEHIND by this run: ${f.name} (${f.id})`);
        for (const f of leftover.foreign) line(`    not this run's: ${f.name} (${f.id})`);
    } else if (leftover?.unverified) {
        line(`  sandbox     UNVERIFIED: ${leftover.unverified}`);
    }
    for (const id of leftoverDrafts) line(`    LEFT BEHIND draft ${id}`);
    for (const d of drafts.unverified) line(`    UNVERIFIED draft ${d.id}: ${d.reason}`);
    // Printed next to the cleanup count on purpose: without it, that count is a
    // ratio of the resources the runner happened to recognize, and reads as a
    // clean sandbox no matter how many it missed.
    for (const u of untracked) {
        line(`    UNTRACKED ${u.tool} succeeded but named no id the runner could parse: ${u.preview}`);
    }
    line(`  report      ${path.relative(REPO_ROOT, reportFile)}`);
    line('');

    // A mission that failed is a finding, not a runner error. The runner only
    // exits non-zero when it could not do its own job: a safety refusal, a
    // stdout leak from the tool code path, or cleanup leaving something behind.
    //
    // `expectsSafetyRefusals` is the one exception, and it is opt-in per
    // mission and exact. Some boundaries are enforced only by the guard --
    // Slides creation lands in Drive root whatever parent you give it, so
    // guard.mjs denies it outright -- and the only way to prove such a deny
    // still holds is to trip it on purpose. A mission that declares how many it
    // expects gets exactly that many forgiven; one more than it declared is
    // still a failure, so this cannot be used to wave refusals through.
    const expected = Number(mission.expectsSafetyRefusals ?? 0);
    const unexpectedRefusals = report.totals.safetyRefusals - (Number.isFinite(expected) ? expected : 0);
    if (expected > 0) {
        line(`  NOTE        mission declared ${expected} expected safety refusal(s); saw ${report.totals.safetyRefusals}`);
        line('');
    }
    const runnerFailed = unexpectedRefusals !== 0
        || journal.stdoutLeaks > 0
        || cleanup.failures.length > 0
        // An untracked creation is the same class of failure as a cleanup
        // failure -- something real is still in the sandbox -- and it is worse,
        // because nothing else in the report would ever mention it.
        || untracked.length > 0
        // And the check that does not trust the registry at all. An audit
        // that could not be completed is a failure too: "nothing found"
        // and "could not look" must never print the same exit code.
        || (leftover?.owned.length ?? 0) > 0
        || Boolean(leftover?.unverified)
        || leftoverDrafts.length > 0
        || drafts.unverified.length > 0;
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
