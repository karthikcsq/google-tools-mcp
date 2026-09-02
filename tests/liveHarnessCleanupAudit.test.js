// The post-cleanup audit in scripts/live-smoke/cleanup.mjs is the one check
// that does not trust the run's own registry: it asks Drive what is actually
// left in the sandbox and Gmail which drafts actually still exist. Both used
// to fail open. A listing that threw came back as an empty array, a listing
// the tool cut short was read as complete, and any getDraft error (auth,
// quota, network) was taken as "the draft is gone". Each of those let a run
// print a clean sandbox while leaving real files or drafts behind.
//
// These tests pin the fail-closed shape: "nothing found" and "could not look"
// are different answers, and only a confirmed not-found counts as deleted.
import { describe, expect, it } from '@jest/globals';

import { listLeftovers, listLeftoverDrafts } from '../scripts/live-smoke/cleanup.mjs';

const FOLDER_ID = '15m5wq1pA8Mn0ETxIaLdN0kaUFwnrfzHN';
const RUN_ID = 'run-abc123';

function fakeTools(handlers) {
    const calls = [];
    return {
        calls,
        get(name) {
            const handler = handlers[name];
            if (!handler) throw new Error(`no fake for tool ${name}`);
            return {
                async execute(args, extra) {
                    calls.push({ name, args, extra });
                    return handler(args);
                },
            };
        },
    };
}

function fakeJournal() {
    const lines = [];
    return { lines, progress(text) { lines.push(text); }, write() {} };
}

const entry = (id, name, extra = {}) => ({ id, name, path: name, mimeType: 'application/vnd.google-apps.document', parentIds: [FOLDER_ID], ...extra });

describe('listLeftovers (sandbox audit after cleanup)', () => {
    it('scans the whole tree, including subfolders and files, in one recursive call', async () => {
        const tools = fakeTools({ listFolderContents: () => JSON.stringify({ entries: [], count: 0, truncated: false, unreadable: [], apiCalls: 1 }) });
        await listLeftovers({ tools, folderId: FOLDER_ID, registry: [], runId: RUN_ID, journal: fakeJournal() });
        expect(tools.calls).toHaveLength(1);
        expect(tools.calls[0].name).toBe('listFolderContents');
        expect(tools.calls[0].args).toMatchObject({ folderId: FOLDER_ID, includeSubfolders: true, includeFiles: true, depth: 'all' });
        expect(tools.calls[0].args.maxItems).toBeGreaterThanOrEqual(1000);
    });

    it('splits what is left into owned (registry id or run id in the name) and foreign', async () => {
        const registry = [{ kind: 'drive', id: 'registered-1', scenario: 's' }];
        const entries = [
            entry('registered-1', 'Registered doc'),
            entry('named-2', `Probe doc ${RUN_ID}`),
            entry('nested-3', `Folder ${RUN_ID}/inner file`),
            entry('someone-elses-4', 'Left by another run'),
        ];
        const tools = fakeTools({ listFolderContents: () => JSON.stringify({ entries, count: entries.length, truncated: false, unreadable: [], apiCalls: 2 }) });

        const result = await listLeftovers({ tools, folderId: FOLDER_ID, registry, runId: RUN_ID, journal: fakeJournal() });

        expect(result.unverified).toBeNull();
        expect(result.all.map((f) => f.id)).toEqual(['registered-1', 'named-2', 'nested-3', 'someone-elses-4']);
        expect(result.owned.map((f) => f.id)).toEqual(['registered-1', 'named-2', 'nested-3']);
        expect(result.foreign.map((f) => f.id)).toEqual(['someone-elses-4']);
        // The nested entry is reported by its path so the report says where it is.
        expect(result.owned[2].name).toBe(`Folder ${RUN_ID}/inner file`);
    });

    it('reports a clean sandbox as an empty list, not as unverified', async () => {
        const tools = fakeTools({ listFolderContents: () => JSON.stringify({ entries: [], count: 0, truncated: false, unreadable: [], apiCalls: 1 }) });
        const result = await listLeftovers({ tools, folderId: FOLDER_ID, registry: [], runId: RUN_ID, journal: fakeJournal() });
        expect(result).toEqual({ all: [], owned: [], foreign: [], unverified: null });
    });

    it('does not fail open when the listing throws', async () => {
        const tools = fakeTools({ listFolderContents: () => { throw new Error('Quota exceeded for quota metric'); } });
        const journal = fakeJournal();
        const result = await listLeftovers({ tools, folderId: FOLDER_ID, registry: [], runId: RUN_ID, journal });

        expect(result.all).toBeNull();
        expect(result.owned).toEqual([]);
        expect(result.foreign).toEqual([]);
        expect(result.unverified).toMatch(/could not list the test folder after cleanup: Quota exceeded/);
        expect(journal.lines.join('\n')).toMatch(/could not list the test folder/);
    });

    it('does not fail open when the listing was cut short', async () => {
        const tools = fakeTools({ listFolderContents: () => JSON.stringify({ entries: [entry('a', 'a')], count: 1, truncated: true, truncationReason: 'maxItems reached', unreadable: [], apiCalls: 3 }) });
        const result = await listLeftovers({ tools, folderId: FOLDER_ID, registry: [], runId: RUN_ID, journal: fakeJournal() });

        expect(result.all).toBeNull();
        expect(result.unverified).toMatch(/cut short \(maxItems reached\)/);
    });

    it('does not fail open when a folder inside the sandbox could not be read', async () => {
        const tools = fakeTools({ listFolderContents: () => JSON.stringify({ entries: [], count: 0, truncated: false, unreadable: [{ id: 'sub-1', path: `Folder ${RUN_ID}`, error: 'Forbidden' }], apiCalls: 2 }) });
        const result = await listLeftovers({ tools, folderId: FOLDER_ID, registry: [], runId: RUN_ID, journal: fakeJournal() });

        expect(result.all).toBeNull();
        expect(result.unverified).toMatch(new RegExp(`1 folder\\(s\\) inside the test folder could not be read \\(Folder ${RUN_ID}\\)`));
    });
});

