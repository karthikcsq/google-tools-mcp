// Issue #117: readDocument's markdown output silently showed a CORRECT-looking
// display text for a link whose actual target had drifted (a mistyped domain,
// or an autolink boundary landing mid-word after a live edit). Every readable
// surface — markdown, format='text', the doc itself — agreed with the wrong
// answer, so nothing about reading the document caught it.
//
// detectLinkMismatches (dist/markdown-transformer/docsToMarkdown.js) is the
// detector: it flags a link ONLY when its own display text independently
// looks like an email address or a URL, so an ordinary prose link ("click
// here", "our pricing page") is never flagged regardless of what it points to.
import { describe, expect, it } from '@jest/globals';
import { detectLinkMismatches } from '../dist/markdown-transformer/docsToMarkdown.js';

const run = (content, textStyle) => ({ textRun: { content, ...(textStyle ? { textStyle } : {}) } });
const linkRun = (content, url) => run(content, { link: { url } });
const para = (elements) => ({ paragraph: { elements } });

describe('detectLinkMismatches (#117)', () => {
    it('flags case 1 from the issue: a correct-looking email pointing at a typo domain', () => {
        const findings = detectLinkMismatches([
            para([
                run('Contact: '),
                linkRun('tyler@rolltackventures.com', 'mailto:tyler@rolltrackventures.com'),
                run('\n'),
            ]),
        ]);
        expect(findings).toHaveLength(1);
        expect(findings[0]).toEqual({
            displayText: 'tyler@rolltackventures.com',
            targetUrl: 'mailto:tyler@rolltrackventures.com',
            precedingWord: null,
        });
    });

    it('flags case 2 from the issue and names the boundary-break token', () => {
        const findings = detectLinkMismatches([
            para([
                run('Fortitude Fund Fred.'),
                linkRun('nash@yahoo.com', 'mailto:nash@yahoo.com'),
                run('\n'),
            ]),
        ]);
        expect(findings).toHaveLength(1);
        // The mailto target matches the display email exactly here — the bug
        // in case 2 is the DISPLAY TEXT itself losing "Fred." to the wrong
        // side of the link boundary, which the mailto-vs-display compare
        // alone cannot see. The boundary-break heuristic is what catches it.
        expect(findings[0].precedingWord).toBe('Fred.');
    });

    it('flags a mismatched mailto even when the display text is boundary-clean', () => {
        const findings = detectLinkMismatches([
            para([run('Email '), linkRun('me@example.com', 'mailto:someoneelse@example.com'), run(' now.\n')]),
        ]);
        expect(findings).toHaveLength(1);
        expect(findings[0].precedingWord).toBeNull();
    });

    it('does not flag a correctly matched mailto link', () => {
        const findings = detectLinkMismatches([
            para([linkRun('tyler@rolltackventures.com', 'mailto:tyler@rolltackventures.com'), run('\n')]),
        ]);
        expect(findings).toEqual([]);
    });

    it('does not flag a matched mailto link even with different case/whitespace', () => {
        const findings = detectLinkMismatches([
            para([linkRun('Tyler@RollTackVentures.com', 'mailto:tyler@rolltackventures.com'), run('\n')]),
        ]);
        expect(findings).toEqual([]);
    });

    it('never flags ordinary prose link text, no matter the target', () => {
        const findings = detectLinkMismatches([
            para([linkRun('click here', 'https://totally-unrelated.example/x'), run('\n')]),
            para([linkRun('our pricing page', 'https://example.com/pricing'), run('\n')]),
        ]);
        expect(findings).toEqual([]);
    });

    it('does not flag a bare-domain-looking word with no recognized TLD (e.g. "Node.js")', () => {
        const findings = detectLinkMismatches([
            para([linkRun('Node.js', 'https://nodejs.org/docs'), run('\n')]),
        ]);
        expect(findings).toEqual([]);
    });

    it('flags a mismatched bare domain (no scheme) with a recognized TLD', () => {
        const findings = detectLinkMismatches([
            para([linkRun('rolltackventures.com', 'https://rolltrackventures.com/'), run('\n')]),
        ]);
        expect(findings).toHaveLength(1);
        expect(findings[0].displayText).toBe('rolltackventures.com');
    });

    it('does not flag a matched URL that merely differs by scheme, www, or trailing slash', () => {
        const findings = detectLinkMismatches([
            para([linkRun('https://example.com', 'http://www.example.com/'), run('\n')]),
        ]);
        expect(findings).toEqual([]);
    });

    it('flags a genuinely mismatched scheme-qualified URL', () => {
        const findings = detectLinkMismatches([
            para([linkRun('https://example.com/pricing', 'https://example.com/checkout'), run('\n')]),
        ]);
        expect(findings).toHaveLength(1);
    });

    it('scans links inside table cells', () => {
        const findings = detectLinkMismatches([
            {
                table: {
                    tableRows: [{
                        tableCells: [{
                            content: [para([linkRun('a@b.com', 'mailto:c@d.com'), run('\n')])],
                        }],
                    }],
                },
            },
        ]);
        expect(findings).toHaveLength(1);
        expect(findings[0].displayText).toBe('a@b.com');
    });

    it('resets the preceding-word tracker at each new paragraph', () => {
        const findings = detectLinkMismatches([
            para([run('Prefix.')]),
            para([linkRun('a@b.com', 'mailto:c@d.com'), run('\n')]),
        ]);
        // "Prefix." lives in the PREVIOUS paragraph — it must not be reported
        // as touching this link, which starts its own paragraph clean.
        expect(findings[0].precedingWord).toBeNull();
    });

    it('returns no findings for a document with no links', () => {
        expect(detectLinkMismatches([para([run('Plain text, no links at all.\n')])])).toEqual([]);
    });

    it('handles missing/empty bodyContent without throwing', () => {
        expect(detectLinkMismatches(undefined)).toEqual([]);
        expect(detectLinkMismatches([])).toEqual([]);
    });
});
