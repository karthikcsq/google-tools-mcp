// Regression coverage for computeStructuralFingerprint's tab-scoped input
// shape (dist/handleRuntime.js). dist/tools/docs/readGoogleDoc.js mints a Docs
// read handle from a *body-only fragment* for a tab-scoped read --
// `{ body: targetTab.documentTab.body, lists: targetTab.documentTab.lists }`,
// with no `tabs` array at all -- and passes the request's `tabId` through as
// computeStructuralFingerprint's `tabId` option (see mintDocsReadHandle in
// dist/docsHandles.js). walkDocument (dist/docsStructure.js) treats "a tabId
// filter is set but the document has no `tabs` array" as "can never match"
// and returns zero nodes, which made every tab-scoped fingerprint the same
// degenerate `sha256-0-<hash of nothing>` constant regardless of the
// fragment's actual structure -- see docsStructure.test.js's
// "does not yield a tab filter match against a body-only document".
import { describe, expect, it } from '@jest/globals';
import { computeStructuralFingerprint } from '../dist/handleRuntime.js';

const DEGENERATE_PREFIX = 'sha256-0-';

function paragraphFragment(text) {
    return {
        body: {
            content: [
                {
                    startIndex: 1,
                    endIndex: text.length + 1,
                    paragraph: {
                        elements: [
                            { startIndex: 1, endIndex: text.length + 1, textRun: { content: text } },
                        ],
                    },
                },
            ],
        },
        lists: {},
    };
}

describe('computeStructuralFingerprint: tab-scoped body-only fragment', () => {
    it('is non-degenerate for a tab fragment (does not fall into the zero-node constant)', () => {
        const fingerprint = computeStructuralFingerprint(paragraphFragment('Hello world'), { tabId: 'tab-1' });
        expect(fingerprint.startsWith(DEGENERATE_PREFIX)).toBe(false);
        expect(fingerprint).toMatch(/^sha256-\d+-[0-9a-f]{64}$/);
        // Two nodes: one paragraph, one text run.
        expect(fingerprint.startsWith('sha256-2-')).toBe(true);
    });

    it('changes when the tab fragment\'s structure changes', () => {
        const original = paragraphFragment('Hello world');
        const withExtraParagraph = {
            body: {
                content: [
                    ...original.body.content,
                    {
                        startIndex: 20,
                        endIndex: 30,
                        paragraph: {
                            elements: [{ startIndex: 20, endIndex: 30, textRun: { content: 'A second line' } }],
                        },
                    },
                ],
            },
            lists: {},
        };

        const fingerprintBefore = computeStructuralFingerprint(original, { tabId: 'tab-1' });
        const fingerprintAfter = computeStructuralFingerprint(withExtraParagraph, { tabId: 'tab-1' });
        expect(fingerprintAfter).not.toBe(fingerprintBefore);
    });

    it('is stable for the same fragment structure', () => {
        const a = computeStructuralFingerprint(paragraphFragment('Same content'), { tabId: 'tab-1' });
        const b = computeStructuralFingerprint(paragraphFragment('Same content'), { tabId: 'tab-1' });
        expect(a).toBe(b);
    });

    it('is unaffected by which tabId is passed, since the fragment already IS that tab\'s content', () => {
        const fragment = paragraphFragment('Hello world');
        const withTab1 = computeStructuralFingerprint(fragment, { tabId: 'tab-1' });
        const withTab2 = computeStructuralFingerprint(fragment, { tabId: 'tab-2' });
        expect(withTab1).toBe(withTab2);
    });
});

describe('computeStructuralFingerprint: full tabbed document (unchanged behaviour)', () => {
    function tabbedDocument() {
        return {
            tabs: [
                {
                    tabProperties: { tabId: 'tab-1' },
                    documentTab: paragraphFragment('First tab content'),
                },
                {
                    tabProperties: { tabId: 'tab-2' },
                    documentTab: paragraphFragment('Second tab, different content entirely'),
                },
            ],
        };
    }

    it('still filters to only the requested tab', () => {
        const document = tabbedDocument();
        const fpTab1 = computeStructuralFingerprint(document, { tabId: 'tab-1' });
        const fpTab2 = computeStructuralFingerprint(document, { tabId: 'tab-2' });
        expect(fpTab1).not.toBe(fpTab2);
        expect(fpTab1.startsWith(DEGENERATE_PREFIX)).toBe(false);
        expect(fpTab2.startsWith(DEGENERATE_PREFIX)).toBe(false);
    });

    it('walks every tab when no tabId is given', () => {
        const document = tabbedDocument();
        const wholeDocument = computeStructuralFingerprint(document, {});
        const tab1Only = computeStructuralFingerprint(document, { tabId: 'tab-1' });
        expect(wholeDocument).not.toBe(tab1Only);
        expect(wholeDocument.startsWith(DEGENERATE_PREFIX)).toBe(false);
    });

    it('returns the zero-node fingerprint when the requested tabId matches nothing (unchanged corner case)', () => {
        const document = tabbedDocument();
        const fingerprint = computeStructuralFingerprint(document, { tabId: 'no-such-tab' });
        expect(fingerprint.startsWith(DEGENERATE_PREFIX)).toBe(true);
    });
});

describe('computeStructuralFingerprint: legacy body-only document, no tabId (unchanged behaviour)', () => {
    it('walks the whole body, matching a tab-scoped fragment fingerprint with the same content', () => {
        const legacyDocument = paragraphFragment('Legacy content');
        const legacyFingerprint = computeStructuralFingerprint(legacyDocument, {});
        const tabFragmentFingerprint = computeStructuralFingerprint(paragraphFragment('Legacy content'), { tabId: 'tab-1' });
        // A legacy read (no tabId) and a tab-scoped read of an equivalent
        // fragment (tabId set, but the input has no `tabs` array) both walk
        // the fragment unfiltered, so they agree.
        expect(legacyFingerprint).toBe(tabFragmentFingerprint);
    });

    it('produces the same fingerprint whether tabId is omitted or explicitly null', () => {
        const document = paragraphFragment('Hello world');
        expect(computeStructuralFingerprint(document)).toBe(computeStructuralFingerprint(document, { tabId: null }));
    });
});
