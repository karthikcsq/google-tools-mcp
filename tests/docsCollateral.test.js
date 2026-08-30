// Fix 7: splitTextByRange (dist/docsCollateral.js) used to concatenate
// every preserved character with no separator. That makes the tail of the
// "before the deletion" text and the head of the "after the deletion" text
// read as literally adjacent, so a short quote that only exists by accident
// of that join (never actually contiguous anywhere in the real document)
// matches preserved.includes(quote), and the comment anchoring it is
// silently treated as "survives" (not reported at all: see
// classifyCommentAnchors's trailing comment, "A quote found only in the
// preserved region survives; not reported."). The fix joins non-adjacent
// preserved runs with a separator (a NUL character, which cannot appear in
// real document text) so an accidental cross-boundary match can no longer
// occur: the comment is reported (falls into `unknown`, since its quote
// text is nowhere genuinely contiguous) instead of silently dropped.
import { describe, it, expect } from '@jest/globals';
import { splitTextByRange, classifyCommentAnchors } from '../dist/docsCollateral.js';

// "CATEGORY": C(1) A(2) T(3) E(4) G(5) O(6) R(7) Y(8). Deleting [4,7)
// removes "EGO", leaving "CAT" (1-3) and "RY" (7-8) as the two preserved
// runs on either side of the cut.
const SEGMENTS = [{ start: 1, text: 'CATEGORY' }];

describe('splitTextByRange (#fix7)', () => {
    it('removed/preserved split the text at the deletion boundary', () => {
        const { removed, preserved } = splitTextByRange('CATEGORY', SEGMENTS, 4, 7);
        expect(removed).toBe('EGO');
        // The two preserved runs are joined with a separator rather than
        // concatenated directly, so "CAT" and "RY" are not read as adjacent.
        expect(preserved).toBe('CAT' + String.fromCharCode(0) + 'RY');
        expect(preserved).not.toBe('CATRY');
    });

    it('a quote that only exists by accident of the old no-separator join no longer matches', () => {
        const { preserved } = splitTextByRange('CATEGORY', SEGMENTS, 4, 7);
        // "TR" is the last char of the "before" run immediately followed by
        // the first char of the "after" run: exactly the shape of a quote
        // that would have falsely matched under plain concatenation
        // ("CATRY".includes("TR") === true) but is not, and never was,
        // genuinely contiguous in the document.
        expect(preserved.includes('TR')).toBe(false);
        // A real, honestly-contiguous preserved substring still matches.
        expect(preserved.includes('CAT')).toBe(true);
        expect(preserved.includes('RY')).toBe(true);
    });

    it('a quote straddling the cut is reported (not silently dropped as "survives")', () => {
        const { removed, preserved } = splitTextByRange('CATEGORY', SEGMENTS, 4, 7);
        const comments = [{ id: 'c1', author: { displayName: 'Alice' }, resolved: false, quotedFileContent: { value: 'TR' } }];
        const { affected, maybe, unknown } = classifyCommentAnchors(comments, { removed, preserved });

        // Under the old no-separator join this comment matched `preserved`
        // and classifyCommentAnchors's final "found only in preserved:
        // survives" branch meant it was pushed into NONE of the three
        // buckets: silently dropped, invisible to every caller. With the
        // separator it is neither in `removed` nor genuinely contiguous in
        // `preserved`, so it lands in `unknown`: reported, not dropped.
        expect(affected).toHaveLength(0);
        expect(maybe).toHaveLength(0);
        expect(unknown).toHaveLength(1);
        expect(unknown[0].id).toBe('c1');
    });

    it('a quote genuinely still present in the preserved text is not misreported', () => {
        const { removed, preserved } = splitTextByRange('CATEGORY', SEGMENTS, 4, 7);
        const comments = [{ id: 'c2', author: { displayName: 'Bob' }, resolved: false, quotedFileContent: { value: 'CAT' } }];
        const { affected, maybe, unknown } = classifyCommentAnchors(comments, { removed, preserved });

        expect(affected).toHaveLength(0);
        expect(maybe).toHaveLength(0);
        expect(unknown).toHaveLength(0);
    });

    it('a quote fully inside the removed region is reported as affected', () => {
        const { removed, preserved } = splitTextByRange('CATEGORY', SEGMENTS, 4, 7);
        const comments = [{ id: 'c3', author: { displayName: 'Carol' }, resolved: false, quotedFileContent: { value: 'EGO' } }];
        const { affected } = classifyCommentAnchors(comments, { removed, preserved });

        expect(affected).toHaveLength(1);
        expect(affected[0].id).toBe('c3');
    });
});
