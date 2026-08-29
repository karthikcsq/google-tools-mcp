// Regression tests for issue #119: guardMutation raised a staleness error on a
// document that had not actually changed.
//
// Two independent triggers were reported, both of which the byte-identical retry
// immediately after them survived:
//
//   1. Drive returned a modifiedTime OLDER than the one the read recorded (the
//      issue's error quoted a "last modified" earlier than its own "last read").
//      Drive's modifiedTime is eventually consistent, so a lagging replica is a
//      view from further back in time, not somebody else's edit.
//   2. The timestamp moved but the content was byte-identical — an autosave
//      tick, a formatting touch, or Drive re-stamping the file after our own
//      preceding write. The error carried an EMPTY unified diff, and its
//      prescribed recovery (re-read, inspect, rebase, retry) had nothing to
//      rebase onto.
//
// Neither case loses a guarantee by proceeding: the write still carries a
// WriteControl requiredRevisionId, so a genuine concurrent edit is refused by
// Google itself.
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

describe('guardMutation — phantom staleness (#119)', () => {
    it('does not treat a modifiedTime that moved BACKWARDS as an external edit', async () => {
        const id = `phantom-backwards-${Date.now()}`;
        trackRead(id, '2026-08-28T02:38:38.713Z', '# unchanged', 'rev-read');
        // The lagging replica: 5 seconds before what this file's own read saw.
        mockDriveReturning('2026-08-28T02:38:33.897Z');

        const contentFetcher = jest.fn(async () => ({ content: '# unchanged', revisionId: 'rev-read' }));
        await expect(guardMutation(id, { contentFetcher })).resolves.toBeUndefined();
        // Not even fetched: the timestamp comparison settles it on its own.
        expect(contentFetcher).not.toHaveBeenCalled();
    });

    it('keeps the newer baseline after a backwards reading, so a real later edit still trips', async () => {
        const id = `phantom-backwards-baseline-${Date.now()}`;
        trackRead(id, '2026-08-28T02:38:38.713Z', '# unchanged', 'rev-read');
        mockDriveReturning('2026-08-28T02:38:33.897Z');
        await expect(guardMutation(id, {})).resolves.toBeUndefined();

        // A genuine collaborator edit, later than the recorded baseline. If the
        // backwards reading had been written into the baseline, this would be
        // compared against 02:38:33 instead — still caught here, but the point
        // is that the baseline never moves backwards.
        mockDriveReturning('2026-08-28T03:00:00.000Z');
        await expect(guardMutation(id, {})).rejects.toThrow(/modified externally/i);
    });

    it('does not raise when the timestamp moved but the content is byte-identical', async () => {
        const id = `phantom-empty-diff-${Date.now()}`;
        trackRead(id, '2026-08-28T02:38:33.897Z', '# same bytes', 'rev-read');
        mockDriveReturning('2026-08-28T02:38:38.713Z');

        const contentFetcher = jest.fn(async () => ({ content: '# same bytes', revisionId: 'rev-after-autosave' }));
        await expect(guardMutation(id, { contentFetcher })).resolves.toBeUndefined();
        expect(contentFetcher).toHaveBeenCalledTimes(1);
        // The baseline is re-armed on the revision that content came from, so
        // the write that follows is guarded against the CURRENT revision rather
        // than one that is guaranteed to conflict.
        expect(getLastReadRevisionId(id)).toBe('rev-after-autosave');
    });

    it('still raises with a real diff when the content actually changed', async () => {
        const id = `phantom-real-change-${Date.now()}`;
        trackRead(id, '2026-08-28T02:38:33.897Z', '# before', 'rev-read');
        mockDriveReturning('2026-08-28T02:38:38.713Z');

        const contentFetcher = jest.fn(async () => ({ content: '# after', revisionId: 'rev-collaborator' }));
        const failure = await guardMutation(id, { contentFetcher }).then(() => null, (error) => error);
        expect(failure).toBeTruthy();
        expect(failure.message).toMatch(/modified externally/i);
        expect(failure.message).toContain('--- DIFF (last read → current) ---');
        // A non-empty diff: the guard is still doing its job for a real edit.
        expect(failure.message).toContain('-# before');
        expect(failure.message).toContain('+# after');
    });

    it('leaves the bare "modified externally" path intact when no contentFetcher is supplied', async () => {
        const id = `phantom-no-fetcher-${Date.now()}`;
        trackRead(id, '2026-08-28T02:38:33.897Z', '# before', 'rev-read');
        mockDriveReturning('2026-08-28T02:38:38.713Z');
        await expect(guardMutation(id, {})).rejects.toThrow(/modified externally/i);
    });
});
