// The `ctx` every scenario receives.
//
// ctx.call() is the only way a scenario reaches a tool. It parses arguments
// through the tool's own zod schema first -- exactly what the MCP transport
// does -- so a scenario that passes a parameter the tool does not declare sees
// it stripped, the same way the bug reporter did. That is load-bearing for
// issue #124 (copyFile `name`), #120 (`bulletPreset`) and #96 (`plainMarkdown`).
import * as fs from 'node:fs/promises';
import { truncateDeep } from './journal.mjs';

/** Tools that must never reach the API in a smoke run, blocked before execute(). */
export const BLOCKED_TOOLS = new Map([
    ['sendMessage', 'Live smoke never sends mail.'],
    ['sendDraft', 'Live smoke never sends mail.'],
    ['replyMessage', 'Live smoke never sends mail.'],
    ['forwardMessage', 'Live smoke never sends mail; forwardMessage sends unconditionally. Build the forward as a draft instead.'],
    ['logout', 'Logging out would destroy the machine credentials the run depends on.'],
    ['feedback', 'feedback opens a real GitHub issue from the maintainer account.'],
]);

export class AssertionFailure extends Error {
    constructor(message) {
        super(message);
        this.name = 'AssertionFailure';
        this.assertion = true;
    }
}

export class ScenarioSkipped extends Error {
    constructor(message) {
        super(message);
        this.name = 'ScenarioSkipped';
        this.skipped = true;
    }
}

const MIRROR_LINE = /\n?📄 Local file: (.+)\n/;

// dist/tools/index.js appends this block to every thrown error. It is noise in
// a results table and in the journal.
const ERROR_HINT_START = 'If this error is unexpected or unclear, you can:';

export function stripHint(message) {
    if (typeof message !== 'string') return message;
    const at = message.indexOf(ERROR_HINT_START);
    return (at === -1 ? message : message.slice(0, at)).trimEnd();
}

/** Pull the local markdown mirror path out of a readDocument(markdown) result. */
export function mirrorPathFromResult(result) {
    if (typeof result !== 'string') return null;
    const match = result.match(MIRROR_LINE);
    return match ? match[1].trim() : null;
}

