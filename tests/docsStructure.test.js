import { describe, expect, it } from '@jest/globals';
import { NODE_KINDS, collectText, walkDocument } from '../dist/docsStructure.js';

function kinds(nodes) {
    return nodes.map((n) => n.kind);
}

describe('walkDocument: legacy body-only document', () => {
    it('walks paragraphs and text runs with null tabId', () => {
        const document = {
            body: {
                content: [
                    {
                        startIndex: 1,
                        endIndex: 6,
                        paragraph: {
                            elements: [
                                { startIndex: 1, endIndex: 6, textRun: { content: 'Hello' } },
                            ],
                        },
                    },
                ],
            },
        };

        const nodes = [...walkDocument(document)];
        expect(kinds(nodes)).toEqual([NODE_KINDS.PARAGRAPH, NODE_KINDS.TEXT_RUN]);
        expect(nodes[0]).toMatchObject({ startIndex: 1, endIndex: 6, tabId: null, depth: 0 });
        expect(nodes[1]).toMatchObject({ startIndex: 1, endIndex: 6, tabId: null, depth: 1 });
        expect(nodes[1].node).toBe(document.body.content[0].paragraph.elements[0].textRun);
        expect(collectText(document)).toBe('Hello');
    });

    it('returns no nodes for an empty document', () => {
        expect([...walkDocument({ body: { content: [] } })]).toEqual([]);
        expect([...walkDocument({})]).toEqual([]);
        expect(collectText({ body: { content: [] } })).toBe('');
    });

    it('does not yield a tab filter match against a body-only document', () => {
        const document = { body: { content: [{ startIndex: 1, endIndex: 2, paragraph: { elements: [] } }] } };
        expect([...walkDocument(document, { tabId: 'anything' })]).toEqual([]);
    });
});

describe('walkDocument: tables', () => {
    it('walks rows, cells (with indices), and nested structural elements inside cells', () => {
        const cellParagraph = {
            startIndex: 20,
            endIndex: 25,
            paragraph: { elements: [{ startIndex: 20, endIndex: 25, textRun: { content: 'cell' } }] },
        };
        const document = {
            body: {
                content: [
                    {
                        startIndex: 1,
                        endIndex: 30,
                        table: {
                            tableRows: [
                                {
                                    tableCells: [
                                        { startIndex: 5, endIndex: 26, content: [cellParagraph] },
                                    ],
                                },
                            ],
                        },
                    },
                ],
            },
        };

        const nodes = [...walkDocument(document)];
        expect(kinds(nodes)).toEqual([
            NODE_KINDS.TABLE,
            NODE_KINDS.TABLE_ROW,
            NODE_KINDS.TABLE_CELL,
            NODE_KINDS.PARAGRAPH,
            NODE_KINDS.TEXT_RUN,
        ]);

        const [table, row, cell, paragraph, textRun] = nodes;
        expect(table).toMatchObject({ startIndex: 1, endIndex: 30, depth: 0, tabId: null });
        expect(row).toMatchObject({ depth: 1, rowIndex: 0, startIndex: undefined, endIndex: undefined });
        expect(cell).toMatchObject({ depth: 2, rowIndex: 0, columnIndex: 0, startIndex: 5, endIndex: 26 });
        expect(paragraph).toMatchObject({ depth: 3, startIndex: 20, endIndex: 25 });
        expect(textRun).toMatchObject({ depth: 4, startIndex: 20, endIndex: 25 });
        expect(textRun.node.content).toBe('cell');
        expect(collectText(document)).toBe('cell');
    });

    it('walks multiple rows and columns in row-major, column-major order', () => {
        function makeCell(label) {
            return { startIndex: 0, endIndex: 1, content: [] , label };
        }
        const document = {
            body: {
                content: [
                    {
                        startIndex: 1,
                        endIndex: 2,
                        table: {
                            tableRows: [
                                { tableCells: [makeCell('r0c0'), makeCell('r0c1')] },
                                { tableCells: [makeCell('r1c0'), makeCell('r1c1')] },
                            ],
                        },
                    },
                ],
            },
        };

        const cells = [...walkDocument(document)].filter((n) => n.kind === NODE_KINDS.TABLE_CELL);
        expect(cells.map((c) => c.node.label)).toEqual(['r0c0', 'r0c1', 'r1c0', 'r1c1']);
        expect(cells.map((c) => [c.rowIndex, c.columnIndex])).toEqual([[0, 0], [0, 1], [1, 0], [1, 1]]);
    });
});

