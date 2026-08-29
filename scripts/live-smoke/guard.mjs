// Live-smoke safety guard.
//
// Everything in this file exists because the smoke run talks to a REAL Google
// account. The boundaries are enforced here, in code, at the Google client
// layer -- NOT in the scenarios and not in the docs. A scenario that forgets to
// pass a parent folder id, or reaches for a file that is not in the sandbox, is
// aborted before the request leaves the process.
//
// Three independent layers:
//
//   1. Tool-name block list. sendMessage / sendDraft / replyMessage /
//      forwardMessage (plus logout and feedback) throw in ctx.call() before the
//      tool's execute() is ever entered. See context.mjs.
//   2. Default-deny method interception on every Google client. Any method
//      whose name looks like a mutation is denied unless it appears in the rule
//      table below with an explicit confinement check.
//   3. Parent-chain confinement. Every allowed mutation that names an existing
//      file id must have that id reachable, via parents, from the configured
//      test folder. Every creation must name a parent inside the test folder.
//
// Layer 2 is what makes this safe against scenarios (and tools) doing something
// nobody anticipated: an unlisted mutating method fails closed.
import {
    getCalendarClient,
    getDocsClient,
    getDriveClient,
    getFormsClient,
    getGmailClient,
    getScriptClient,
    getSheetsClient,
    getSlidesClient,
    getTasksClient,
} from '../../dist/clients.js';

// googleapis client roots are not extensible, so the "already instrumented"
// marker cannot live on the object. A module-level WeakMap works on frozen
// objects and is collected with the client it keys.
const INSTRUMENTED = new WeakMap(); // client object -> { label, originals }

// Method names that mutate state. Anything matching this and not covered by an
// explicit rule is denied. Read verbs (get/list/export/download/...) fall
// through to "allowed".
const MUTATING_VERB = /^(create|insert|import|update|patch|delete|batchDelete|batchModify|modify|modifyLabels|batchUpdate|copy|move|send|trash|untrash|append|clear|batchClear|batchClearByDataFilter|batchUpdateByDataFilter|emptyTrash|watch|stop|generateIds|setIamPolicy|resolve|reply|add|remove|set|enable|disable|publish|unpublish|refresh|reset|cancel|close|complete|clone|duplicate|replace|revoke|upload|write|save|apply)$/;

// --- write quota -----------------------------------------------------------
//
// The Docs API allows 60 write requests per minute per user, and a full smoke
// run comfortably exceeds that: the first run without this hit
// RESOURCE_EXHAUSTED partway through and two scenarios failed with a 429
// instead of failing for the reason their reporter described. A rate-limit
// failure masquerading as a repro result makes the whole table untrustworthy,
// so writes are paced here and 429s are retried.
//
// A sliding window rather than fixed spacing: a burst goes straight through and
// throttling only kicks in near the cap, which keeps a full run to a few
// minutes instead of serialising every write behind a fixed delay.
const WRITE_LIMITS = { docs: 50, drive: 50, sheets: 50, slides: 50, gmail: 200 };
const WINDOW_MS = 60_000;
const MAX_RETRIES = 5;
const windows = new Map(); // label -> number[] of request timestamps

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimited(error) {
    if (!error) return false;
    if (error.code === 429 || error.status === 429 || error.response?.status === 429) return true;
    const message = typeof error.message === 'string' ? error.message : '';
    return /RESOURCE_EXHAUSTED|rateLimitExceeded|Quota exceeded|userRateLimitExceeded/i.test(message);
}

let quotaWaits = 0;
let quotaRetries = 0;

async function takeWriteSlot(label) {
    const limit = WRITE_LIMITS[label] ?? 50;
    for (;;) {
        const now = Date.now();
        let stamps = windows.get(label);
        if (!stamps) { stamps = []; windows.set(label, stamps); }
        while (stamps.length && now - stamps[0] >= WINDOW_MS) stamps.shift();
        if (stamps.length < limit) { stamps.push(now); return; }
        quotaWaits += 1;
        await sleep(Math.max(50, WINDOW_MS - (now - stamps[0]) + 50));
    }
}

async function runWriteWithQuota(label, path, perform) {
    for (let attempt = 0; ; attempt += 1) {
        await takeWriteSlot(label);
        try {
            return await perform();
        } catch (error) {
            if (!isRateLimited(error) || attempt >= MAX_RETRIES) throw error;
            quotaRetries += 1;
            // Google's own guidance for this quota is to back off and retry;
            // the window is per minute, so the delays are seconds, not ms.
            await sleep(Math.min(32_000, 2000 * 2 ** attempt));
        }
    }
}

