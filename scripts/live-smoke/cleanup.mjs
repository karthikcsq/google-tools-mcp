// End-of-run cleanup, shared by scripts/live-smoke.mjs and scripts/live-mission.mjs.
//
// This used to be two copies of the same loop, and both had the same two holes:
//
//   1. A file the run had ALREADY deleted (a scenario exercising deleteFile on
//      its own document, say) was reported LEFT BEHIND. The containment check
//      ran first, guard.isInsideTestFolder() treats an unreadable file as "not
//      proven inside", so the loop refused to trash a file that no longer
//      existed, and the 404-means-cleaned branch in the catch was unreachable
//      for Drive items.
//   2. guard.rawDrive() was read without re-instrumenting first. dist/clients.js
//      rebuilds every Google client on invalid_grant, so if that happened inside
//      the run's last call, rawDrive() returned null and every Drive item failed
//      with a TypeError instead of being trashed.
//
// One implementation, with both fixed, is the only way to keep them fixed.
import { StartupRefusal } from './bootstrap.mjs';

const SILENT = { log: { debug() {}, info() {}, warn() {}, error() {} } };

/** A 404 the API actually returned, not a message that happens to mention one. */
function hasNotFoundStatus(error) {
    if (!error) return false;
    return error.code === 404 || error.status === 404 || error.response?.status === 404;
}

function isNotFound(error) {
    if (hasNotFoundStatus(error)) return true;
    return /not ?found|404/i.test(error?.message || String(error));
}

/**
 * Trash everything the run registered, newest first, re-verifying containment
 * for each item. Returns { attempted, cleaned, failures, skipped }.
 *
 * "cleaned" counts items that are gone by the end, whichever way they went:
 * trashed here, trashed or deleted by the run itself, or never found.
 */
export async function runCleanup({ registry, guard, tools, journal, keep }) {
    if (keep) {
        journal.progress(`\n--keep: leaving ${registry.length} created item(s) in place.`);
        return { attempted: registry.length, cleaned: 0, failures: [], skipped: true };
    }
    const failures = [];
    let cleaned = 0;

    // The run's last tool call may have rebuilt the clients; the raw Drive
    // handle is only available on an instrumented one.
    await guard.ensureInstrumented();
    const originals = await guard.rawDrive();
    if (!originals?.['files.get'] || !originals?.['files.update']) {
        throw new StartupRefusal('Internal error: Drive client was not instrumented at cleanup time, so nothing was trashed.');
    }

    // Reverse creation order: files before the folders that hold them.
    for (const item of registry.slice().reverse()) {
        try {
            if (item.kind === 'draft') {
                await tools.get('deleteDraft').execute({ id: item.id }, SILENT);
            } else {
                // Ask Drive about the file BEFORE the containment check: a file
                // the run already deleted is a success, not something the guard
                // has to refuse to touch.
                let meta;
                try {
                    meta = (await originals['files.get']({ fileId: item.id, fields: 'id,trashed', supportsAllDrives: true })).data;
                } catch (error) {
                    if (isNotFound(error)) {
                        cleaned += 1;
                        journal.write({ kind: 'cleanup', id: item.id, resource: item.kind, scenario: item.scenario, ok: true, note: 'already deleted' });
                        continue;
                    }
                    throw error;
                }
                if (meta?.trashed) {
                    cleaned += 1;
                    journal.write({ kind: 'cleanup', id: item.id, resource: item.kind, scenario: item.scenario, ok: true, note: 'already trashed' });
                    continue;
                }
                // Re-verify containment at cleanup time: trash exactly what this
                // run created inside the sandbox, and nothing else, ever.
                if (!(await guard.isInsideTestFolder(item.id))) {
                    failures.push({ ...item, reason: 'no longer inside the test folder; refused to trash' });
                    journal.write({ kind: 'cleanup', id: item.id, resource: item.kind, scenario: item.scenario, ok: false, error: 'outside the test folder' });
                    continue;
                }
                await originals['files.update']({ fileId: item.id, requestBody: { trashed: true }, supportsAllDrives: true });
            }
            cleaned += 1;
            journal.write({ kind: 'cleanup', id: item.id, resource: item.kind, scenario: item.scenario, ok: true });
        } catch (error) {
            if (isNotFound(error)) { cleaned += 1; continue; }
            const reason = error?.message || String(error);
            failures.push({ ...item, reason });
            journal.write({ kind: 'cleanup', id: item.id, resource: item.kind, scenario: item.scenario, ok: false, error: reason });
        }
    }
    return { attempted: registry.length, cleaned, failures, skipped: false };
}