describe('walkDocument: sectionBreak and tableOfContents', () => {
    it('yields a sectionBreak leaf with no descendants', () => {
        const document = {
            body: { content: [{ startIndex: 1, endIndex: 2, sectionBreak: {} }] },
        };
        const nodes = [...walkDocument(document)];
        expect(kinds(nodes)).toEqual([NODE_KINDS.SECTION_BREAK]);
        expect(nodes[0]).toMatchObject({ startIndex: 1, endIndex: 2, depth: 0 });
    });

    it('recurses into tableOfContents content', () => {
        const document = {
            body: {
                content: [
                    {
                        startIndex: 1,
                        endIndex: 10,
                        tableOfContents: {
                            content: [
                                {
                                    startIndex: 2,
                                    endIndex: 9,
                                    paragraph: { elements: [{ startIndex: 2, endIndex: 9, textRun: { content: 'TOC entry' } }] },
                                },
                            ],
                        },
                    },
                ],
            },
        };
        const nodes = [...walkDocument(document)];
        expect(kinds(nodes)).toEqual([
            NODE_KINDS.TABLE_OF_CONTENTS,
            NODE_KINDS.PARAGRAPH,
            NODE_KINDS.TEXT_RUN,
        ]);
        expect(nodes[0]).toMatchObject({ depth: 0, startIndex: 1, endIndex: 10 });
        expect(nodes[1]).toMatchObject({ depth: 1 });
        expect(collectText(document)).toBe('TOC entry');
    });
});

describe('walkDocument: paragraph elements other than textRun', () => {
    it('yields a generic paragraphElement node carrying its elementType', () => {
        const document = {
            body: {
                content: [
                    {
                        startIndex: 1,
                        endIndex: 3,
                        paragraph: {
                            elements: [
                                { startIndex: 1, endIndex: 2, pageBreak: {} },
                                { startIndex: 2, endIndex: 3, textRun: { content: 'x' } },
                            ],
                        },
                    },
                ],
            },
        };
        const nodes = [...walkDocument(document)];
        expect(kinds(nodes)).toEqual([NODE_KINDS.PARAGRAPH, NODE_KINDS.PARAGRAPH_ELEMENT, NODE_KINDS.TEXT_RUN]);
        expect(nodes[1]).toMatchObject({ elementType: 'pageBreak', startIndex: 1, endIndex: 2, depth: 1 });
    });
});