export function createContext({ scenario, tools, guard, journal, folderId, self, registry }) {
    const scopedLog = (toolName) => {
        const emit = (level) => (...args) => {
            const message = args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ');
            journal.write({ kind: 'tool-log', scenario: scenario.name, tool: toolName, level, message: truncateDeep(message) });
        };
        return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
    };

    function safeJson(value) {
        try { return JSON.stringify(value); } catch { return String(value); }
    }

    async function call(toolName, args = {}) {
        const blocked = BLOCKED_TOOLS.get(toolName);
        if (blocked) {
            const error = new Error(`${toolName} is blocked by the live-smoke runner: ${blocked}`);
            error.safety = true;
            journal.write({ kind: 'tool-call', scenario: scenario.name, tool: toolName, args: truncateDeep(args), outcome: 'blocked', ok: false, durationMs: 0, error: error.message });
            throw error;
        }
        const tool = tools.get(toolName);
        if (!tool) throw new Error(`Unknown tool: ${toolName}`);

        // Re-assert client interception before every call (see guard.mjs).
        await guard.ensureInstrumented();

        const started = Date.now();
        const denialsBefore = guard.denialCount;
        let parsed;
        try {
            parsed = tool.parameters?.parse ? tool.parameters.parse(args) : args;
        } catch (error) {
            journal.write({ kind: 'tool-call', scenario: scenario.name, tool: toolName, args: truncateDeep(args), outcome: 'schema-error', ok: false, durationMs: Date.now() - started, error: error.message });
            throw error;
        }

        try {
            const result = await tool.execute(parsed, { log: scopedLog(toolName) });
            journal.write({
                kind: 'tool-call',
                scenario: scenario.name,
                tool: toolName,
                args: truncateDeep(args),
                parsedArgs: truncateDeep(parsed),
                outcome: 'ok',
                ok: true,
                durationMs: Date.now() - started,
                result: truncateDeep(typeof result === 'string' ? result : safeJson(result)),
            });
            return result;
        } catch (rawError) {
            // If the guard refused something during this call, that is the real
            // reason -- even when the tool's own error boundary replaced it with
            // "the operation failed".
            const denial = guard.denialCount > denialsBefore ? guard.lastDenial : null;
            let error = rawError;
            if (denial && !rawError?.safety) {
                error = new Error(denial.reason);
                error.safety = true;
                error.cause = rawError;
            } else if (typeof rawError?.message === 'string') {
                const stripped = stripHint(rawError.message);
                if (stripped !== rawError.message) {
                    // Public errors are frozen by design, so mutating the message
                    // silently no-ops and the boilerplate hint ends up quoted in
                    // a scenario's failure reason. Re-wrap instead.
                    try {
                        rawError.message = stripped;
                    } catch {
                        error = new Error(stripped);
                        error.name = rawError.name;
                        error.cause = rawError;
                        error.stack = rawError.stack;
                    }
                }
            }
            journal.write({
                kind: 'tool-call',
                scenario: scenario.name,
                tool: toolName,
                args: truncateDeep(args),
                parsedArgs: truncateDeep(parsed),
                outcome: error?.safety ? 'safety-refused' : 'error',
                ok: false,
                durationMs: Date.now() - started,
                error: truncateDeep(stripHint(error?.message) || String(error)),
            });
            throw error;
        }
    }

    /** call() that never throws. Returns { ok, result, error }. */
    async function tryCall(toolName, args = {}) {
        try {
            return { ok: true, result: await call(toolName, args), error: null };
        } catch (error) {
            return { ok: false, result: null, error };
        }
    }

    function track(id, kind = 'drive') {
        if (!id) throw new AssertionFailure('track() called with an empty id.');
        registry.push({ id, kind, scenario: scenario.name });
        journal.write({ kind: 'track', scenario: scenario.name, id, resource: kind });
        return id;
    }

    // --- assertions --------------------------------------------------------
    const fail = (message) => { throw new AssertionFailure(message); };
    const assert = (condition, message) => { if (!condition) fail(message); };
    const assertEqual = (actual, expected, message) => {
        if (actual !== expected) fail(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(truncateDeep(actual))})`);
    };
    const assertIncludes = (haystack, needle, message) => {
        if (typeof haystack !== 'string' || !haystack.includes(needle)) {
            fail(`${message} (looked for ${JSON.stringify(needle)})`);
        }
    };
    const assertNotIncludes = (haystack, needle, message) => {
        if (typeof haystack === 'string' && haystack.includes(needle)) {
            const at = haystack.indexOf(needle);
            fail(`${message} (found ${JSON.stringify(needle)} at offset ${at}: ${JSON.stringify(haystack.slice(Math.max(0, at - 40), at + 60))})`);
        }
    };
    const assertMatch = (value, regex, message) => {
        if (typeof value !== 'string' || !regex.test(value)) fail(`${message} (no match for ${regex})`);
    };
    const skip = (message) => { throw new ScenarioSkipped(message); };

    // --- local markdown mirror --------------------------------------------
    let lastMirror = null;
    function rememberMirror(result) {
        const p = mirrorPathFromResult(result);
        if (p) lastMirror = p;
        return p;
    }
    async function readMirror(pathOrNull) {
        const target = pathOrNull || lastMirror;
        if (!target) fail('readMirror(): no mirror path known yet. Call readDocument(format="markdown") first.');
        return fs.readFile(target, 'utf8');
    }
    async function writeMirror(pathOrNull, text) {
        const target = typeof text === 'string' ? pathOrNull : lastMirror;
        const content = typeof text === 'string' ? text : pathOrNull;
        if (!target) fail('writeMirror(): no mirror path known yet. Call readDocument(format="markdown") first.');
        await fs.writeFile(target, content, 'utf8');
        return target;
    }
    async function mirrorExists(p) {
        try { await fs.access(p); return true; } catch { return false; }
    }

    /** Create a Doc inside the test folder and track it for cleanup. */
    async function createDoc(title, initialContent, extra = {}) {
        const raw = await call('createDocument', {
            title: `[live-smoke] ${title}`,
            parentFolderId: folderId,
            ...(initialContent !== undefined && { initialContent }),
            ...extra,
        });
        const parsed = JSON.parse(raw);
        track(parsed.id, 'drive');
        return parsed;
    }

    /** Create a folder inside a folder in the sandbox and track it. */
    async function createFolder(name, parentFolderId = folderId) {
        const raw = await call('createFolder', { name: `[live-smoke] ${name}`, parentFolderId });
        const parsed = JSON.parse(raw);
        track(parsed.id, 'drive');
        return parsed;
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    return {
        scenario,
        folderId,
        self,
        call,
        tryCall,
        /** Is a tool registered in THIS worktree's build? Several scenarios are
         *  acceptance checks for a tool that does not exist on the base branch. */
        hasTool: (toolName) => tools.has(toolName),
        toolNames: () => [...tools.keys()].sort(),
        /** The description string a real MCP client sees in its tools/list
         *  response. Missions call tools by name, so without this they are
         *  strictly blinder than the agent they stand in for, and they report
         *  "undocumented" for things the description states plainly. The
         *  iteration-2 mission recorded exactly that against `help`, whose
         *  description already said `Pass tool='<toolName>'`. */
        describe: (toolName) => {
            const tool = tools.get(toolName);
            if (!tool) return null;
            return tool.description ?? null;
        },
        /** Docs and comment tool results lead with the document URL on its own
         *  line. When a failure message quotes a result, this is the part worth
         *  quoting -- otherwise the reason column is all URL. */
        lastLine: (value) => String(value ?? '').trim().split(/\r?\n/).pop(),
        track,
        /** Every id registered for cleanup so far, whether the scenario called
         *  track() itself or the mission runner auto-registered it. A probe
         *  that checks auto-tracking cannot use track() to do it, since that is
         *  the thing being verified. */
        registryIds: () => registry.map((item) => item.id),
        createDoc,
        createFolder,
        fail,
        skip,
        assert,
        assertEqual,
        assertIncludes,
        assertNotIncludes,
        assertMatch,
        readMirror,
        writeMirror,
        mirrorExists,
        mirrorPathFromResult,
        rememberMirror,
        get lastMirror() { return lastMirror; },
        sleep,
        log: (message) => journal.progress(`      · ${message}`),
    };
}
