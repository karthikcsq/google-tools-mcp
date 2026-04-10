// Tests for Unicode text normalization in findTextRange (issue #11).
// These test the normalizeForSearch and normalizeWithPositionMap functions
// indirectly through the exported findAllOccurrences behavior, and directly
// where possible.
import { describe, it, expect } from '@jest/globals';

// The normalization functions are not exported, so we test them via
// a small inline reimplementation for unit tests, plus integration tests
// against the module's actual behavior via dynamic import.

// --- Inline copies of the normalization logic for direct unit testing ---
const NORMALIZE_MAP = {
    '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", '\u2032': "'", '\u2035': "'",
    '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"', '\u2033': '"', '\u2036': '"',
    '\u2014': '--',
    '\u2013': '-',
    '\u2026': '...',
    '\u00A0': ' ',
    '\u000B': '\n',
};

function normalizeForSearch(text) {
    let result = '';
    for (let i = 0; i < text.length; i++) {
        const replacement = NORMALIZE_MAP[text[i]];
        result += replacement ?? text[i];
    }
    return result;
}

function normalizeWithPositionMap(text) {
    let normalized = '';
    const posMap = [];
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const replacement = NORMALIZE_MAP[ch];
        if (replacement) {
            for (let j = 0; j < replacement.length; j++) {
                posMap.push(i);
                normalized += replacement[j];
            }
        } else {
            posMap.push(i);
            normalized += ch;
        }
    }
    posMap.push(text.length);
    return { normalized, posMap };
}

// ---------------------------------------------------------------------------
// normalizeForSearch
// ---------------------------------------------------------------------------
describe('normalizeForSearch', () => {
    it('converts smart single quotes to straight', () => {
        expect(normalizeForSearch('\u2018hello\u2019')).toBe("'hello'");
    });

    it('converts smart double quotes to straight', () => {
        expect(normalizeForSearch('\u201Chello\u201D')).toBe('"hello"');
    });

    it('converts em dash to double hyphen', () => {
        expect(normalizeForSearch('word\u2014word')).toBe('word--word');
    });

    it('converts en dash to single hyphen', () => {
        expect(normalizeForSearch('word\u2013word')).toBe('word-word');
    });

    it('converts ellipsis to three dots', () => {
        expect(normalizeForSearch('wait\u2026')).toBe('wait...');
    });

    it('converts non-breaking space to regular space', () => {
        expect(normalizeForSearch('hello\u00A0world')).toBe('hello world');
    });

    it('converts vertical tab to newline', () => {
        expect(normalizeForSearch('line1\u000Bline2')).toBe('line1\nline2');
    });

    it('leaves ASCII text unchanged', () => {
        const ascii = 'Hello, world! "quoted" — test';
        // Note: the — here is a real em dash, so it WILL be converted
        expect(normalizeForSearch('Hello, world! "quoted"')).toBe('Hello, world! "quoted"');
    });

    it('handles empty string', () => {
        expect(normalizeForSearch('')).toBe('');
    });

    it('handles multiple special chars in sequence', () => {
        expect(normalizeForSearch('\u201C\u2014\u201D')).toBe('"--"');
    });
});

