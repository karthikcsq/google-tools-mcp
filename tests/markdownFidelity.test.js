// Tests for checkMarkdownFidelity — the lossy-content detector used by
// readDocument to warn what replaceDocumentWithMarkdown will destroy.
//
// These tests pin the accuracy fixes from the PR #28 security review:
//   - warnings are derived from the exact body being replaced, so images or
//     footnotes in OTHER tabs are never reported;
//   - headers/footers (separate segments a body replacement never deletes) are
//     never reported;
//   - detection recurses into table cells.
import { describe, it, expect } from '@jest/globals';
import { checkMarkdownFidelity } from '../dist/markdown-transformer/docsToMarkdown.js';

// --- small builders --------------------------------------------------------
const para = (elements, paragraphStyle) => ({ paragraph: { elements, ...(paragraphStyle ? { paragraphStyle } : {}) } });
const textRun = (content, textStyle) => ({ textRun: { content, ...(textStyle ? { textStyle } : {}) } });
const redColor = { color: { rgbColor: { red: 1, green: 0, blue: 0 } } };
const black = { color: { rgbColor: {} } }; // all channels absent/0 → default, not custom

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

    it('reports custom foreground colors', () => {
        const body = [para([textRun('red text\n', { foregroundColor: redColor })])];
        expect(checkMarkdownFidelity(body)).toContain('Custom text/highlight colors — will be lost');
    });

    it('does NOT flag default/black color as custom', () => {
        const body = [para([textRun('normal\n', { foregroundColor: black })])];
        expect(checkMarkdownFidelity(body)).toEqual([]);
    });

    it('reports non-default paragraph alignment', () => {
        const body = [para([textRun('centered\n')], { alignment: 'CENTER' })];
        expect(checkMarkdownFidelity(body)).toContain('Non-default paragraph alignment (center/right/justified) — will be lost');
    });

    it('treats START / UNSPECIFIED alignment as default (no warning)', () => {
        const body = [
            para([textRun('a\n')], { alignment: 'START' }),
            para([textRun('b\n')], { alignment: 'UNSPECIFIED' }),
        ];
        expect(checkMarkdownFidelity(body)).toEqual([]);
    });

    it('recurses into table cells for colors and alignment', () => {
        const body = [
            {
                table: {
                    tableRows: [
                        {
                            tableCells: [
                                { content: [para([textRun('cell\n', { foregroundColor: redColor })], { alignment: 'RIGHT' })] },
                            ],
                        },
                    ],
                },
            },
        ];
        const w = checkMarkdownFidelity(body);
        expect(w).toContain('Custom text/highlight colors — will be lost');
        expect(w).toContain('Non-default paragraph alignment (center/right/justified) — will be lost');
    });

    it('finds images nested inside table cells', () => {
        const body = [
            {
                table: {
                    tableRows: [
                        { tableCells: [{ content: [para([{ inlineObjectElement: { inlineObjectId: 'io1' } }, textRun('\n')])] }] },
                    ],
                },
            },
        ];
        expect(checkMarkdownFidelity(body)).toContain('1 image(s) — will be removed');
    });

    // --- accuracy fixes from the security review ---------------------------

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
        // proving we no longer emit the inaccurate "headers will be removed".
        const cleanBody = [para([textRun('body only\n')])];
        expect(checkMarkdownFidelity(cleanBody)).toEqual([]);
    });
});
