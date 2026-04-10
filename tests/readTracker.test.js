// Tests for the read-before-edit guard (readTracker.js, issue #18).
// These tests exercise the in-memory tracker without touching Google APIs.
import { describe, it, expect, beforeEach } from '@jest/globals';

// We need to re-import for each test to get a fresh module state.
// Jest with ESM doesn't reset module state between tests, so we test
// the exported functions directly and rely on the Map being shared.

let trackRead, guardMutation, trackMutation, hasBeenRead;

beforeEach(async () => {
    // Dynamic import — module state persists across tests within same worker,
    // but we can work around it by using unique file IDs per test.
    const mod = await import('../dist/readTracker.js');
    trackRead = mod.trackRead;
    guardMutation = mod.guardMutation;
    trackMutation = mod.trackMutation;
    hasBeenRead = mod.hasBeenRead;
});

describe('readTracker', () => {
    // --- trackRead / hasBeenRead ---
    describe('trackRead and hasBeenRead', () => {
        it('marks a file as read', () => {
            const id = `track-read-${Date.now()}-1`;
            expect(hasBeenRead(id)).toBe(false);
            trackRead(id);
            expect(hasBeenRead(id)).toBe(true);
        });

        it('tracks multiple files independently', () => {
            const id1 = `track-multi-${Date.now()}-1`;
            const id2 = `track-multi-${Date.now()}-2`;
            trackRead(id1);
            expect(hasBeenRead(id1)).toBe(true);
            expect(hasBeenRead(id2)).toBe(false);
        });

        it('records modifiedTime if provided', () => {
            const id = `track-modtime-${Date.now()}`;
            trackRead(id, '2026-01-01T00:00:00.000Z');
            expect(hasBeenRead(id)).toBe(true);
        });
    });

    // --- guardMutation ---
    describe('guardMutation', () => {
        it('throws when file has never been read', async () => {
            const id = `guard-unread-${Date.now()}`;
            await expect(guardMutation(id, { skipExternalCheck: true }))
                .rejects
                .toThrow(/has not been read/);
        });

        it('passes when file has been read (skip external check)', async () => {
            const id = `guard-read-${Date.now()}`;
            trackRead(id);
            // Should not throw
            await expect(guardMutation(id, { skipExternalCheck: true }))
                .resolves
                .toBeUndefined();
        });

        it('error message includes the file ID', async () => {
            const id = `guard-msg-${Date.now()}`;
            try {
                await guardMutation(id, { skipExternalCheck: true });
                // Should not reach here
                expect(true).toBe(false);
            } catch (error) {
                expect(error.message).toContain(id);
            }
        });

        it('error message suggests read tools', async () => {
            const id = `guard-suggest-${Date.now()}`;
            try {
                await guardMutation(id, { skipExternalCheck: true });
                expect(true).toBe(false);
            } catch (error) {
                expect(error.message).toContain('readDocument');
                expect(error.message).toContain('readSpreadsheet');
            }
        });
    });

    // --- trackMutation ---
    describe('trackMutation', () => {
        it('updates readAt timestamp after mutation', async () => {
            const id = `mutate-track-${Date.now()}`;
            trackRead(id, '2026-01-01T00:00:00.000Z');
            // Guard should pass
            await guardMutation(id, { skipExternalCheck: true });
            // Track the mutation
            trackMutation(id);
            // Guard should still pass (file is still "read")
            await expect(guardMutation(id, { skipExternalCheck: true }))
                .resolves
                .toBeUndefined();
        });

        it('is a no-op for files that were never read', () => {
            const id = `mutate-noread-${Date.now()}`;
            // Should not throw — just silently ignores
            expect(() => trackMutation(id)).not.toThrow();
        });
    });

    // --- Integration: read → mutate → mutate again ---
    describe('full workflow', () => {
        it('supports read → mutate → mutate cycle with skipExternalCheck', async () => {
            const id = `workflow-${Date.now()}`;

            // 1. Can't mutate unread file
            await expect(guardMutation(id, { skipExternalCheck: true }))
                .rejects.toThrow();

            // 2. Read it
            trackRead(id);

            // 3. First mutation passes
            await expect(guardMutation(id, { skipExternalCheck: true }))
                .resolves.toBeUndefined();
            trackMutation(id);

            // 4. Second mutation also passes (trackMutation keeps it readable)
            await expect(guardMutation(id, { skipExternalCheck: true }))
                .resolves.toBeUndefined();
        });
    });
});
