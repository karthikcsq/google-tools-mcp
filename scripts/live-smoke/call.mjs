#!/usr/bin/env node
// live-call: run ONE registered tool, in-process, against the current
// worktree's dist/, with the full live-smoke safety envelope.
//
// This is the tool an agent reaches for when it has just changed something and
// wants to see the change hit the real Google API. The registered MCP server
// points at one fixed install directory, so an agent on a branch cannot
// otherwise reach its own code; this can, because it imports dist/ relative to
// itself.
//
//   npm run live-call -- --list
//   npm run live-call -- createDocument title="probe" parentFolderId=$FOLDER
//   npm run live-call -- readDocument '{"documentId":"...","format":"text"}'
//   npm run live-call -- modifyText @edit.json
//   npm run live-call -- --cleanup
//
// $FOLDER (and ${FOLDER}) expand to GOOGLE_MCP_TEST_FOLDER_ID anywhere in an
// argument value, so the safe parent id never has to be pasted by hand.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { bootstrap, RESULTS_DIR, ENV_VAR } from './bootstrap.mjs';
import { BLOCKED_TOOLS, stripHint } from './context.mjs';
import { truncateDeep } from './journal.mjs';
import { classifyCreation } from './createdResource.mjs';

const LEDGER = path.join(RESULTS_DIR, 'live-call-created.jsonl');

// The map of creating tools and the id extraction now live in
// ./createdResource.mjs, shared with scripts/live-mission.mjs. They were
// duplicated, and both copies read only `parsed.id`, so createPresentation
// (`presentationId`) and createDocumentFromTemplate (plain text) were listed as
// tracked and never actually recorded.

function usage() {
    return [
        'Usage: npm run live-call -- <toolName> [args]',
        '',
        'Argument forms (same as scripts/call-local-tool.js):',
        '  key=value key2=value2      parsed as booleans / numbers / null / strings',
        "  '{\"a\":1}'                  a single JSON object",
        '  @path/to/args.json         a JSON file',
        '',
        'Flags:',
        '  --list                     list every registered tool and exit',
        '  --raw                      print the tool result verbatim instead of pretty-printing JSON',
        '  --cleanup [id...]          trash what previous live-call runs created, or the ids given, then exit',
        '',
        '$FOLDER expands to the test folder id inside any argument value.',
    ].join('\n');
}

function parseValue(value) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
    return value;
}

function expandFolder(value, folderId) {
    if (typeof value === 'string') return value.replace(/\$\{FOLDER\}|\$FOLDER/g, folderId);
    if (Array.isArray(value)) return value.map((v) => expandFolder(v, folderId));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandFolder(v, folderId)]));
    }
    return value;
}

async function readArgs(rawArgs) {
    if (!rawArgs.length) return {};
    if (rawArgs.every((arg) => /^[A-Za-z_][A-Za-z0-9_.]*=/.test(arg))) {
        return Object.fromEntries(rawArgs.map((arg) => {
            const i = arg.indexOf('=');
            return [arg.slice(0, i), parseValue(arg.slice(i + 1))];
        }));
    }
    const joined = rawArgs.join(' ');
    if (joined.startsWith('@')) return JSON.parse(await fsp.readFile(joined.slice(1), 'utf8'));
    return JSON.parse(joined);
}

function readLedger() {
    if (!fs.existsSync(LEDGER)) return [];
    return fs.readFileSync(LEDGER, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
}

function appendLedger(entry) {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, `${JSON.stringify(entry)}\n`);
}

function recordCreated(toolName, result, runId) {
    const creation = classifyCreation(toolName, result);
    if (!creation) return null;
    if (!creation.id) {
        // The ledger is the only record of what a live-call run made. A
        // creating tool that succeeded and got no ledger entry is a file in the
        // sandbox that `--cleanup` will never find, so say so on stderr rather
        // than returning null and looking like a read-only call.
        process.stderr.write(
            `WARNING: ${toolName} succeeded but named no id this harness could parse, `
            + 'so it was NOT recorded for cleanup. Trash it by hand.\n'
        );
        return null;
    }
    appendLedger({ ts: new Date().toISOString(), runId, tool: toolName, id: creation.id, kind: creation.kind });
    return { id: creation.id, kind: creation.kind };
}

