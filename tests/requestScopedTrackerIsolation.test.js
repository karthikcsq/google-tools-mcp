// Tests that the read-before-edit tracker is isolated per request context.
//
// This is the port of the old tests/sessionIsolation.test.js. That suite made
// the same assertions against `runWithSession('sessionA', ...)`, the MCP-session
// namespace FastMCP's shared HTTP transport handed out. The 2026-07-28 runtime
// has no sessions: `dist/requestContext.js` scopes state to one authenticated
// HTTP request or one pinned stdio connection, so the identical accept/reject
// matrix is asserted here through `runWithRequestContext` instead. The former
// `clearSession` case is replaced by the two properties that made it necessary
// — an HTTP context never sees another context's reads, and it never falls back
// to the no-context namespace either.
import { describe, it, expect } from '@jest/globals';
import {
    createHttpRequestContext,
    createStdioConnectionContext,
    fingerprintCredential,
    runWithRequestContext,
} from '../dist/requestContext.js';
import {
    trackRead,
    guardMutation,
    hasBeenRead,
    getLastReadContent,
} from '../dist/readTracker.js';

const httpContext = (credential) => createHttpRequestContext({
    principalFingerprint: fingerprintCredential(credential),
    profile: 'default',
    epoch: 'test-epoch',
});

const stdioContext = () => createStdioConnectionContext({
    principalFingerprint: fingerprintCredential('stdio'),
    profile: 'default',
    epoch: 'test-epoch',
});

describe('per-request tracker isolation', () => {
    it('does not leak "has been read" across requests', async () => {
        const id = `iso-read-${Date.now()}`;

        // Request A reads the file.
        await runWithRequestContext(httpContext('token-a'), async () => {
            trackRead(id, '2026-01-01T00:00:00.000Z');
            expect(hasBeenRead(id)).toBe(true);
        });

        // Request B has NOT read it — its guard must still block. On HTTP the
        // block is the stateless fail-closed message, not the "read it first"
        // one: an earlier request's read can never authorize this write.
        await runWithRequestContext(httpContext('token-b'), async () => {
            expect(hasBeenRead(id)).toBe(false);
            await expect(guardMutation(id, { skipExternalCheck: true }))
                .rejects.toThrow(/has not been read in this request/);
        });
    });

    it('keeps content snapshots separate per request', async () => {
        const id = `iso-content-${Date.now()}`;
        const a = httpContext('token-a');
        const b = httpContext('token-b');

        await runWithRequestContext(a, () => {
            trackRead(id, '2026-01-01T00:00:00.000Z', 'A-content');
        });
        await runWithRequestContext(b, () => {
            trackRead(id, '2026-01-01T00:00:00.000Z', 'B-content');
        });

        await runWithRequestContext(a, () => {
            expect(getLastReadContent(id)).toBe('A-content');
        });
        await runWithRequestContext(b, () => {
            expect(getLastReadContent(id)).toBe('B-content');
        });
    });

    it('lets a stdio connection mutate its own read while a second connection cannot', async () => {
        const id = `iso-mutate-${Date.now()}`;
        const first = stdioContext();
        const second = stdioContext();

        await runWithRequestContext(first, () => trackRead(id, '2026-01-01T00:00:00.000Z'));

        // The pinned connection that read it can mutate.
        await runWithRequestContext(first, async () => {
            await expect(guardMutation(id, { skipExternalCheck: true }))
                .resolves.toBeUndefined();
        });
        // A different connection still cannot.
        await runWithRequestContext(second, async () => {
            await expect(guardMutation(id, { skipExternalCheck: true }))
                .rejects.toThrow(/has not been read/);
        });
    });

    it("drops a request context's tracker state with the request, with no shared fallback", async () => {
        // The old suite proved this with clearSession(). There is no session to
        // clear now: state lives in a WeakMap keyed on the context object, so a
        // finished request simply has nothing left to find, and — the part that
        // matters — a new request does not inherit the no-context namespace.
        const id = `iso-scope-${Date.now()}`;

        // A no-context caller (a direct unit test, or startup code) uses the
        // single default namespace.
        trackRead(id, '2026-01-01T00:00:00.000Z');
        expect(hasBeenRead(id)).toBe(true);

        // An HTTP request must not be able to borrow it.
        await runWithRequestContext(httpContext('token-c'), async () => {
            expect(hasBeenRead(id)).toBe(false);
            await expect(guardMutation(id, { skipExternalCheck: true }))
                .rejects.toThrow(/read state is never shared between requests/);
        });

        // And a fresh request does not see the previous request's read either.
        const previous = httpContext('token-d');
        await runWithRequestContext(previous, () => trackRead(id, '2026-01-01T00:00:00.000Z'));
        await runWithRequestContext(httpContext('token-d'), () => {
            expect(hasBeenRead(id)).toBe(false);
        });
    });

    it('no-context callers share one default namespace', () => {
        const id = `iso-default-${Date.now()}`;
        // Calls made outside runWithRequestContext share the default namespace.
        trackRead(id);
        expect(hasBeenRead(id)).toBe(true);
    });
});
