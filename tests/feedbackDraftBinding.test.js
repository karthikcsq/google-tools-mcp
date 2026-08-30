// Regression coverage for finding 13: confirmPublicPost did not confirm the
// draft the caller actually reviewed. The publish call used to recompute
// `body` fresh from its own arguments and trust confirmPublicPost on its own,
// so a caller could review one draft (diagnostics off) and then publish a
// second call's different text or newly-opted-in diagnostics. The fix stores
// the exact reviewed title/body/label server-side under a draftId returned
// from the review call, and publication always replays that stored content --
// never anything recomputed from the publish call's own arguments.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock both external-process boundaries feedback's publish path can reach, so
// a successful "publish" in these tests never spawns gh or opens a browser.
const runArgvMock = jest.fn();
const openBrowserMock = jest.fn();
jest.unstable_mockModule('../dist/shellSafe.js', () => ({
    runArgv: (...args) => runArgvMock(...args),
    openBrowser: (...args) => openBrowserMock(...args),
    shellQuote: (value) => JSON.stringify(value),
    formatShellCommand: (argv) => argv.join(' '),
}));

function createMockServer() {
    const tools = new Map();
    return {
        addTool(toolDef) {
            if (tools.has(toolDef.name)) throw new Error(`Duplicate tool name: ${toolDef.name}`);
            tools.set(toolDef.name, toolDef);
        },
        getTools() { return tools; },
    };
}

let feedback;

beforeEach(async () => {
    jest.resetModules();
    runArgvMock.mockReset();
    openBrowserMock.mockReset();
    // gh CLI is unavailable in this test environment, so every successful
    // publish falls through to the separately mocked browser-fallback boundary.
    runArgvMock.mockRejectedValue(new Error('gh CLI not installed'));

    const server = createMockServer();
    const { registerAllTools } = await import('../dist/tools/index.js');
    const { logger } = await import('../dist/logger.js');
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    await registerAllTools(server);
    feedback = server.getTools().get('feedback');
});

describe('feedback draft binding (finding 13)', () => {
    it('review returns a draftId and never publishes', async () => {
        const raw = await feedback.execute({
            type: 'bug', title: 'Title A', description: 'Description A', includeDiagnostics: false,
        });
        const review = JSON.parse(raw);
        expect(review.method).toBe('review-required');
        expect(typeof review.draftId).toBe('string');
        expect(review.draftId.length).toBeGreaterThan(0);
        expect(review.markdown).toContain('Description A');
        expect(review.markdown).not.toContain('Recent Activity');
        expect(runArgvMock).not.toHaveBeenCalled();
        expect(openBrowserMock).not.toHaveBeenCalled();
    });

    it('publishing without a draftId is refused and never reaches gh/browser', async () => {
        await expect(feedback.execute({
            type: 'bug', title: 'Title A', description: 'Description A', confirmPublicPost: true,
        })).rejects.toThrow(/no matching reviewed draft/i);
        expect(runArgvMock).not.toHaveBeenCalled();
        expect(openBrowserMock).not.toHaveBeenCalled();
    });

    it('publishing with an unknown/stale draftId is refused and never reaches gh/browser', async () => {
        await expect(feedback.execute({
            type: 'bug', title: 'Title A', description: 'Description A',
            confirmPublicPost: true, draftId: 'not-a-real-draft-id',
        })).rejects.toThrow(/no matching reviewed draft/i);
        expect(runArgvMock).not.toHaveBeenCalled();
        expect(openBrowserMock).not.toHaveBeenCalled();
    });

    it('a reviewed draftId cannot be used to publish different text or newly opted-in diagnostics', async () => {
        // Review with diagnostics off and description A.
        const reviewRaw = await feedback.execute({
            type: 'bug', title: 'Title A', description: 'Description A', includeDiagnostics: false,
        });
        const review = JSON.parse(reviewRaw);
        expect(review.markdown).toContain('Description A');
        expect(review.markdown).not.toContain('Recent Activity');

        // Attempt to publish under the SAME draftId but with changed title,
        // changed description, and diagnostics now opted in.
        const publishRaw = await feedback.execute({
            type: 'bug', title: 'Title B (unreviewed)', description: 'Description B (unreviewed)',
            includeDiagnostics: true, confirmPublicPost: true, draftId: review.draftId,
        });
        const publish = JSON.parse(publishRaw);

        // The published content is exactly the reviewed draft, not the second
        // call's arguments: it must carry description A, never description B,
        // and never the newly-requested diagnostics section.
        expect(publish.markdown).toBe(review.markdown);
        expect(publish.markdown).toContain('Description A');
        expect(publish.markdown).not.toContain('Description B');
        expect(publish.markdown).not.toContain('unreviewed');

        // gh was probed (and failed), and the browser-fallback URL was built
        // from the reviewed title, not the unreviewed one passed to publish.
        expect(publish.url).toContain(new URLSearchParams({ title: 'Title A' }).toString());
        expect(publish.url).not.toContain('unreviewed');
    });

    it('publishing the exact reviewed draftId succeeds and consumes it (single use)', async () => {
        const reviewRaw = await feedback.execute({
            type: 'bug', title: 'Title A', description: 'Description A',
        });
        const review = JSON.parse(reviewRaw);

        const publishRaw = await feedback.execute({
            type: 'bug', title: 'Title A', description: 'Description A',
            confirmPublicPost: true, draftId: review.draftId,
        });
        const publish = JSON.parse(publishRaw);
        expect(publish.method).toBe('browser-fallback');
        expect(publish.markdown).toBe(review.markdown);
        expect(openBrowserMock).toHaveBeenCalledWith(publish.url);

        // The same draftId cannot be replayed to publish a second time.
        await expect(feedback.execute({
            type: 'bug', title: 'Title A', description: 'Description A',
            confirmPublicPost: true, draftId: review.draftId,
        })).rejects.toThrow(/no matching reviewed draft/i);
    });
});
