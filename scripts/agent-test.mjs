#!/usr/bin/env node
// Consumer-facing controller for persistent, guarded MCP test sessions.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    RESULTS_ROOT, ensurePrivateDir, makeRunId, randomToken, readPrivateJson,
    writePrivateJson,
} from './agent-testing/common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROKER = path.join(HERE, 'agent-testing', 'broker.mjs');

function parse(argv) {
    const positional = [];
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (!value.startsWith('--')) { positional.push(value); continue; }
        const key = value.slice(2);
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) options[key] = true;
        else { options[key] = next; index += 1; }
    }
    return { positional, options };
}

function requireText(value, name) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
    return value;
}

function integer(value, name, { min, max, fallback }) {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(String(value))) throw new Error(`${name} must be an integer number of milliseconds.`);
    const parsed = Number(value);
    if (parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max} milliseconds.`);
    return parsed;
}

function print(value) {
    // MCP discovery, schemas, and response envelopes are the tester's input.
    // Never truncate or redact that consumer-facing protocol output here.
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function start(options) {
    const backend = options.backend || 'offline';
    const transport = options.transport || 'stdio';
    if (!['offline', 'live'].includes(backend)) throw new Error('--backend must be offline or live.');
    if (!['stdio', 'http'].includes(transport)) throw new Error('--transport must be stdio or http.');
    const goal = requireText(options.goal, '--goal');
    const sessionTimeoutMs = integer(options['timeout-ms'], '--timeout-ms', { min: 5_000, max: 1_800_000, fallback: 15 * 60_000 });
    const runId = makeRunId();
    const runDir = path.join(RESULTS_ROOT, runId);
    const workspaceDir = path.join(runDir, 'workspace');
    await ensurePrivateDir(workspaceDir);
    const config = {
        runId, backend, transport, goal, workspaceDir,
        folderId: typeof options['folder-id'] === 'string' ? options['folder-id'] : undefined,
        controlToken: randomToken(), nativeToken: randomToken(),
        sessionTimeoutMs, callTimeoutMs: Math.min(sessionTimeoutMs, 60_000),
        startupDeadlineAt: Date.now() + 30_000,
        manifestFile: path.join(runDir, 'session.json'),
        configFile: path.join(runDir, 'broker-config.json'),
        reportFile: path.join(runDir, 'report.json'),
        journalFile: path.join(runDir, 'journal.jsonl'),
        startupErrorFile: path.join(runDir, 'startup-error.json'),
    };
    if (backend === 'live') {
        const { getTokenPath } = await import('../dist/auth.js');
        try {
            const token = await fs.lstat(getTokenPath());
            if (!token.isFile() || token.isSymbolicLink()) throw new Error('unsafe token path');
        } catch {
            throw new Error('Refusing live agent-test startup without an existing saved OAuth token. Run the project authentication flow outside the detached test broker first.');
        }
    }
    await writePrivateJson(config.configFile, config);
    let child;
    try {
        child = spawn(process.execPath, [BROKER, '--config', config.configFile], {
            cwd: path.resolve(HERE, '..'), detached: true, stdio: 'ignore', windowsHide: true,
        });
    } catch (error) { throw new Error(`agent-test broker could not be spawned: ${error.message}`); }
    child.unref();
    let spawnFailure = null;
    child.once('error', (error) => { spawnFailure = error; });
    const stopOwnedStartupBroker = async () => {
        if (!child || child.exitCode !== null) return;
        try { child.kill('SIGTERM'); } catch { return; }
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, 2_000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
    };
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
        if (spawnFailure) throw new Error(`agent-test broker could not be spawned: ${spawnFailure.message}`);
        try {
            const manifest = await readPrivateJson(config.manifestFile);
            if (manifest.state === 'ready') return print({ manifest: config.manifestFile, runId, backend, transport });
        } catch {}
        try {
            const failure = await readPrivateJson(config.startupErrorFile);
            await stopOwnedStartupBroker();
            throw new Error(`agent-test could not start: ${failure.error}`);
        } catch (error) {
            if (!/unsafe session file|ENOENT/.test(String(error?.message || error))) {
                if (String(error?.message || error).startsWith('agent-test could not start:')) throw error;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await stopOwnedStartupBroker();
    throw new Error(`agent-test broker did not become ready. Its owned startup process was stopped. Inspect ${config.startupErrorFile} and ${config.journalFile}; no unrelated process was touched.`);
}

async function control(session, body) {
    const manifest = await readPrivateJson(session);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 65_000);
    try {
        const response = await fetch(manifest.controlUrl, {
            method: 'POST', signal: controller.signal,
            headers: { authorization: `Bearer ${manifest.controlToken}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        const reply = await response.json().catch(() => ({ error: 'Broker returned a non-JSON control response.' }));
        if (!response.ok) throw new Error(String(reply.error || `Broker control request failed (${response.status}).`));
        return reply;
    } catch (error) {
        throw new Error(`Could not contact the owned agent-test broker. Its report/journal remain at ${manifest.reportPath} and ${manifest.journalPath}; retry finish only if the broker is still reachable. ${error?.name === 'AbortError' ? 'The control request timed out.' : error.message}`);
    } finally { clearTimeout(timer); }
}

async function main() {
    const { positional, options } = parse(process.argv.slice(2));
    const command = positional.shift();
    if (!command || command === 'help' || command === '--help') {
        print({ usage: 'agent-test start --backend offline|live --transport stdio|http --goal "..." [--timeout-ms N]; for discovery run agent-test list --search <text> --session <manifest>, then agent-test describe <tool> --session <manifest>; agent-test call|note|friction|status|finish --session <manifest>' });
        return;
    }
    if (command === 'start') return start(options);
    const session = requireText(options.session, '--session');
    if (command === 'list') {
        if (options.search !== undefined && (typeof options.search !== 'string' || !options.search.trim())) throw new Error('list --search requires non-empty text.');
        return print(await control(session, { command: 'list', ...(options.search !== undefined ? { search: options.search } : {}) }));
    }
    if (command === 'describe') return print(await control(session, { command, tool: requireText(positional[0], 'tool name') }));
    if (command === 'call') {
        const tool = requireText(positional[0], 'tool name');
        const source = options.args;
        if (typeof source !== 'string') throw new Error('call requires --args <JSON or @file>.');
        const json = (source.startsWith('@') ? await fs.readFile(path.resolve(source.slice(1)), 'utf8') : source).replace(/^\uFEFF/, '');
        let args;
        try { args = JSON.parse(json); } catch { throw new Error('--args must be a JSON object or @file containing one.'); }
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('--args must decode to a JSON object.');
        const expectedNegative = options['expected-negative'] ?? options['expect-negative'];
        const envelope = await control(session, { command, tool, args, ...(expectedNegative !== undefined ? { expectedNegative } : {}) });
        print(envelope);
        const failed = Boolean(envelope?.error || envelope?.result?.isError);
        if ((failed && expectedNegative === undefined) || (!failed && expectedNegative !== undefined)) process.exitCode = 1;
        return;
    }
    if (command === 'note' || command === 'friction') {
        return print(await control(session, { command, text: requireText(options.text, '--text'), ...(options.tool ? { tool: options.tool } : {}) }));
    }
    if (command === 'status') return print(await control(session, { command }));
    if (command === 'finish') {
        const report = await control(session, { command, outcome: requireText(options.outcome, '--outcome'), summary: requireText(options.summary, '--summary') });
        print(report);
        if (!report?.verdict?.strictPass) process.exitCode = 1;
        return;
    }
    throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => { process.stderr.write(`agent-test: ${error.message}\n`); process.exitCode = 1; });
