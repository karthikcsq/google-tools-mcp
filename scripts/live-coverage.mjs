#!/usr/bin/env node
// live-coverage: which registered tools are actually exercised against the real
// Google API, and which are not.
//
//   npm run live-coverage              summary + the uncovered list
//   npm run live-coverage -- --json    machine-readable, for a test to assert on
//
// Why this exists: "all 92 test suites pass" and "this tool works" are different
// claims. Every Docs test mocks `documents.get`, and a mock cannot reject an
// invalid field mask -- which is how `readDocument(format='index')` shipped
// 100% broken with a fully green suite. This script refuses to let the gap be
// invisible: it counts what has been driven through the real API, and names
// everything that has not.
//
// It does NOT hit the network. Tool names come from registering every category
// against a recording stub, exactly as tests/toolRegistration.test.js does.
//
// WHAT THE NUMBER MEANS, precisely, because a coverage figure that overstates
// itself is worse than none: "covered" means a checked-in scenario names this
// tool in a ctx.call/ctx.tryCall literal. That is an UPPER BOUND on what
// reached Google. A call rejected by the tool's own zod schema never leaves the
// process, and a static scan cannot see that. What the scan CAN rule out
// exactly is the blocked set, so it does: BLOCKED_TOOLS are refused before
// execute() by construction, and they are reported separately instead of being
// counted as live-covered. That was not academic -- checklist-5 calls
// forwardMessage once, solely to assert the runner blocks it, and that single
// call was inflating the covered count with a tool that can never run.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BLOCKED_TOOLS } from './live-smoke/context.mjs';
import { MUTATING_VERB } from './live-smoke/guard.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Directories holding code that calls tools through a live context.
// live/{docs,drive,gmail,checklist} are the checked-in assertion scenarios;
// live/missions are agent-authored missions from the live agent loop.
const LIVE_DIRS = ['live'];

/** Register every category against a stub and return the tool names. */
async function registeredToolNames() {
    const names = new Set();
    const server = {
        addTool(def) {
            if (names.has(def.name)) throw new Error(`Duplicate tool name: ${def.name}`);
            names.add(def.name);
        },
    };
    const entry = path.join(REPO_ROOT, 'dist', 'tools', 'index.js');
    const { registerAllTools } = await import(pathToFileURL(entry).href);
    await registerAllTools(server);
    return names;
}

// live/missions/archive holds frozen iteration transcripts that are kept as a
// record and are not expected to pass; a call in one of them is not evidence
// that the tool is exercised by anything that runs green today.
const SKIP_DIRS = new Set(['archive', 'fixtures']);

function walk(dir, out = [], ext = '.mjs') {
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) { if (!SKIP_DIRS.has(name)) walk(full, out, ext); }
        else if (full.endsWith(ext)) out.push(full);
    }
    return out;
}