async function cleanup({ guard, journal, tools }, explicitIds = []) {
    // Explicit ids are how you clean up after "live-smoke --keep": the runner
    // prints the exact command with the ids it left behind. Containment is
    // re-verified below either way, so a stray id cannot trash anything outside
    // the sandbox.
    const entries = explicitIds.length
        ? explicitIds.map((id) => ({ ts: new Date().toISOString(), tool: 'explicit', id, kind: 'drive' }))
        : readLedger();
    if (!entries.length) {
        journal.toStdout('Nothing recorded to clean up.\n');
        return 0;
    }
    const failures = [];
    let cleaned = 0;
    const originals = await guard.rawDrive();
    // Reverse order: children before the folders that contain them.
    for (const entry of entries.slice().reverse()) {
        try {
            if (entry.kind === 'draft') {
                const del = tools.get('deleteDraft');
                await del.execute({ id: entry.id }, { log: { debug() {}, info() {}, warn() {}, error() {} } });
            } else {
                if (!(await guard.isInsideTestFolder(entry.id))) {
                    failures.push(`${entry.id} (${entry.tool}): not inside the test folder, refused`);
                    continue;
                }
                await originals['files.update']({ fileId: entry.id, requestBody: { trashed: true }, supportsAllDrives: true });
            }
            cleaned += 1;
            journal.write({ kind: 'cleanup', id: entry.id, resource: entry.kind, ok: true });
        } catch (error) {
            const reason = error?.message || String(error);
            // Already gone is a success, not a failure.
            if (/not ?found|404/i.test(reason)) { cleaned += 1; continue; }
            failures.push(`${entry.id} (${entry.tool}): ${reason}`);
            journal.write({ kind: 'cleanup', id: entry.id, resource: entry.kind, ok: false, error: reason });
        }
    }
    if (!explicitIds.length) fs.rmSync(LEDGER, { force: true });
    journal.toStdout(`Cleaned up ${cleaned} of ${entries.length} recorded item(s).\n`);
    if (failures.length) {
        journal.toStdout(`Could not clean up ${failures.length}:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
        return 1;
    }
    return 0;
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write(`${usage()}\n`);
        return 0;
    }

    const wantsList = argv.includes('--list');
    const wantsCleanup = argv.includes('--cleanup');
    const raw = argv.includes('--raw');
    const rest = argv.filter((a) => !['--list', '--cleanup', '--raw'].includes(a));

    if (!wantsList && !wantsCleanup && !rest.length) {
        process.stderr.write(`${usage()}\n`);
        return 2;
    }

    const boot = await bootstrap({ label: 'live-call' });
    const { tools, guard, journal, folderId, runId } = boot;

    try {
        if (wantsList) {
            const names = [...tools.keys()].sort();
            journal.toStdout(`${names.length} tools registered in this worktree's dist/:\n`);
            for (const name of names) {
                journal.toStdout(`  ${name}${BLOCKED_TOOLS.has(name) ? '   [blocked in live smoke]' : ''}\n`);
            }
            return 0;
        }

        if (wantsCleanup) return cleanup(boot, rest);

        const [toolName, ...rawArgs] = rest;
        const blocked = BLOCKED_TOOLS.get(toolName);
        if (blocked) {
            process.stderr.write(`Refused: ${toolName} is blocked by the live-smoke harness. ${blocked}\n`);
            journal.write({ kind: 'tool-call', tool: toolName, outcome: 'blocked', ok: false, error: blocked });
            return 3;
        }
        const tool = tools.get(toolName);
        if (!tool) {
            process.stderr.write(`Unknown tool: ${toolName}\nRun with --list to see what this build registers.\n`);
            return 2;
        }

        const args = expandFolder(await readArgs(rawArgs), folderId);
        const parsed = tool.parameters?.parse ? tool.parameters.parse(args) : args;
        if (JSON.stringify(parsed) !== JSON.stringify(args)) {
            // Worth saying out loud: a stripped key is exactly the failure mode
            // behind issue #124, and an agent poking at a schema change needs to
            // see it rather than wonder why nothing happened.
            const dropped = Object.keys(args).filter((k) => !(k in parsed));
            if (dropped.length) {
                process.stderr.write(`note: the tool's schema dropped ${dropped.map((d) => `"${d}"`).join(', ')}\n`);
            }
        }

        journal.progress(`\n  -> ${toolName} ${JSON.stringify(truncateDeep(args))}`);
        const started = Date.now();
        const denialsBefore = guard.denialCount;
        journal.lockStdout();
        let result;
        let failure = null;
        try {
            result = await tool.execute(parsed, {
                log: {
                    debug: (...a) => journal.progress(`     [debug] ${a.join(' ')}`),
                    info: (...a) => journal.progress(`     [info] ${a.join(' ')}`),
                    warn: (...a) => journal.progress(`     [warn] ${a.join(' ')}`),
                    error: (...a) => journal.progress(`     [error] ${a.join(' ')}`),
                },
            });
        } catch (error) {
            // The tool's own error boundary rewrites most failures, so a guard
            // refusal has to be recovered from the guard rather than the error.
            const denial = guard.denialCount > denialsBefore ? guard.lastDenial : null;
            if (denial && !error?.safety) {
                failure = new Error(denial.reason);
                failure.safety = true;
                failure.cause = error;
            } else {
                if (typeof error?.message === 'string') {
                    try { error.message = stripHint(error.message); } catch { /* frozen */ }
                }
                failure = error;
            }
        } finally {
            journal.unlockStdout();
        }
        const durationMs = Date.now() - started;

        journal.write({
            kind: 'tool-call',
            runId,
            tool: toolName,
            args: truncateDeep(args),
            parsedArgs: truncateDeep(parsed),
            outcome: failure ? (failure.safety ? 'safety-refused' : 'error') : 'ok',
            ok: !failure,
            durationMs,
            ...(failure ? { error: truncateDeep(failure.message || String(failure)) } : { result: truncateDeep(typeof result === 'string' ? result : JSON.stringify(result)) }),
        });

        if (failure) {
            process.stderr.write(`\n${failure.safety ? 'SAFETY REFUSAL' : 'ERROR'} after ${durationMs}ms:\n${failure.stack || failure.message}\n`);
            return 1;
        }

        const created = recordCreated(toolName, result, runId);
        if (created) {
            journal.progress(`  created ${created.kind} ${created.id} (recorded for "npm run live-call -- --cleanup")`);
        }

        journal.progress(`  ok in ${durationMs}ms\n`);
        if (typeof result === 'string' && !raw) {
            let pretty = null;
            try { pretty = JSON.stringify(JSON.parse(result), null, 2); } catch { /* not JSON */ }
            journal.toStdout(`${pretty ?? result}\n`);
        } else {
            journal.toStdout(`${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}\n`);
        }
        if (journal.stdoutLeaks) {
            process.stderr.write(`warning: ${journal.stdoutLeaks} stdout write(s) escaped from the tool code path\n`);
        }
        return 0;
    } finally {
        await journal.close();
    }
}

main().then(
    (code) => { process.exitCode = code; },
    (error) => {
        if (error?.refusal) process.stderr.write(`${error.message}\n`);
        else process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
        process.exitCode = error?.refusal ? 2 : 1;
    },
);

export { ENV_VAR };
