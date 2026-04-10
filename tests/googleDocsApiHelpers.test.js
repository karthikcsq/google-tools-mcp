// Tests for pure/sync functions exported from dist/googleDocsApiHelpers.js
import { describe, it, expect } from '@jest/globals';
import {
    findTabById,
    getAllTabs,
    getTabTextLength,
    buildUpdateTextStyleRequest,
    buildUpdateParagraphStyleRequest,
} from '../dist/googleDocsApiHelpers.js';

// ---------------------------------------------------------------------------
// findTabById
// ---------------------------------------------------------------------------
describe('findTabById', () => {
    const docWithTabs = {
        tabs: [
            {
                tabProperties: { tabId: 'tab-1', title: 'Tab One' },
                documentTab: { body: { content: [] } },
                childTabs: [
                    {
                        tabProperties: { tabId: 'tab-1a', title: 'Child Tab' },
                        documentTab: { body: { content: [] } },
                        childTabs: [],
                    },
                ],
            },
            {
                tabProperties: { tabId: 'tab-2', title: 'Tab Two' },
                documentTab: { body: { content: [] } },
                childTabs: [],
            },
        ],
    };

    it('finds top-level tab by ID', () => {
        const tab = findTabById(docWithTabs, 'tab-1');
        expect(tab).not.toBeNull();
        expect(tab.tabProperties.title).toBe('Tab One');
    });

    it('finds nested child tab by ID', () => {
        const tab = findTabById(docWithTabs, 'tab-1a');
        expect(tab).not.toBeNull();
        expect(tab.tabProperties.title).toBe('Child Tab');
    });

    it('returns null for non-existent tab ID', () => {
        expect(findTabById(docWithTabs, 'non-existent')).toBeNull();
    });

    it('returns null when doc has no tabs', () => {
        expect(findTabById({}, 'tab-1')).toBeNull();
        expect(findTabById({ tabs: [] }, 'tab-1')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// getAllTabs
// ---------------------------------------------------------------------------
describe('getAllTabs', () => {
    it('returns flat list of all tabs with level info', () => {
        const doc = {
            tabs: [
                {
                    tabProperties: { tabId: 'a' },
                    childTabs: [
                        {
                            tabProperties: { tabId: 'a1' },
                            childTabs: [
                                {
                                    tabProperties: { tabId: 'a1i' },
                                    childTabs: [],
                                },
                            ],
                        },
                    ],
                },
                {
                    tabProperties: { tabId: 'b' },
                    childTabs: [],
                },
            ],
        };
        const allTabs = getAllTabs(doc);
        expect(allTabs).toHaveLength(4);
        expect(allTabs[0].tabProperties.tabId).toBe('a');
        expect(allTabs[0].level).toBe(0);
        expect(allTabs[1].tabProperties.tabId).toBe('a1');
        expect(allTabs[1].level).toBe(1);
        expect(allTabs[2].tabProperties.tabId).toBe('a1i');
        expect(allTabs[2].level).toBe(2);
        expect(allTabs[3].tabProperties.tabId).toBe('b');
        expect(allTabs[3].level).toBe(0);
    });

    it('returns empty array for doc with no tabs', () => {
        expect(getAllTabs({})).toEqual([]);
        expect(getAllTabs({ tabs: [] })).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// getTabTextLength
// ---------------------------------------------------------------------------
describe('getTabTextLength', () => {
    it('counts text in paragraphs', () => {
        const documentTab = {
            body: {
                content: [
                    {
                        paragraph: {
                            elements: [
                                { textRun: { content: 'Hello ' } },
                                { textRun: { content: 'World' } },
                            ],
                        },
                    },
                ],
            },
        };
        expect(getTabTextLength(documentTab)).toBe(11);
    });

    it('counts text inside tables', () => {
        const documentTab = {
            body: {
                content: [
                    {
                        table: {
                            tableRows: [
                                {
                                    tableCells: [
                                        {
                                            content: [
                                                {
                                                    paragraph: {
                                                        elements: [
                                                            { textRun: { content: 'Cell A' } },
                                                        ],
                                                    },
                                                },
                                            ],
                                        },
                                        {
                                            content: [
                                                {
                                                    paragraph: {
                                                        elements: [
                                                            { textRun: { content: 'Cell B' } },
                                                        ],
                                                    },
                                                },
                                            ],
                                        },
                                    ],
                                },
                            ],
                        },
                    },
                ],
            },
        };
        expect(getTabTextLength(documentTab)).toBe(12); // "Cell A" + "Cell B"
    });

    it('returns 0 for empty document tab', () => {
        expect(getTabTextLength(null)).toBe(0);
        expect(getTabTextLength({})).toBe(0);
        expect(getTabTextLength({ body: {} })).toBe(0);
        expect(getTabTextLength({ body: { content: [] } })).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// buildUpdateTextStyleRequest
// ---------------------------------------------------------------------------
describe('buildUpdateTextStyleRequest', () => {
    it('builds bold style request', () => {
        const result = buildUpdateTextStyleRequest(1, 10, { bold: true });
        expect(result).not.toBeNull();
        expect(result.request.updateTextStyle.textStyle.bold).toBe(true);
        expect(result.fields).toContain('bold');
        expect(result.request.updateTextStyle.range).toEqual({ startIndex: 1, endIndex: 10 });
    });

    it('builds multiple style fields', () => {
        const result = buildUpdateTextStyleRequest(1, 10, {
            bold: true,
            italic: true,
            fontSize: 14,
            fontFamily: 'Arial',
        });
        expect(result.fields).toEqual(['bold', 'italic', 'fontSize', 'weightedFontFamily']);
        expect(result.request.updateTextStyle.textStyle.fontSize).toEqual({
            magnitude: 14,
            unit: 'PT',
        });
        expect(result.request.updateTextStyle.textStyle.weightedFontFamily).toEqual({
            fontFamily: 'Arial',
        });
    });

    it('builds foreground color from hex', () => {
        const result = buildUpdateTextStyleRequest(1, 10, { foregroundColor: '#FF0000' });
        expect(result.request.updateTextStyle.textStyle.foregroundColor.color.rgbColor).toEqual({
            red: 1, green: 0, blue: 0,
        });
    });

    it('builds link URL', () => {
        const result = buildUpdateTextStyleRequest(1, 10, { linkUrl: 'https://example.com' });
        expect(result.request.updateTextStyle.textStyle.link).toEqual({ url: 'https://example.com' });
        expect(result.fields).toContain('link');
    });

    it('includes tabId in range when provided', () => {
        const result = buildUpdateTextStyleRequest(1, 10, { bold: true }, 'tab-42');
        expect(result.request.updateTextStyle.range.tabId).toBe('tab-42');
    });

    it('returns null when no styles are provided', () => {
        const result = buildUpdateTextStyleRequest(1, 10, {});
        expect(result).toBeNull();
    });

    it('throws on invalid hex color', () => {
        expect(() => buildUpdateTextStyleRequest(1, 10, { foregroundColor: 'not-hex' })).toThrow();
    });
});

// ---------------------------------------------------------------------------
// buildUpdateParagraphStyleRequest
// ---------------------------------------------------------------------------
describe('buildUpdateParagraphStyleRequest', () => {
    it('builds alignment request', () => {
        const result = buildUpdateParagraphStyleRequest(1, 10, { alignment: 'CENTER' });
        expect(result).not.toBeNull();
        expect(result.request.updateParagraphStyle.paragraphStyle.alignment).toBe('CENTER');
        expect(result.fields).toContain('alignment');
    });

    it('builds indentation with PT units', () => {
        const result = buildUpdateParagraphStyleRequest(1, 10, {
            indentStart: 36,
            indentEnd: 18,
        });
        expect(result.request.updateParagraphStyle.paragraphStyle.indentStart).toEqual({
            magnitude: 36,
            unit: 'PT',
        });
        expect(result.request.updateParagraphStyle.paragraphStyle.indentEnd).toEqual({
            magnitude: 18,
            unit: 'PT',
        });
    });

    it('builds spacing with PT units', () => {
        const result = buildUpdateParagraphStyleRequest(1, 10, {
            spaceAbove: 12,
            spaceBelow: 6,
        });
        expect(result.request.updateParagraphStyle.paragraphStyle.spaceAbove).toEqual({
            magnitude: 12,
            unit: 'PT',
        });
    });

    it('builds named style type', () => {
        const result = buildUpdateParagraphStyleRequest(1, 10, { namedStyleType: 'HEADING_1' });
        expect(result.request.updateParagraphStyle.paragraphStyle.namedStyleType).toBe('HEADING_1');
    });

    it('includes tabId in range when provided', () => {
        const result = buildUpdateParagraphStyleRequest(1, 10, { alignment: 'CENTER' }, 'tab-99');
        expect(result.request.updateParagraphStyle.range.tabId).toBe('tab-99');
    });

    it('returns null when no styles are provided', () => {
        const result = buildUpdateParagraphStyleRequest(1, 10, {});
        expect(result).toBeNull();
    });
});
