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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full, out);
        else if (full.endsWith('.mjs')) out.push(full);
    }
    return out;
}

// ctx.call('x'), ctx.tryCall('x'), ctx.expectError('x'), and the bare forms a
// destructured context produces. Only single-quoted string literals count --
// a computed tool name is not evidence that any particular tool ran.
const CALL_RE = /\b(?:call|tryCall|expectError)\(\s*'([A-Za-z_][A-Za-z0-9_]*)'/g;

function coverageByFile() {
    const byTool = new Map();
    for (const root of LIVE_DIRS) {
        for (const file of walk(path.join(REPO_ROOT, root))) {
            const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
            const src = fs.readFileSync(file, 'utf8');
            for (const m of src.matchAll(CALL_RE)) {
                if (!byTool.has(m[1])) byTool.set(m[1], new Set());
                byTool.get(m[1]).add(rel);
            }
        }
    }
    return byTool;
}

const registered = await registeredToolNames();
const byTool = coverageByFile();

// A name that appears in a scenario but is not registered means a scenario is
// calling something that no longer exists -- a silently dead assertion.
const phantom = [...byTool.keys()].filter((t) => !registered.has(t)).sort();
const covered = [...byTool.keys()].filter((t) => registered.has(t)).sort();
const uncovered = [...registered].filter((t) => !byTool.has(t)).sort();

if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
        registered: registered.size,
        covered,
        uncovered,
        phantom,
    }, null, 2));
} else {
    const pct = ((covered.length / registered.size) * 100).toFixed(1);
    console.log(`\n  registered tools     ${registered.size}`);
    console.log(`  live-covered         ${covered.length}  (${pct}%)`);
    console.log(`  not live-covered     ${uncovered.length}\n`);
    console.log('  Live-covered:');
    for (const t of covered) {
        console.log(`    ${t.padEnd(28)} ${[...byTool.get(t)].sort().join(', ')}`);
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

process.exit(phantom.length ? 1 : 0);
