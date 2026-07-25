// Tests that the read-before-edit tracker is isolated per session in shared
// HTTP mode (PR #36 review). Two clients reading/mutating the same file must
// not satisfy or clobber each other's guard state. In stdio mode (no ambient
// session) all calls share one default namespace — the original behavior.
import { describe, it, expect } from '@jest/globals';
import { runWithSession } from '../dist/sessionContext.js';
import {
    trackRead,
    guardMutation,
    hasBeenRead,
    getLastReadContent,
    clearSession,
} from '../dist/readTracker.js';

describe('per-session tracker isolation', () => {
    it('does not leak "has been read" across sessions', async () => {
        const id = `iso-read-${Date.now()}`;

        // Session A reads the file.
        await runWithSession('sessionA', async () => {
            trackRead(id, '2026-01-01T00:00:00.000Z');
            expect(hasBeenRead(id)).toBe(true);
        });

        // Session B has NOT read it — its guard must still block.
        await runWithSession('sessionB', async () => {
            expect(hasBeenRead(id)).toBe(false);
            await expect(guardMutation(id, { skipExternalCheck: true }))
                .rejects.toThrow(/has not been read/);
        });
    });

    it('keeps content snapshots separate per session', async () => {
        const id = `iso-content-${Date.now()}`;

        await runWithSession('sessionA', () => {
            trackRead(id, '2026-01-01T00:00:00.000Z', 'A-content');
        });
        await runWithSession('sessionB', () => {
            trackRead(id, '2026-01-01T00:00:00.000Z', 'B-content');
        });

        await runWithSession('sessionA', () => {
            expect(getLastReadContent(id)).toBe('A-content');
        });
        await runWithSession('sessionB', () => {
            expect(getLastReadContent(id)).toBe('B-content');
        });
    });

    it('lets each session mutate its own read independently', async () => {
        const id = `iso-mutate-${Date.now()}`;

        await runWithSession('sessionA', () => trackRead(id, '2026-01-01T00:00:00.000Z'));

        // A can mutate.
        await runWithSession('sessionA', async () => {
            await expect(guardMutation(id, { skipExternalCheck: true }))
                .resolves.toBeUndefined();
        });
        // B still cannot.
        await runWithSession('sessionB', async () => {
            await expect(guardMutation(id, { skipExternalCheck: true }))
                .rejects.toThrow(/has not been read/);
        });
    });

    it('clearSession drops only that session state', async () => {
        const id = `iso-clear-${Date.now()}`;

        await runWithSession('sessionA', () => trackRead(id));
        await runWithSession('sessionB', () => trackRead(id));

        clearSession('sessionA');

        await runWithSession('sessionA', () => {
            expect(hasBeenRead(id)).toBe(false);
        });
        await runWithSession('sessionB', () => {
            expect(hasBeenRead(id)).toBe(true);
        });
    });

    it('stdio (no ambient session) uses one shared default namespace', () => {
        const id = `iso-default-${Date.now()}`;
        // Calls made outside runWithSession share the default namespace.
        trackRead(id);
        expect(hasBeenRead(id)).toBe(true);
    });
});
