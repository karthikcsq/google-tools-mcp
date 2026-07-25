// End-to-end regression test for the merge-blocking review on PR #64
// (dist/readTracker.js:30), driven through a real mutating docs tool the same
// way tests/mutatingDocsToolsWriteControl.test.js does.
//
// Before the fix, guardMutation's external-change/diff branch refreshed
// entry.content and entry.modifiedTime but left entry.revisionId pointing at
// the pre-external-edit revision. So a caller that correctly rebased its edit
// on the diff and retried in the same session (no re-read) would send that
// guaranteed-stale revisionId as requiredRevisionId — a second, confusing
// conflict even though the rebase was correct.
//
// This test proves: read -> external edit -> diff error -> rebased retry
// succeeds, and the retry's batchUpdate call carries the REFRESHED revision,
// not the stale pre-edit one.
import { describe, it, expect, jest } from '@jest/globals';

let fakeDocs;
let fakeDrive;
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => fakeDocs,
    getDriveClient: async () => fakeDrive,
    getSheetsClient: async () => { throw new Error('not used'); },
    getCalendarClient: async () => { throw new Error('not used'); },
    getScriptClient: async () => { throw new Error('not used'); },
}));

const { trackRead } = await import('../dist/readTracker.js');
const { register } = await import('../dist/tools/utils/appendMarkdownToGoogleDoc.js');

function createMockServer() {
    const tools = new Map();
    return {
        addTool(def) { tools.set(def.name, def); },
        getTool(name) { return tools.get(name); },
    };
}

const noopLog = { info() {}, error() {}, warn() {}, debug() {} };

describe('appendMarkdown — revisionId refresh on external-change diff (PR #64 thread)', () => {
    it('a rebased retry after a diff error sends the refreshed revision, not the stale one', async () => {
        const documentId = `append-revision-refresh-${Date.now()}`;
        trackRead(documentId, '2026-01-01T00:00:00.000Z', '# old content\n', 'rev-before-external-edit');

        // Drive reports a modifiedTime change (an external edit happened).
        // documents.get (used both by guardMutation's contentFetcher and by
        // appendMarkdown's own end-index lookup) returns the document at its
        // new revision.
        fakeDrive = { files: { get: async () => ({ data: { modifiedTime: '2026-01-02T00:00:00.000Z' } }) } };
        fakeDocs = {
            documents: {
                get: async () => ({
                    data: {
                        revisionId: 'rev-after-external-edit',
                        body: { content: [{ endIndex: 20 }] },
                    },
                }),
                batchUpdate: async () => { throw new Error('must not be called on the first (blocked) attempt'); },
            },
        };

        const server = createMockServer();
        register(server);
        const tool = server.getTool('appendMarkdown');

        // First attempt: blocked with a diff (external change detected).
        await expect(
            tool.execute({ documentId, markdown: 'more text' }, { log: noopLog })
        ).rejects.toThrow(/modified externally/i);

        // Retry: no further external change (modifiedTime stable), so the
        // rebased write goes through. Capture the requiredRevisionId it is
        // actually sent with.
        const batchUpdate = jest.fn(async ({ requestBody }) => ({
            data: { writeControl: requestBody.writeControl },
        }));
        fakeDocs.documents.batchUpdate = batchUpdate;

        const result = await tool.execute({ documentId, markdown: 'more text' }, { log: noopLog });
        expect(result).toMatch(/Successfully appended/);

        // appendMarkdown may split its content into more than one batchUpdate call
        // (e.g. a spacing-only insert followed by the content insert), but the
        // FIRST call is the one guardMutation's revision is threaded into — that
        // is the one this regression is about.
        expect(batchUpdate).toHaveBeenCalled();
        const sentWriteControl = batchUpdate.mock.calls[0][0].requestBody.writeControl;
        // The point of the regression: this must be the REFRESHED revision from
        // the diff step. Before the fix this was
        // { requiredRevisionId: 'rev-before-external-edit' } — a revision
        // Google's API would reject as a second, guaranteed conflict.
        expect(sentWriteControl).toEqual({ requiredRevisionId: 'rev-after-external-edit' });
    });
});
