// Which tools create something the live harness is then responsible for
// cleaning up, and how to find the id in whatever shape each one returns.
//
// This lived twice, once in scripts/live-mission.mjs and once in
// scripts/live-smoke/call.mjs, under a "kept in sync with" comment. Both copies
// then read `parsed.id` and nothing else, which quietly dropped two of the
// eight tools they listed:
//
//   createPresentation          returns JSON keyed `presentationId`, not `id`
//   createDocumentFromTemplate  returns plain text, so JSON.parse throws
//
// A dropped id is not a cosmetic miss. The registry is what cleanup iterates,
// so an untracked file is never trashed, and the run still prints
// "cleanup 5/5" because it only counts what it knew about. The harness reported
// a clean sandbox while leaving real documents in a real Drive. One definition,
// used by both callers, is the fix that keeps it from drifting again.

/** toolName -> the cleanup path that can dispose of what it creates. */
export const CREATING_TOOLS = new Map([
    ['createDocument', 'drive'],
    ['createFolder', 'drive'],
    ['createDocumentFromTemplate', 'drive'],
    ['createSpreadsheet', 'drive'],
    ['createPresentation', 'drive'],
    ['copyFile', 'drive'],
    ['uploadFile', 'drive'],
    ['createDraft', 'draft'],
]);

// Every key a creating tool has ever used to name the thing it just made.
// Checked in order; the first string wins.
const ID_KEYS = ['id', 'presentationId', 'documentId', 'spreadsheetId', 'fileId'];

// createDocumentFromTemplate answers in prose:
//   Successfully created document "X" from template (ID: 1AbC...)
//   View Link: https://docs.google.com/document/d/1AbC.../edit
// Both forms are matched, because either alone would break if the other's
// wording changed.
const TEXT_ID_PATTERNS = [
    /\(ID:\s*([A-Za-z0-9_-]{10,})\s*\)/,
    /https:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]{10,})/,
    /https:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=)([A-Za-z0-9_-]{10,})/,
];

function idFromObject(value) {
    if (!value || typeof value !== 'object') return null;
    for (const key of ID_KEYS) {
        if (typeof value[key] === 'string' && value[key]) return value[key];
    }
    // Gmail drafts nest it.
    for (const nested of [value.draft, value.message, value.file, value.document]) {
        const found = nested && typeof nested === 'object' ? idFromObject(nested) : null;
        if (found) return found;
    }
    return null;
}

/**
 * Pull the created resource's id out of a tool result, whatever shape it took.
 * Returns null when the result genuinely names no id, which callers must treat
 * as a harness problem to surface rather than a silent skip.
 */
export function extractCreatedId(result) {
    if (result && typeof result === 'object') {
        const direct = idFromObject(result);
        if (direct) return direct;
    }
    const text = typeof result === 'string' ? result : null;
    if (text === null) return null;
    try {
        const parsed = JSON.parse(text);
        const found = idFromObject(parsed);
        if (found) return found;
    } catch {
        // Not JSON. Fall through to the prose patterns below rather than
        // giving up, which is what the old `catch { return; }` did.
    }
    for (const pattern of TEXT_ID_PATTERNS) {
        const match = text.match(pattern);
        if (match) return match[1];
    }
    return null;
}

/** Convenience: `{ id, kind }` for a creating tool, or null for anything else. */
export function classifyCreation(toolName, result) {
    const kind = CREATING_TOOLS.get(toolName);
    if (!kind) return null;
    const id = extractCreatedId(result);
    return { kind, id };
}
