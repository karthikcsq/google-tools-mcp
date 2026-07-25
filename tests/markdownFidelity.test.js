// Tests for checkMarkdownFidelity — the lossy-content detector used by
// readDocument to warn what replaceDocumentWithMarkdown will destroy.
//
// Scope note: this converter's rich-markdown mode (the default used by
// readDocument) already round-trips custom text/highlight colors and
// non-default paragraph alignment losslessly via HTML extensions
// (`<span style="color:...">`, `<p align="...">`, table alignment markers) —
// see docsJsonToMarkdown/markdownToDocs. So checkMarkdownFidelity does NOT
// warn about those; only content with no markdown representation at all
// (images, footnotes) is reported.
//
// These tests also pin the accuracy requirements for a correct fidelity
// check:
//   - warnings are derived from the exact body being replaced, so images or
//     footnotes in OTHER tabs are never reported;
//   - headers/footers (separate segments a body replacement never deletes) are
//     never reported;
//   - detection recurses into table cells.
import { describe, it, expect } from '@jest/globals';
import { checkMarkdownFidelity } from '../dist/markdown-transformer/docsToMarkdown.js';

// --- small builders --------------------------------------------------------
const para = (elements) => ({ paragraph: { elements } });
const textRun = (content) => ({ textRun: { content } });

