// findTextRange structured failures (issue #105).
//
// A failed textToFind used to produce a bare `null`, which every caller turned
// into "Could not find X" — true, unactionable, and identical whether the
// search string was for a different document or was one character off. These
// pin the structured failure and the fact that the callers render it.
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => fakeDocs,
    getDriveClient: async () => ({ files: { get: async () => ({ data: { modifiedTime: null } }) } }),
}));

const GDocsHelpers = await import('../dist/googleDocsApiHelpers.js');
const { register: registerModifyText } = await import('../dist/tools/docs/modifyText.js');
const { trackRead, resetTracker } = await import('../dist/readTracker.js');

const DOC_TEXT = 'The quick brown fox jumps over the lazy dog\nA second line of text\n';

function docWithText(text) {
    return {
        data: {
            revisionId: 'rev-find-1',
            body: {
                content: [{
                    startIndex: 1,
                    endIndex: text.length + 1,
                    paragraph: {
                        elements: [{ startIndex: 1, endIndex: text.length + 1, textRun: { content: text } }],
                    },
                }],
            },
        },
    };
}

let fakeDocs;
const batchUpdate = jest.fn(async () => ({ data: {} }));

beforeEach(() => {
    batchUpdate.mockClear();
    fakeDocs = { documents: { get: async () => docWithText(DOC_TEXT), batchUpdate } };
    if (typeof resetTracker === 'function') resetTracker();
});

const log = { info() {}, error() {}, warn() {}, debug() {} };

describe('findTextRange structured failure', () => {
    it('reports where a near-miss search diverged', async () => {
        const result = await GDocsHelpers.findTextRange(
            fakeDocs, 'doc-1', 'The quick brown cat jumps', undefined, undefined);

        expect(result.found).toBe(false);
        expect(result.reason).toBe('notFound');
        expect(result.textToFind).toBe('The quick brown cat jumps');
        expect(result.bestPrefixLength).toBe('The quick brown '.length);
        expect(result.divergenceIndex).toBe('The quick brown '.length);
        expect(result.candidateCount).toBe(1);
        expect(result.contextAfter).toContain('fox');
        expect(result.message).toMatch(/diverged at offset 16/);
        expect(result.message).toMatch(/format='index'/);
    });

    it('says so plainly when nothing at all matched', async () => {
        const result = await GDocsHelpers.findTextRange(fakeDocs, 'doc-1', '☃ unmatchable', undefined, undefined);
        expect(result.found).toBe(false);
        expect(result.bestPrefixLength).toBe(0);
        expect(result.divergenceIndex).toBeNull();
        expect(result.message).toMatch(/different document or tab/);
    });

    it('names the real match count when the requested instance does not exist', async () => {
        const result = await GDocsHelpers.findTextRange(fakeDocs, 'doc-1', 'the', 9, undefined);
        expect(result.found).toBe(false);
        expect(result.reason).toBe('instanceOutOfRange');
        expect(result.candidateCount).toBeGreaterThan(0);
        expect(result.message).toMatch(/Instance 9 of "the"/);
        expect(result.message).toMatch(/only \d+ match/);
    });

    it('reports a document with no readable content', async () => {
        fakeDocs = { documents: { get: async () => ({ data: { revisionId: 'r' } }) } };
        const result = await GDocsHelpers.findTextRange(fakeDocs, 'doc-1', 'anything', undefined, undefined);
        expect(result.found).toBe(false);
        expect(result.reason).toBe('noContent');
        expect(result.message).toMatch(/no readable text content/);
    });

    it('still succeeds through every fallback strategy', async () => {
        // Exact.
        await expect(GDocsHelpers.findTextRange(fakeDocs, 'doc-1', 'brown fox', undefined, undefined))
            .resolves.toMatchObject({ startIndex: 11, endIndex: 20 });

        // Markdown list marker stripped.
        fakeDocs = { documents: { get: async () => docWithText('Follow up on the table\n') } };
        await expect(GDocsHelpers.findTextRange(fakeDocs, 'doc-1', '- Follow up on the table', undefined, undefined))
            .resolves.toMatchObject({ startIndex: 1 });

        // Unicode-normalized (smart quotes / non-breaking space).
        fakeDocs = { documents: { get: async () => docWithText('It’s a plan\n') } };
        await expect(GDocsHelpers.findTextRange(fakeDocs, 'doc-1', "It's a plan", undefined, undefined))
            .resolves.toMatchObject({ startIndex: 1 });

        // Both combined.
        fakeDocs = { documents: { get: async () => docWithText('It’s a plan\n') } };
        await expect(GDocsHelpers.findTextRange(fakeDocs, 'doc-1', "1. It's a plan", undefined, undefined))
            .resolves.toMatchObject({ startIndex: 1 });
    });
});

describe('modifyText renders the divergence', () => {
    it('surfaces the structured failure instead of a bare "could not find"', async () => {
        const tools = new Map();
        registerModifyText({ addTool(tool) { tools.set(tool.name, tool); } });
        // Satisfy the legacy read guard so the failure under test is the search,
        // not the mutation guard in front of it.
        trackRead('doc-1', null, DOC_TEXT, 'rev-find-1');

        await expect(tools.get('modifyText').execute({
            documentId: 'doc-1',
            target: { textToFind: 'The quick brown cat jumps' },
            text: 'replacement',
        }, { log })).rejects.toThrow(/diverged at offset 16/);

        expect(batchUpdate).not.toHaveBeenCalled();
    });
});