describe('walkDocument: tabs', () => {
    function tab(tabId, { title = tabId, content = [], childTabs = [], parentTabId } = {}) {
        return {
            tabProperties: { tabId, title, ...(parentTabId ? { parentTabId } : {}) },
            documentTab: { body: { content } },
            childTabs,
        };
    }

    function textParagraph(text, start = 1, end = start + text.length) {
        return {
            startIndex: start,
            endIndex: end,
            paragraph: { elements: [{ startIndex: start, endIndex: end, textRun: { content: text } }] },
        };
    }

    it('walks multiple top-level tabs, propagating tabId and resetting content depth per tab', () => {
        const document = {
            tabs: [
                tab('tab-a', { content: [textParagraph('A')] }),
                tab('tab-b', { content: [textParagraph('B')] }),
            ],
        };
        const nodes = [...walkDocument(document)];
        expect(kinds(nodes)).toEqual([
            NODE_KINDS.TAB, NODE_KINDS.PARAGRAPH, NODE_KINDS.TEXT_RUN,
            NODE_KINDS.TAB, NODE_KINDS.PARAGRAPH, NODE_KINDS.TEXT_RUN,
        ]);
        expect(nodes[0]).toMatchObject({ tabId: 'tab-a', depth: 0 });
        expect(nodes[1]).toMatchObject({ tabId: 'tab-a', depth: 0 });
        expect(nodes[2]).toMatchObject({ tabId: 'tab-a', depth: 1 });
        expect(nodes[3]).toMatchObject({ tabId: 'tab-b', depth: 0 });
        expect(collectText(document)).toBe('AB');
    });

    it('walks nested child tabs in document order with increasing tab depth', () => {
        const document = {
            tabs: [
                tab('parent', {
                    content: [textParagraph('P')],
                    childTabs: [
                        tab('child', { content: [textParagraph('C')], parentTabId: 'parent' }),
                    ],
                }),
            ],
        };
        const nodes = [...walkDocument(document)];
        expect(kinds(nodes)).toEqual([
            NODE_KINDS.TAB, NODE_KINDS.PARAGRAPH, NODE_KINDS.TEXT_RUN,
            NODE_KINDS.TAB, NODE_KINDS.PARAGRAPH, NODE_KINDS.TEXT_RUN,
        ]);
        const tabNodes = nodes.filter((n) => n.kind === NODE_KINDS.TAB);
        expect(tabNodes[0]).toMatchObject({ tabId: 'parent', depth: 0 });
        expect(tabNodes[1]).toMatchObject({ tabId: 'child', depth: 1 });
        const childTextRun = nodes.find((n) => n.tabId === 'child' && n.kind === NODE_KINDS.TEXT_RUN);
        expect(childTextRun.depth).toBe(1); // content depth resets within each tab's own body
        expect(collectText(document)).toBe('PC');
    });

    it('handles a tab with no documentTab body without throwing', () => {
        const document = { tabs: [{ tabProperties: { tabId: 'empty-tab' }, childTabs: [] }] };
        const nodes = [...walkDocument(document)];
        expect(kinds(nodes)).toEqual([NODE_KINDS.TAB]);
        expect(nodes[0]).toMatchObject({ tabId: 'empty-tab' });
    });

    it('filters to a single tabId, still discovering a matching nested child tab, without yielding sibling content', () => {
        const document = {
            tabs: [
                tab('tab-a', { content: [textParagraph('A')] }),
                tab('tab-b', {
                    content: [textParagraph('B')],
                    childTabs: [tab('tab-b-child', { content: [textParagraph('BC')], parentTabId: 'tab-b' })],
                }),
            ],
        };
        const nodes = [...walkDocument(document, { tabId: 'tab-b-child' })];
        expect(kinds(nodes)).toEqual([NODE_KINDS.TAB, NODE_KINDS.PARAGRAPH, NODE_KINDS.TEXT_RUN]);
        expect(nodes.every((n) => n.tabId === 'tab-b-child')).toBe(true);
        expect(collectText(document, { tabId: 'tab-b-child' })).toBe('BC');
    });

    it('omits tab nodes when includeTabNodes is false', () => {
        const document = { tabs: [tab('only', { content: [textParagraph('X')] })] };
        const nodes = [...walkDocument(document, { includeTabNodes: false })];
        expect(kinds(nodes)).toEqual([NODE_KINDS.PARAGRAPH, NODE_KINDS.TEXT_RUN]);
    });
});

describe('walkDocument: raw node references', () => {
    it('yields the exact raw object references for tab, table, and paragraph nodes', () => {
        const paragraphElement = { startIndex: 1, endIndex: 2, paragraph: { elements: [] } };
        const tableElement = {
            startIndex: 2,
            endIndex: 3,
            table: { tableRows: [{ tableCells: [{ startIndex: 2, endIndex: 3, content: [] }] }] },
        };
        const document = { body: { content: [paragraphElement, tableElement] } };
        const nodes = [...walkDocument(document)];
        const paragraphNode = nodes.find((n) => n.kind === NODE_KINDS.PARAGRAPH);
        const tableNode = nodes.find((n) => n.kind === NODE_KINDS.TABLE);
        const cellNode = nodes.find((n) => n.kind === NODE_KINDS.TABLE_CELL);
        expect(paragraphNode.node).toBe(paragraphElement);
        expect(tableNode.node).toBe(tableElement);
        expect(cellNode.node).toBe(tableElement.table.tableRows[0].tableCells[0]);
    });

    it('skips unrecognized structural element shapes without throwing', () => {
        const document = { body: { content: [{ startIndex: 1, endIndex: 2, futureFeature: {} }] } };
        expect(() => [...walkDocument(document)]).not.toThrow();
        expect([...walkDocument(document)]).toEqual([]);
    });
});