export function getQuotaStats() {
    return { waits: quotaWaits, retries: quotaRetries };
}

export class SafetyViolation extends Error {
    constructor(message) {
        super(message);
        this.name = 'SafetyViolation';
        this.safety = true;
    }
}

export function createGuard({ folderId }) {
    if (!folderId) throw new SafetyViolation('createGuard requires a folderId.');

    // Original (uninstrumented) drive.files.get, captured on first use so the
    // parent-chain walk never re-enters the interceptor.
    let rawFilesGet = null;
    // fileId -> boolean ("is inside the test folder"). Cleared whenever a
    // mutation could have changed the tree.
    const insideCache = new Map();
    let lookups = 0;
    const denials = [];

    async function filesGet(fileId) {
        if (!rawFilesGet) {
            const drive = await getDriveClient();
            // Prefer the pre-instrumentation function so the containment walk
            // never re-enters the interceptor (files.get is an allowed read
            // either way, but this keeps the guard free of its own recursion).
            rawFilesGet = INSTRUMENTED.get(drive)?.originals?.['files.get'] ?? drive.files.get.bind(drive.files);
        }
        lookups += 1;
        const res = await rawFilesGet({
            fileId,
            fields: 'id,name,mimeType,parents,trashed',
            supportsAllDrives: true,
        });
        return res.data;
    }

    // Breadth-first walk up the parent chain looking for the test folder.
    async function isInsideTestFolder(fileId) {
        if (!fileId || typeof fileId !== 'string') return false;
        if (fileId === folderId) return true;
        if (insideCache.has(fileId)) return insideCache.get(fileId);

        const seen = new Set([fileId]);
        let frontier = [fileId];
        let verdict = false;
        // 12 levels is far deeper than any sane sandbox tree; the bound also
        // stops a Drive parent cycle from spinning forever.
        for (let depth = 0; depth < 12 && frontier.length && !verdict; depth += 1) {
            const next = [];
            for (const id of frontier) {
                let meta;
                try {
                    meta = await filesGet(id);
                } catch {
                    // Unreadable ancestor: containment cannot be proven, so it is not proven.
                    continue;
                }
                const parents = meta.parents || [];
                if (parents.includes(folderId)) { verdict = true; break; }
                for (const p of parents) {
                    if (!seen.has(p)) { seen.add(p); next.push(p); }
                }
            }
            frontier = next;
        }
        insideCache.set(fileId, verdict);
        return verdict;
    }

    function invalidate() { insideCache.clear(); }

    async function requireInside(fileId, what) {
        if (!fileId) {
            throw new SafetyViolation(`${what}: refused, no file id was supplied so containment cannot be proven.`);
        }
        if (!(await isInsideTestFolder(fileId))) {
            throw new SafetyViolation(
                `${what}: refused. File ${fileId} is not inside the live-smoke test folder ${folderId}. ` +
                'Every mutation in a live smoke run must target a file created inside that folder.'
            );
        }
    }

    async function requireParentsInside(parents, what) {
        const list = Array.isArray(parents)
            ? parents
            : (typeof parents === 'string' && parents ? parents.split(',') : []);
        if (!list.length) {
            throw new SafetyViolation(
                `${what}: refused. No parent folder was supplied, so the new item would land in Drive root. ` +
                `Pass the test folder id (${folderId}) or a folder inside it.`
            );
        }
        for (const p of list) {
            if (p === folderId) continue;
            if (!(await isInsideTestFolder(p))) {
                throw new SafetyViolation(
                    `${what}: refused. Parent folder ${p} is not inside the live-smoke test folder ${folderId}.`
                );
            }
        }
    }

    const deny = (why) => async (path) => {
        throw new SafetyViolation(`${path}: refused by the live-smoke guard. ${why}`);
    };

    const NEVER_SEND = 'Live smoke never sends mail. Use drafts (createDraft / updateDraft / getDraft / deleteDraft).';

    // --- rule tables -------------------------------------------------------
    // A rule returns normally to allow the call, throws SafetyViolation to
    // abort it. Absent from the table + mutating verb => denied.

    const driveRules = {
        'files.create': async (path, p) => { await requireParentsInside(p?.requestBody?.parents, path); invalidate(); },
        'files.copy': async (path, p) => {
            await requireInside(p?.fileId, path);
            const parents = p?.requestBody?.parents;
            if (parents) await requireParentsInside(parents, path);
            invalidate();
        },
        'files.update': async (path, p) => {
            await requireInside(p?.fileId, path);
            if (p?.addParents) await requireParentsInside(p.addParents, path);
            invalidate();
        },
        'files.delete': async (path, p) => { await requireInside(p?.fileId, path); invalidate(); },
        'files.modifyLabels': async (path, p) => { await requireInside(p?.fileId, path); },
        'files.generateIds': async () => {},
        'files.emptyTrash': deny('Emptying the Drive trash would destroy files this run did not create.'),
        'permissions.create': async (path, p) => { await requireInside(p?.fileId, path); },
        'permissions.update': async (path, p) => { await requireInside(p?.fileId, path); },
        'permissions.delete': async (path, p) => { await requireInside(p?.fileId, path); },
        'comments.create': async (path, p) => { await requireInside(p?.fileId, path); },
        'comments.update': async (path, p) => { await requireInside(p?.fileId, path); },
        'comments.delete': async (path, p) => { await requireInside(p?.fileId, path); },
        'replies.create': async (path, p) => { await requireInside(p?.fileId, path); },
        'replies.update': async (path, p) => { await requireInside(p?.fileId, path); },
        'replies.delete': async (path, p) => { await requireInside(p?.fileId, path); },
        'revisions.update': async (path, p) => { await requireInside(p?.fileId, path); },
        'revisions.delete': async (path, p) => { await requireInside(p?.fileId, path); },
    };

    const docsRules = {
        'documents.batchUpdate': async (path, p) => { await requireInside(p?.documentId, path); },
        'documents.create': deny('A Docs-API creation lands in Drive root, outside the sandbox. Use createDocument with parentFolderId.'),
    };

    const sheetsRules = {
        'spreadsheets.create': deny('A Sheets-API creation lands in Drive root, outside the sandbox.'),
        'spreadsheets.batchUpdate': async (path, p) => { await requireInside(p?.spreadsheetId, path); },
        'spreadsheets.values.update': async (path, p) => { await requireInside(p?.spreadsheetId, path); },
        'spreadsheets.values.append': async (path, p) => { await requireInside(p?.spreadsheetId, path); },
        'spreadsheets.values.clear': async (path, p) => { await requireInside(p?.spreadsheetId, path); },
        'spreadsheets.values.batchUpdate': async (path, p) => { await requireInside(p?.spreadsheetId, path); },
        'spreadsheets.values.batchClear': async (path, p) => { await requireInside(p?.spreadsheetId, path); },
    };

    const slidesRules = {
        'presentations.create': deny('A Slides-API creation lands in Drive root, outside the sandbox.'),
        'presentations.batchUpdate': async (path, p) => { await requireInside(p?.presentationId, path); },
    };

    // Gmail is a strict allowlist: read paths plus the four draft verbs. Every
    // send path is denied by name so the failure message says why.
    const GMAIL_ALLOWED = new Set([
        'users.getProfile',
        'users.messages.get', 'users.messages.list', 'users.messages.attachments.get',
        'users.threads.get', 'users.threads.list',
        'users.drafts.create', 'users.drafts.get', 'users.drafts.list',
        'users.drafts.update', 'users.drafts.delete',
        'users.labels.get', 'users.labels.list',
        'users.history.list',
        'users.settings.getVacation', 'users.settings.getAutoForwarding',
        'users.settings.getImap', 'users.settings.getPop', 'users.settings.getLanguage',
        'users.settings.filters.get', 'users.settings.filters.list',
        'users.settings.sendAs.get', 'users.settings.sendAs.list',
    ]);
    const GMAIL_SEND = new Set([
        'users.messages.send', 'users.drafts.send',
        'users.messages.insert', 'users.messages.import',
    ]);

    function gmailDecide(path) {
        if (GMAIL_SEND.has(path)) throw new SafetyViolation(`gmail.${path}: refused. ${NEVER_SEND}`);
        if (GMAIL_ALLOWED.has(path)) return;
        if (MUTATING_VERB.test(path.split('.').pop())) {
            throw new SafetyViolation(
                `gmail.${path}: refused by the live-smoke guard. Gmail is read-plus-drafts only in a smoke run.`
            );
        }
    }

    function makeDecider(label, rules, { allowlist } = {}) {
        return async function decide(path, params) {
            if (allowlist) return allowlist(path, params);
            const rule = rules[path];
            if (rule) return rule(`${label}.${path}`, params);
            const verb = path.split('.').pop();
            if (MUTATING_VERB.test(verb)) {
                throw new SafetyViolation(
                    `${label}.${path}: refused by the live-smoke guard. It looks like a mutation and has no ` +
                    'confinement rule, so it fails closed. Add a rule in scripts/live-smoke/guard.mjs if a ' +
                    'scenario legitimately needs it.'
                );
            }
        };
    }

    // Every other API surface (Calendar, Tasks, Forms, Apps Script) is
    // read-only for a smoke run: no scenario needs to write there, and none of
    // those resources live under a Drive folder we could confine them to.
    const readOnlyDecider = (label) => async (path) => {
        const verb = path.split('.').pop();
        if (MUTATING_VERB.test(verb)) {
            throw new SafetyViolation(
                `${label}.${path}: refused. Live smoke does not write to ${label}; those resources cannot be ` +
                'confined to the Drive test folder.'
            );
        }
    };

    function wrapFn(label, path, fn, decide) {
        const isMutation = MUTATING_VERB.test(path.split('.').pop());
        return async function guarded(...args) {
            try {
                await decide(path, args[0]);
            } catch (error) {
                denials.push({ client: label, method: path, reason: error.message });
                throw error;
            }
            if (!isMutation) return fn(...args);
            return runWriteWithQuota(label, path, () => fn(...args));
        };
    }

    function instrument(label, node, prefix, decide, seen, originals) {
        if (!node || typeof node !== 'object' || seen.has(node)) return;
        seen.add(node);
        const methodNames = new Set();
        let proto = Object.getPrototypeOf(node);
        while (proto && proto !== Object.prototype) {
            for (const name of Object.getOwnPropertyNames(proto)) methodNames.add(name);
            proto = Object.getPrototypeOf(proto);
        }
        for (const name of methodNames) {
            if (name === 'constructor') continue;
            let fn;
            try { fn = node[name]; } catch { continue; }
            if (typeof fn !== 'function') continue;
            const path = prefix ? `${prefix}.${name}` : name;
            const bound = fn.bind(node);
            originals[path] = bound;
            // Shadowing the prototype method with an own property. googleapis
            // resource methods all live on the prototype, so this is stable.
            node[name] = wrapFn(label, path, bound, decide);
        }
        for (const key of Object.keys(node)) {
            if (key === 'context' || key.startsWith('_')) continue;
            let child;
            try { child = node[key]; } catch { continue; }
            if (child && typeof child === 'object') {
                instrument(label, child, prefix ? `${prefix}.${key}` : key, decide, seen, originals);
            }
        }
    }

    function apply(label, client, decide) {
        if (!client || INSTRUMENTED.has(client)) return client;
        const originals = {};
        instrument(label, client, '', decide, new Set(), originals);
        INSTRUMENTED.set(client, { label, originals });
        return client;
    }

    const CLIENTS = [
        ['drive', getDriveClient, () => makeDecider('drive', driveRules)],
        ['docs', getDocsClient, () => makeDecider('docs', docsRules)],
        ['sheets', getSheetsClient, () => makeDecider('sheets', sheetsRules)],
        ['slides', getSlidesClient, () => makeDecider('slides', slidesRules)],
        ['gmail', getGmailClient, () => makeDecider('gmail', {}, { allowlist: gmailDecide })],
        ['calendar', getCalendarClient, () => readOnlyDecider('calendar')],
        ['tasks', getTasksClient, () => readOnlyDecider('tasks')],
        ['forms', getFormsClient, () => readOnlyDecider('forms')],
        ['script', getScriptClient, () => readOnlyDecider('script')],
    ];

    // Instrument every Google client. Safe to call repeatedly: clients already
    // carrying the marker are skipped. It is called before every tool call
    // because dist/clients.js rebuilds its cached clients on a token refresh
    // (withAuthRetry -> reauthorize), which would otherwise silently drop the
    // interception mid-run.
    async function ensureInstrumented() {
        for (const [label, getter, makeDecide] of CLIENTS) {
            let client;
            try { client = await getter(); } catch { continue; }
            apply(label, client, makeDecide());
        }
    }

    // Uninstrumented Drive handle for the runner's own cleanup and folder
    // verification. Still confined: the caller passes ids it tracked itself and
    // cleanup re-checks containment through isInsideTestFolder first.
    async function rawDrive() {
        const drive = await getDriveClient();
        return INSTRUMENTED.get(drive)?.originals ?? null;
    }

    return {
        folderId,
        ensureInstrumented,
        isInsideTestFolder,
        requireInside,
        invalidate,
        rawDrive,
        // Tool code paths rewrap thrown errors (dist/tools/index.js appends a
        // hint, and most tools funnel failures through wrapOperationError),
        // which loses the SafetyViolation identity by the time a caller sees
        // it. Callers therefore compare denialCount across a call to tell
        // "the guard refused this" from "the API refused this".
        get denialCount() { return denials.length; },
        get lastDenial() { return denials.length ? denials[denials.length - 1] : null; },
        get stats() { return { parentLookups: lookups, denials: denials.slice(), quota: getQuotaStats() }; },
    };
}