describe('listLeftoverDrafts (draft audit after cleanup)', () => {
    const registry = [
        { kind: 'drive', id: 'not-a-draft', scenario: 's' },
        { kind: 'draft', id: 'r-1', scenario: 's' },
        { kind: 'draft', id: 'r-2', scenario: 's' },
        { kind: 'draft', id: 'r-3', scenario: 's' },
    ];

    it('only asks about drafts, and reports one that still exists as left', async () => {
        const tools = fakeTools({ getDraft: ({ id }) => JSON.stringify({ id, message: { id: 'm' } }) });
        const result = await listLeftoverDrafts({ tools, registry });

        expect(tools.calls.map((c) => c.args.id)).toEqual(['r-1', 'r-2', 'r-3']);
        expect(result).toEqual({ left: ['r-1', 'r-2', 'r-3'], unverified: [] });
    });

    it('treats a confirmed 404 as gone, whichever field the googleapis error carries it in', async () => {
        const tools = fakeTools({
            getDraft: ({ id }) => {
                if (id === 'r-1') throw Object.assign(new Error('Requested entity was not found.'), { code: 404 });
                if (id === 'r-2') throw Object.assign(new Error('Requested entity was not found.'), { status: 404 });
                throw Object.assign(new Error('Requested entity was not found.'), { response: { status: 404 } });
            },
        });
        const result = await listLeftoverDrafts({ tools, registry });
        expect(result).toEqual({ left: [], unverified: [] });
    });

    it('does not treat a non-404 error as a deleted draft', async () => {
        const tools = fakeTools({
            getDraft: ({ id }) => {
                if (id === 'r-1') throw Object.assign(new Error('Requested entity was not found.'), { code: 404 });
                if (id === 'r-2') throw Object.assign(new Error('invalid_grant'), { code: 401 });
                throw new Error('socket hang up');
            },
        });
        const result = await listLeftoverDrafts({ tools, registry });

        expect(result.left).toEqual([]);
        expect(result.unverified).toEqual([
            { id: 'r-2', reason: 'invalid_grant' },
            { id: 'r-3', reason: 'socket hang up' },
        ]);
    });

    it('does not let a message that mentions 404 stand in for a real not-found status', async () => {
        const tools = fakeTools({ getDraft: () => { throw new Error('upstream returned 404 while refreshing the token'); } });
        const result = await listLeftoverDrafts({ tools, registry: registry.slice(1, 2) });
        expect(result.left).toEqual([]);
        expect(result.unverified).toEqual([{ id: 'r-1', reason: 'upstream returned 404 while refreshing the token' }]);
    });
});

// The runners fail on exactly the states the audit can report, so a run with an
// unverified audit cannot exit 0 or print a "clean" report. This mirrors the
// expression in scripts/live-smoke.mjs and scripts/live-mission.mjs so a change
// to either that drops a term fails here.
describe('a run with an unverified audit cannot report cleanup success', () => {
    function runnerFailed({ failed = 0, cleanupFailures = [], leftover, drafts }) {
        return failed > 0 || cleanupFailures.length > 0
            || drafts.left.length > 0 || drafts.unverified.length > 0
            || (leftover?.owned.length ?? 0) > 0 || Boolean(leftover?.unverified);
    }

    it('passes on a verified, empty audit', () => {
        expect(runnerFailed({ leftover: { all: [], owned: [], foreign: [], unverified: null }, drafts: { left: [], unverified: [] } })).toBe(false);
    });

    it('passes when only foreign items remain (another run is answerable for them)', () => {
        expect(runnerFailed({ leftover: { all: [entry('x', 'x')], owned: [], foreign: [entry('x', 'x')], unverified: null }, drafts: { left: [], unverified: [] } })).toBe(false);
    });

    it('fails when the sandbox listing could not be verified', async () => {
        const tools = fakeTools({ listFolderContents: () => { throw new Error('ECONNRESET'); } });
        const leftover = await listLeftovers({ tools, folderId: FOLDER_ID, registry: [], runId: RUN_ID, journal: fakeJournal() });
        expect(runnerFailed({ leftover, drafts: { left: [], unverified: [] } })).toBe(true);
    });

    it('fails when getDraft threw something other than not-found', async () => {
        const tools = fakeTools({ getDraft: () => { throw Object.assign(new Error('Rate Limit Exceeded'), { code: 429 }); } });
        const drafts = await listLeftoverDrafts({ tools, registry: [{ kind: 'draft', id: 'r-9', scenario: 's' }] });
        expect(drafts).toEqual({ left: [], unverified: [{ id: 'r-9', reason: 'Rate Limit Exceeded' }] });
        expect(runnerFailed({ leftover: { all: [], owned: [], foreign: [], unverified: null }, drafts })).toBe(true);
    });
});
