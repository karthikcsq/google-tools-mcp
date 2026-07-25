// Regression test for the merge-blocking review on PR #64 (dist/readTracker.js:30):
// guardMutation's external-change/diff branch refreshed entry.content and
// entry.modifiedTime when an external edit was detected, but left entry.revisionId
// pointing at the PRE-external-edit revision. A caller that correctly rebased its
// edit on the returned diff and retried in the same session would then send that
// guaranteed-stale revisionId as requiredRevisionId, producing a second, confusing
// conflict even though the rebase was correct.
//
// The fix: contentFetcher now returns { content, revisionId } instead of a bare
// string, and guardMutation refreshes content, modifiedTime, AND revisionId
// together (atomically) in the diff branch, so a rebased retry is guarded against
// the version the diff was actually taken from.
//
// See tests/appendMarkdownRevisionRefresh.test.js for the same regression proven
// end-to-end through a real mutating docs tool.
import { describe, it, expect, jest } from '@jest/globals';

let fakeDrive;
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => { throw new Error('not used'); },
    getDriveClient: async () => fakeDrive,
    getSheetsClient: async () => { throw new Error('not used'); },
    getCalendarClient: async () => { throw new Error('not used'); },
    getScriptClient: async () => { throw new Error('not used'); },
}));

const { trackRead, guardMutation, getLastReadRevisionId } = await import('../dist/readTracker.js');

function mockDriveReturning(modifiedTime) {
    fakeDrive = { files: { get: async () => ({ data: { modifiedTime } }) } };
}

describe('guardMutation — revisionId refresh on external-change diff (PR #64 thread)', () => {
    it('refreshes revisionId together with content/modifiedTime when contentFetcher returns the new revision', async () => {
        const id = `guard-revision-refresh-${Date.now()}`;
        // Simulate a prior readDocument: content + modifiedTime + revisionId captured.
        trackRead(id, '2026-01-01T00:00:00.000Z', '# old content', 'rev-before-external-edit');
        expect(getLastReadRevisionId(id)).toBe('rev-before-external-edit');

        // Simulate a collaborator editing the doc externally: Drive now reports a
        // different modifiedTime.
        mockDriveReturning('2026-01-02T00:00:00.000Z');

        const contentFetcher = jest.fn(async () => ({
            content: '# new content from collaborator',
            revisionId: 'rev-after-external-edit',
        }));

        // First call: detects the external change and throws with a diff.
        await expect(guardMutation(id, { contentFetcher })).rejects.toThrow(
            /modified externally/i
        );
        expect(contentFetcher).toHaveBeenCalledTimes(1);

        // The bug: revisionId stayed 'rev-before-external-edit' here. The fix:
        // it must now be the revision the diff was actually generated against.
        expect(getLastReadRevisionId(id)).toBe('rev-after-external-edit');

        // Second call (the caller's rebased retry, same session, no re-read):
        // Drive's modifiedTime now matches the refreshed entry, so the guard
        // passes — and getLastReadRevisionId resolves to the fresh, non-stale
        // revision a write would carry as requiredRevisionId.
        await expect(guardMutation(id, { contentFetcher })).resolves.toBeUndefined();
        expect(getLastReadRevisionId(id)).toBe('rev-after-external-edit');
    });

    it('clears revisionId (does not leave it stale) when contentFetcher returns a bare string', async () => {
        // Defensive fallback: a contentFetcher that hasn't been updated to the new
        // { content, revisionId } contract must not leave the pre-edit revision in
        // place either. Clearing sends the next write out unguarded (safe) rather
        // than with a requiredRevisionId that is guaranteed to conflict (unsafe).
        const id = `guard-revision-clear-${Date.now()}`;
        trackRead(id, '2026-01-01T00:00:00.000Z', '# old content', 'rev-before-external-edit');
        mockDriveReturning('2026-01-02T00:00:00.000Z');

        const legacyStringFetcher = jest.fn(async () => '# new content, legacy string return');

        await expect(guardMutation(id, { contentFetcher: legacyStringFetcher })).rejects.toThrow(
            /modified externally/i
        );

        expect(getLastReadRevisionId(id)).toBeNull();
    });
});