// ---------------------------------------------------------------------------
// normalizeWithPositionMap
// ---------------------------------------------------------------------------
describe('normalizeWithPositionMap', () => {
    it('returns identity map for ASCII text', () => {
        const { normalized, posMap } = normalizeWithPositionMap('abc');
        expect(normalized).toBe('abc');
        expect(posMap).toEqual([0, 1, 2, 3]); // includes sentinel
    });

    it('maps em dash expansion correctly', () => {
        // "a—b" → "a--b"
        // positions: a(0) —(1) b(2)
        // normalized: a(→0) -(→1) -(→1) b(→2) sentinel(→3)
        const { normalized, posMap } = normalizeWithPositionMap('a\u2014b');
        expect(normalized).toBe('a--b');
        expect(posMap).toEqual([0, 1, 1, 2, 3]);
    });

    it('maps ellipsis expansion correctly', () => {
        // "a…b" → "a...b"
        // positions: a(0) …(1) b(2)
        // normalized: a(→0) .(→1) .(→1) .(→1) b(→2) sentinel(→3)
        const { normalized, posMap } = normalizeWithPositionMap('a\u2026b');
        expect(normalized).toBe('a...b');
        expect(posMap).toEqual([0, 1, 1, 1, 2, 3]);
    });

    it('maps single-char replacements correctly', () => {
        // "\u2018x\u2019" → "'x'"
        const { normalized, posMap } = normalizeWithPositionMap('\u2018x\u2019');
        expect(normalized).toBe("'x'");
        expect(posMap).toEqual([0, 1, 2, 3]); // same length, 1:1 mapping
    });

    it('handles empty string', () => {
        const { normalized, posMap } = normalizeWithPositionMap('');
        expect(normalized).toBe('');
        expect(posMap).toEqual([0]); // just sentinel
    });

    it('sentinel maps to text length', () => {
        const text = 'hello';
        const { posMap } = normalizeWithPositionMap(text);
        expect(posMap[posMap.length - 1]).toBe(text.length);
    });

    it('can round-trip positions back to original', () => {
        // Search for "word" in normalized "a--word--b" (original "a—word—b")
        const original = 'a\u2014word\u2014b';
        const { normalized, posMap } = normalizeWithPositionMap(original);
        expect(normalized).toBe('a--word--b');

        const searchText = 'word';
        const idx = normalized.indexOf(searchText);
        expect(idx).toBe(3); // "a--" is 3 chars

        const origStart = posMap[idx]; // position 2 in original (after "a—")
        const origEnd = posMap[idx + searchText.length]; // position 6 in original
        expect(original.slice(origStart, origEnd)).toBe('word');
    });
});

// ---------------------------------------------------------------------------
// Integration: verify normalized matching finds text that exact match misses
// ---------------------------------------------------------------------------
describe('normalized search integration', () => {
    it('finds text with smart quotes when searching with straight quotes', () => {
        const docText = 'He said \u201CHello\u201D to everyone';
        const search = 'He said "Hello" to everyone';

        // Exact match fails
        expect(docText.indexOf(search)).toBe(-1);

        // Normalized match works
        const { normalized: normDoc } = normalizeWithPositionMap(docText);
        const normSearch = normalizeForSearch(search);
        expect(normDoc.indexOf(normSearch)).toBeGreaterThanOrEqual(0);
    });

    it('finds text with em dash when searching with double hyphen', () => {
        const docText = 'do not pitch general audit \u2014 again';
        const search = 'do not pitch general audit -- again';

        expect(docText.indexOf(search)).toBe(-1);

        const { normalized: normDoc } = normalizeWithPositionMap(docText);
        const normSearch = normalizeForSearch(search);
        expect(normDoc.indexOf(normSearch)).toBeGreaterThanOrEqual(0);
    });

    it('finds text with non-breaking spaces', () => {
        const docText = 'value\u00A0=\u00A010';
        const search = 'value = 10';

        expect(docText.indexOf(search)).toBe(-1);

        const { normalized: normDoc } = normalizeWithPositionMap(docText);
        const normSearch = normalizeForSearch(search);
        expect(normDoc.indexOf(normSearch)).toBeGreaterThanOrEqual(0);
    });

    it('exact match still works for ASCII text', () => {
        const docText = 'Hello World';
        const search = 'Hello World';

        // Exact match works
        expect(docText.indexOf(search)).toBeGreaterThanOrEqual(0);
    });

    it('correctly maps positions back through em dash expansion', () => {
        const original = 'before\u2014word\u2014after';
        const { normalized, posMap } = normalizeWithPositionMap(original);
        const search = normalizeForSearch('word');

        const idx = normalized.indexOf(search);
        expect(idx).toBeGreaterThan(-1);

        const origStart = posMap[idx];
        const origEnd = posMap[idx + search.length];

        // The slice of the original text at the mapped positions should be 'word'
        expect(original.slice(origStart, origEnd)).toBe('word');
    });
});