// ctx.call('x'), ctx.tryCall('x'), and the bare forms a destructured context
// produces. Only string literals count -- a computed tool name is not evidence
// that any particular tool ran. Any quote style is accepted, because the
// planned repo-wide reformat (#130) may well switch to double quotes, and a
// regex that only knew single quotes would then report 0 covered with exit 0.
// (An `expectError` alternative used to be matched here; no such helper exists
// on ctx, so it could only ever have produced a false positive.)
const CALL_RE = /\b(?:call|tryCall)\(\s*(['"`])([A-Za-z_][A-Za-z0-9_]*)\1/g;

// Context helpers that drive a tool without naming it: ctx.createDoc() calls
// createDocument and ctx.createFolder() calls createFolder (context.mjs). Every
// Docs scenario starts with createDoc, so without this the single most
// exercised tool in the harness was credited to the one scenario that happened
// to spell its name out, and createFolder was listed as "not live-covered".
const HELPER_TOOLS = [
    [/\bcreateDoc\(/, 'createDocument'],
    [/\bcreateFolder\(/, 'createFolder'],
];

function coverageByFile() {
    const byTool = new Map();
    const add = (tool, rel) => {
        if (!byTool.has(tool)) byTool.set(tool, new Set());
        byTool.get(tool).add(rel);
    };
    for (const root of LIVE_DIRS) {
        for (const file of walk(path.join(REPO_ROOT, root))) {
            const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
            const src = fs.readFileSync(file, 'utf8');
            for (const m of src.matchAll(CALL_RE)) add(m[2], rel);
            for (const [re, tool] of HELPER_TOOLS) if (re.test(src)) add(tool, rel);
        }
    }
    return byTool;
}

const registered = await registeredToolNames();
const byTool = coverageByFile();

// A name that appears in a scenario but is not registered means a scenario is
// calling something that no longer exists -- a silently dead assertion.
const phantom = [...byTool.keys()].filter((t) => !registered.has(t)).sort();
// A scenario that names a blocked tool is asserting the block holds, which is
// worth doing and is the opposite of live coverage: the runner refuses it
// before execute(), so it provably never reached Google.
// Tools the guard refuses at the API layer rather than the runner refusing at
// the tool layer. Same conclusion for coverage -- they provably never reach
// Google -- but BLOCKED_TOOLS does not list them, because the deny lives in
// scripts/live-smoke/guard.mjs against an API path, not a tool name.
//
// This used to be a hand-written set containing `createPresentation`, with
// nothing checking it against guard.mjs. It is now derived: the deny table and
// the read-only client list are read out of guard.mjs, and every tool module
// is scanned for the first Google API call it makes. A tool whose first call
// is one the guard refuses can never get past it, so it is reported as blocked
// rather than covered. "First call" is a static heuristic: a tool that reads
// before it writes stays in the covered set, which keeps the number an upper
// bound, the same as everything else here.
function guardDeniedTools(registered) {
    const guardSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'live-smoke', 'guard.mjs'), 'utf8');
    // 'presentations.create': deny(...)   ->  presentations.create
    const deniedPaths = new Set([...guardSrc.matchAll(/'([A-Za-z.]+)':\s*deny\(/g)].map((m) => m[1]));
    // ['calendar', getCalendarClient, () => readOnlyDecider('calendar')]
    const readOnlyClients = new Set([...guardSrc.matchAll(/readOnlyDecider\('(\w+)'\)/g)].map((m) => m[1]));
    if (deniedPaths.size === 0 || readOnlyClients.size === 0) {
        throw new Error('live-coverage: could not read the deny table or the read-only client list out of guard.mjs; the scan is out of date.');
    }
    const denied = (label, apiPath) => deniedPaths.has(apiPath)
        || (readOnlyClients.has(label) && MUTATING_VERB.test(apiPath.split('.').pop()));

    const out = new Set();
    for (const file of walk(path.join(REPO_ROOT, 'dist', 'tools'), [], '.js')) {
        const src = fs.readFileSync(file, 'utf8');
        // One tool per module is the convention; a module registering several
        // is skipped rather than guessed at.
        const names = [...src.matchAll(/\bname:\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((m) => m[1]).filter((n) => registered.has(n));
        if (names.length !== 1) continue;
        // const slides = await getSlidesClient();  ->  slides: 'slides'
        const vars = new Map([...src.matchAll(/\b(\w+)\s*=\s*await\s+get(\w+)Client\(\)/g)].map((m) => [m[1], m[2].toLowerCase()]));
        if (vars.size === 0) continue;
        const callRe = new RegExp(`\\b(${[...vars.keys()].join('|')})\\.((?:[A-Za-z]+\\.)+[A-Za-z]+)\\(`, 'g');
        const first = callRe.exec(src);
        if (first && denied(vars.get(first[1]), first[2])) out.add(names[0]);
    }
    if (out.size === 0) {
        throw new Error('live-coverage: derived an empty guard-denied set, which cannot be right while guard.mjs denies presentations.create.');
    }
    return out;
}

const GUARD_DENIED_TOOLS = guardDeniedTools(registered);
const cannotReachGoogle = (t) => BLOCKED_TOOLS.has(t) || GUARD_DENIED_TOOLS.has(t);

const blocked = [...byTool.keys()].filter((t) => registered.has(t) && cannotReachGoogle(t)).sort();
const covered = [...byTool.keys()].filter((t) => registered.has(t) && !cannotReachGoogle(t)).sort();
const uncovered = [...registered].filter((t) => !byTool.has(t) || cannotReachGoogle(t)).sort();

if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
        registered: registered.size,
        covered,
        blocked,
        uncovered,
        phantom,
    }, null, 2));
} else {
    const pct = ((covered.length / registered.size) * 100).toFixed(1);
    console.log(`\n  registered tools     ${registered.size}`);
    console.log(`  live-covered         ${covered.length}  (${pct}%)`);
    console.log(`  not live-covered     ${uncovered.length}`);
    if (blocked.length) console.log(`  blocked by design    ${blocked.length}  (named by a scenario, never executed)`);
    console.log('\n  "Live-covered" means a scenario names the tool in a call literal. It is an');
    console.log('  upper bound: a call rejected by the tool\'s own schema never reaches Google,');
    console.log('  and a static scan cannot tell the difference.\n');
    console.log('  Live-covered:');
    for (const t of covered) {
        console.log(`    ${t.padEnd(28)} ${[...byTool.get(t)].sort().join(', ')}`);
    }
    if (blocked.length) {
        console.log('\n  Blocked by the runner, so NOT live-covered:');
        for (const t of blocked) {
            console.log(`    ${t.padEnd(28)} ${[...byTool.get(t)].sort().join(', ')}`);
        }
    }
    console.log('\n  Not live-covered (unit tests only):');
    for (let i = 0; i < uncovered.length; i += 4) {
        console.log('    ' + uncovered.slice(i, i + 4).map((t) => t.padEnd(28)).join('').trimEnd());
    }
    if (phantom.length) {
        console.log('\n  WARNING: scenarios call tools that are not registered:');
        for (const t of phantom) console.log(`    ${t} -> ${[...byTool.get(t)].sort().join(', ')}`);
    }
    console.log('');
}

// Zero covered tools cannot be a true reading of this repository: it means the
// scan stopped seeing calls (a moved directory, a changed helper name), and a
// silent 0 is exactly the failure this script exists to prevent.
if (covered.length === 0) {
    console.error('live-coverage: found no covered tools at all, which means the scan is broken, not the coverage.');
    process.exit(1);
}
process.exit(phantom.length ? 1 : 0);
