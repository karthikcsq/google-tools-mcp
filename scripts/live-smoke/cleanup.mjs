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

function isNotFound(error) {
    if (!error) return false;
    if (error.code === 404 || error.status === 404 || error.response?.status === 404) return true;
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

/**
 * What is still in the sandbox after cleanup, split into what this run is
 * answerable for and what it is not. The sandbox is shared by concurrent runs,
 * so a foreign item is reported but is not this run's failure.
 *
 * "Owned" means the id is in this run's registry or the name carries this run's
 * id (ctx.title() appends it). Anything owned that survives cleanup is a leak.
 */
export async function listLeftovers({ tools, folderId, registry, runId, journal }) {
    let listing;
    try {
        listing = JSON.parse(await tools.get('listFolderContents').execute(
            { folderId, includeSubfolders: true, includeFiles: true, maxResults: 100 },
            SILENT,
        ));
    } catch (error) {
        journal.progress(`  could not list the test folder after cleanup: ${error.message}`);
        return { all: null, owned: [], foreign: [] };
    }
    const all = [...(listing.folders || []), ...(listing.files || [])];
    const registered = new Set(registry.map((item) => item.id));
    const owned = all.filter((f) => registered.has(f.id) || (runId && String(f.name ?? '').includes(runId)));
    const foreign = all.filter((f) => !owned.includes(f));
    return { all, owned, foreign };
}

/** Which of this run's drafts still exist, checked by id rather than by search. */
export async function listLeftoverDrafts({ tools, registry }) {
    const left = [];
    for (const id of registry.filter((item) => item.kind === 'draft').map((item) => item.id)) {
        try {
            await tools.get('getDraft').execute({ id }, SILENT);
            left.push(id);
        } catch {
            // Gone, which is what cleanup was supposed to achieve.
        }
    }
    return left;
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