// The most a single recursive listFolderContents call will return. The sandbox
// holds a handful of items between runs; a count anywhere near this means
// something else is wrong, and the audit says so rather than guessing.
const LEFTOVER_SCAN_MAX_ITEMS = 5000;

/**
 * What is still in the sandbox after cleanup, split into what this run is
 * answerable for and what it is not. The sandbox is shared by concurrent runs,
 * so a foreign item is reported but is not this run's failure.
 *
 * "Owned" means the id is in this run's registry or the name carries this run's
 * id (ctx.title() appends it). Anything owned that survives cleanup is a leak.
 *
 * This is the one check that does not trust the registry, so it must not fail
 * open. A listing that could not be made, was cut short, or skipped a folder it
 * could not read comes back with `unverified` set to the reason, `all` null,
 * and both runners treat that as a failed run: an audit that did not happen is
 * not a clean audit. The scan is recursive so a file inside a folder the run
 * created is seen as itself, not hidden behind its parent.
 */
export async function listLeftovers({ tools, folderId, registry, runId, journal }) {
    let listing;
    try {
        listing = JSON.parse(await tools.get('listFolderContents').execute(
            { folderId, includeSubfolders: true, includeFiles: true, depth: 'all', maxItems: LEFTOVER_SCAN_MAX_ITEMS },
            SILENT,
        ));
    } catch (error) {
        const unverified = `could not list the test folder after cleanup: ${error?.message || error}`;
        journal.progress(`  ${unverified}`);
        return { all: null, owned: [], foreign: [], unverified };
    }
    if (listing.truncated) {
        const unverified = `test folder listing was cut short (${listing.truncationReason || 'truncated'}); leftovers could not be verified`;
        journal.progress(`  ${unverified}`);
        return { all: null, owned: [], foreign: [], unverified };
    }
    if (Array.isArray(listing.unreadable) && listing.unreadable.length) {
        const unverified = `${listing.unreadable.length} folder(s) inside the test folder could not be read (${listing.unreadable.map((u) => u.path || u.id).join(', ')}); leftovers could not be verified`;
        journal.progress(`  ${unverified}`);
        return { all: null, owned: [], foreign: [], unverified };
    }
    const all = (listing.entries || []).map((entry) => ({ id: entry.id, name: entry.path || entry.name, mimeType: entry.mimeType }));
    const registered = new Set(registry.map((item) => item.id));
    const owned = all.filter((f) => registered.has(f.id) || (runId && String(f.name ?? '').includes(runId)));
    const foreign = all.filter((f) => !owned.includes(f));
    return { all, owned, foreign, unverified: null };
}

/**
 * Which of this run's drafts still exist, checked by id rather than by search.
 * Only a not-found answer counts as gone. Any other failure (auth, quota,
 * network, a malformed response) is reported in `unverified`, because a draft
 * that could not be looked up is not a draft that was deleted, and both runners
 * fail on a non-empty `unverified` exactly as they do on a non-empty `left`.
 */
export async function listLeftoverDrafts({ tools, registry }) {
    const left = [];
    const unverified = [];
    for (const id of registry.filter((item) => item.kind === 'draft').map((item) => item.id)) {
        try {
            await tools.get('getDraft').execute({ id }, SILENT);
            left.push(id);
        } catch (error) {
            if (hasNotFoundStatus(error)) continue; // Gone, which is what cleanup was supposed to achieve.
            unverified.push({ id, reason: error?.message || String(error) });
        }
    }
    return { left, unverified };
}

/** The exact commands that dispose of a --keep run's artifacts. */
export function keepCommands(registry) {
    const lines = [];
    const driveIds = registry.filter((item) => item.kind === 'drive').map((item) => item.id);
    const draftIds = registry.filter((item) => item.kind === 'draft').map((item) => item.id);
    if (driveIds.length) lines.push(`clean up with: npm run live-call -- --cleanup ${driveIds.join(' ')}`);
    for (const id of draftIds) lines.push(`delete draft with: npm run live-call -- deleteDraft id=${id}`);
    return lines;
}