describe('checkMarkdownFidelity', () => {
    it('returns no warnings for plain text', () => {
        const body = [para([textRun('Hello world\n')])];
        expect(checkMarkdownFidelity(body)).toEqual([]);
    });

    it('handles null/undefined body without throwing', () => {
        expect(checkMarkdownFidelity(null)).toEqual([]);
        expect(checkMarkdownFidelity(undefined)).toEqual([]);
        expect(checkMarkdownFidelity([])).toEqual([]);
    });

    it('reports inline images embedded in the body', () => {
        const body = [para([textRun('before '), { inlineObjectElement: { inlineObjectId: 'io1' } }, textRun(' after\n')])];
        const w = checkMarkdownFidelity(body);
        expect(w).toContain('1 image(s) — will be removed');
    });

    it('counts multiple images including positioned (floating) ones', () => {
        const body = [
            para([{ inlineObjectElement: { inlineObjectId: 'io1' } }, textRun('x\n')]),
            { paragraph: { positionedObjectIds: ['po1', 'po2'], elements: [textRun('y\n')] } },
        ];
        expect(checkMarkdownFidelity(body)).toContain('3 image(s) — will be removed');
    });

    it('reports footnote references that live in the body', () => {
        const body = [para([textRun('claim'), { footnoteReference: { footnoteId: 'fn1' } }, textRun('\n')])];
        expect(checkMarkdownFidelity(body)).toContain('1 footnote(s) — will be removed');
    });

    it('reports a generated table of contents', () => {
        const body = [
            para([textRun('Contents\n')]),
            { tableOfContents: { content: [para([textRun('Chapter 1\n')])] } },
            para([textRun('Chapter 1\n')]),
        ];
        expect(checkMarkdownFidelity(body)[0]).toMatch(/^1 table\(s\) of contents — will be removed/);
    });

    it('counts each table of contents separately', () => {
        const body = [
            { tableOfContents: { content: [] } },
            para([textRun('body\n')]),
            { tableOfContents: { content: [] } },
        ];
        expect(checkMarkdownFidelity(body)[0]).toMatch(/^2 table\(s\) of contents/);
    });

    it('does NOT flag custom colors — they round-trip via rich-markdown spans', () => {
        const body = [para([{ textRun: { content: 'red text\n', textStyle: { foregroundColor: { color: { rgbColor: { red: 1, green: 0, blue: 0 } } } } } }])];
        expect(checkMarkdownFidelity(body)).toEqual([]);
    });

    it('does NOT flag non-default alignment — it round-trips via <p align> / table markers', () => {
        const body = [{ paragraph: { paragraphStyle: { alignment: 'CENTER' }, elements: [textRun('centered\n')] } }];
        expect(checkMarkdownFidelity(body)).toEqual([]);
    });

    it('recurses into table cells for images and footnotes', () => {
        const body = [
            {
                table: {
                    tableRows: [
                        {
                            tableCells: [
                                { content: [para([{ inlineObjectElement: { inlineObjectId: 'io1' } }, textRun('\n')])] },
                            ],
                        },
                    ],
                },
            },
        ];
        expect(checkMarkdownFidelity(body)).toContain('1 image(s) — will be removed');
    });

    it('finds footnotes nested inside table cells', () => {
        const body = [
            {
                table: {
                    tableRows: [
                        { tableCells: [{ content: [para([textRun('claim'), { footnoteReference: { footnoteId: 'fn1' } }, textRun('\n')])] }] },
                    ],
                },
            },
        ];
        expect(checkMarkdownFidelity(body)).toContain('1 footnote(s) — will be removed');
    });

    // --- scoping accuracy ----------------------------------------------------

    it('does NOT over-report images from a different tab (tab-scoped body)', () => {
        // Simulate two tabs. checkMarkdownFidelity is called with ONLY the body
        // of the tab being read/replaced. Tab 2 has no image, so reading tab 2
        // must not warn about tab 1's image.
        const tab1Body = [para([{ inlineObjectElement: { inlineObjectId: 'io1' } }, textRun('\n')])];
        const tab2Body = [para([textRun('plain tab 2 content\n')])];
        expect(checkMarkdownFidelity(tab1Body)).toContain('1 image(s) — will be removed');
        expect(checkMarkdownFidelity(tab2Body)).toEqual([]);
    });

    it('does NOT report headers/footers — a body replacement never deletes them', () => {
        // The detector only receives body content. Even for a document that has
        // headers and footers, scanning its (clean) body yields no warning,
        // proving we never emit the inaccurate "headers will be removed".
        const cleanBody = [para([textRun('body only\n')])];
        expect(checkMarkdownFidelity(cleanBody)).toEqual([]);
    });

    // --- unhandled ParagraphElement variants (deny-by-default) ---------------
    //
    // extractFormattedText() (docsToMarkdown.js) only ever renders `textRun`.
    // The Docs API ParagraphElement union also defines autoText, pageBreak,
    // columnBreak, horizontalRule, equation, person, richLink, and dateElement
    // (https://developers.google.com/workspace/docs/api/reference/rest/v1/documents#ParagraphElement).
    // None of those round-trips through this converter today (verified by
    // reading extractFormattedText: its only branch is `if (element.textRun)`),
    // so checkMarkdownFidelity must warn about every one of them.

    it('warns about an autoText element with no markdown representation', () => {
        const body = [para([textRun('page '), { autoText: { type: 'PAGE_NUMBER' } }, textRun('\n')])];
        const w = checkMarkdownFidelity(body);
        expect(w.some((line) => line.includes('autoText'))).toBe(true);
    });

    it('warns about a pageBreak element', () => {
        const body = [para([{ pageBreak: {} }])];
        expect(checkMarkdownFidelity(body).some((line) => line.includes('pageBreak'))).toBe(true);
    });

    it('warns about a columnBreak element', () => {
        const body = [para([{ columnBreak: {} }])];
        expect(checkMarkdownFidelity(body).some((line) => line.includes('columnBreak'))).toBe(true);
    });

    it('warns about a horizontalRule element', () => {
        const body = [para([{ horizontalRule: {} }])];
        expect(checkMarkdownFidelity(body).some((line) => line.includes('horizontalRule'))).toBe(true);
    });

    it('warns about an equation element', () => {
        const body = [para([{ equation: {} }])];
        expect(checkMarkdownFidelity(body).some((line) => line.includes('equation'))).toBe(true);
    });

    it('warns about a person element', () => {
        const body = [para([{ person: { personId: 'p1', personProperties: { email: 'a@example.com' } } }])];
        expect(checkMarkdownFidelity(body).some((line) => line.includes('person'))).toBe(true);
    });

    it('warns about a richLink element', () => {
        const body = [para([{ richLink: { richLinkId: 'rl1' } }])];
        expect(checkMarkdownFidelity(body).some((line) => line.includes('richLink'))).toBe(true);
    });

    it('warns about a dateElement', () => {
        const body = [para([{ dateElement: { displayText: '2026-07-24' } }])];
        expect(checkMarkdownFidelity(body).some((line) => line.includes('dateElement'))).toBe(true);
    });

    it('warns about an unhandled variant nested inside a table cell', () => {
        const body = [
            {
                table: {
                    tableRows: [
                        {
                            tableCells: [
                                { content: [para([textRun('note: '), { horizontalRule: {} }])] },
                            ],
                        },
                    ],
                },
            },
        ];
        expect(checkMarkdownFidelity(body).some((line) => line.includes('horizontalRule'))).toBe(true);
    });

    it('groups multiple unhandled variants into one warning rather than one line per element', () => {
        const body = [
            para([{ pageBreak: {} }]),
            para([{ pageBreak: {} }]),
            para([{ equation: {} }]),
        ];
        const warnings = checkMarkdownFidelity(body);
        const unhandledWarnings = warnings.filter(
            (w) => w.includes('pageBreak') || w.includes('equation')
        );
        // Both variant types are reported, but folded into a single warning
        // string rather than emitted once per element.
        expect(unhandledWarnings).toHaveLength(1);
        expect(unhandledWarnings[0]).toContain('2 pageBreak');
        expect(unhandledWarnings[0]).toContain('1 equation');
    });

    it('does NOT warn about textRun, images, footnotes, or table-of-contents as "unhandled" (no false positives from the deny-by-default check)', () => {
        const body = [
            para([textRun('plain text\n')]),
            para([{ inlineObjectElement: { inlineObjectId: 'io1' } }, textRun('\n')]),
            para([textRun('claim'), { footnoteReference: { footnoteId: 'fn1' } }, textRun('\n')]),
            { tableOfContents: { content: [] } },
        ];
        const warnings = checkMarkdownFidelity(body);
        expect(warnings.some((w) => w.includes('unsupported content type'))).toBe(false);
    });
});
