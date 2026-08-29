// Run journal: one JSONL line per tool call, plus the stdout lock.
//
// Boundary 5: every tool call (name, args with long strings truncated,
// outcome, duration) lands in live-smoke-results/<timestamp>.jsonl.
// Boundary 6: nothing on the tool code path may write to stdout. That is
// enforced here by swapping process.stdout.write for a forwarder to stderr
// while scenarios run; leaks are counted and reported in the summary.
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_STRING = 300;
const KEEP = 200;

/** Truncate long strings anywhere in an argument tree so the journal stays readable. */
export function truncateDeep(value, depth = 0) {
    if (typeof value === 'string') {
        if (value.length <= MAX_STRING) return value;
        return `${value.slice(0, KEEP)}…[truncated, ${value.length} chars total]`;
    }
    if (value === null || typeof value !== 'object') return value;
    if (depth >= 8) return '[depth limit]';
    if (Array.isArray(value)) {
        const head = value.slice(0, 25).map((v) => truncateDeep(v, depth + 1));
        if (value.length > 25) head.push(`…[${value.length - 25} more items]`);
        return head;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateDeep(v, depth + 1);
    return out;
}

export function createJournal({ dir, timestamp }) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${timestamp}.jsonl`);
    const stream = fs.createWriteStream(file, { flags: 'a' });
    let stdoutLeaks = 0;
    let realStdoutWrite = null;

    function write(entry) {
        stream.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    }

    // Progress output goes to stderr, always -- including while the stdout lock
    // is installed, so it is never confused with the summary table.
    function progress(message) {
        process.stderr.write(`${message}\n`);
    }

    function lockStdout() {
        if (realStdoutWrite) return;
        realStdoutWrite = process.stdout.write.bind(process.stdout);
        process.stdout.write = (chunk, encoding, cb) => {
            stdoutLeaks += 1;
            const text = typeof chunk === 'string' ? chunk : String(chunk);
            write({ kind: 'stdout-leak', text: truncateDeep(text) });
            process.stderr.write(`[live-smoke] STDOUT LEAK from tool code path: ${text}`);
            if (typeof encoding === 'function') encoding();
            else if (typeof cb === 'function') cb();
            return true;
        };
    }

    function unlockStdout() {
        if (!realStdoutWrite) return;
        process.stdout.write = realStdoutWrite;
        realStdoutWrite = null;
    }

    /** Write to the real stdout even while the lock is installed (summary table). */
    function toStdout(text) {
        if (realStdoutWrite) realStdoutWrite(text);
        else process.stdout.write(text);
    }

    async function close() {
        await new Promise((resolve) => stream.end(resolve));
    }

    return {
        file,
        write,
        progress,
        lockStdout,
        unlockStdout,
        toStdout,
        close,
        get stdoutLeaks() { return stdoutLeaks; },
    };
}
