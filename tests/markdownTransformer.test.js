// Tests for the markdown transformer — docsJsonToMarkdown and convertMarkdownToRequests
import { describe, it, expect } from '@jest/globals';
import { docsJsonToMarkdown } from '../dist/markdown-transformer/docsToMarkdown.js';
import { convertMarkdownToRequests } from '../dist/markdown-transformer/markdownToDocs.js';
import { formatInsertResult } from '../dist/markdown-transformer/index.js';

// ---------------------------------------------------------------------------
// docsJsonToMarkdown — Docs JSON to markdown conversion
// ---------------------------------------------------------------------------
describe('docsJsonToMarkdown', () => {
    it('converts a simple paragraph', () => {
        const docData = {
            body: {
                content: [
                    {
                        paragraph: {
                            elements: [
                                {
                                    textRun: { content: 'Hello world\n' },
                                },
                            ],
                        },
                    },
                ],
            },
        };
        const md = docsJsonToMarkdown(docData);
        expect(md).toBe('Hello world');
    });

    it('converts headings', () => {
        const docData = {
            body: {
                content: [
                    {
                        paragraph: {
                            paragraphStyle: { namedStyleType: 'HEADING_1' },
                            elements: [{ textRun: { content: 'Title\n' } }],
                        },
                    },
                    {
                        paragraph: {
                            paragraphStyle: { namedStyleType: 'HEADING_2' },
                            elements: [{ textRun: { content: 'Subtitle\n' } }],
                        },
                    },
                ],
            },
        };
        const md = docsJsonToMarkdown(docData);
        expect(md).toContain('# Title');
        expect(md).toContain('## Subtitle');
    });

    it('converts TITLE to H1', () => {
        const docData = {
            body: {
                content: [
                    {
                        paragraph: {
                            paragraphStyle: { namedStyleType: 'TITLE' },
                            elements: [{ textRun: { content: 'Doc Title\n' } }],
                        },
                    },
                ],
            },
        };
        const md = docsJsonToMarkdown(docData);
        expect(md).toBe('# Doc Title');
    });

    it('converts bold text', () => {
        const docData = {
            body: {
                content: [
                    {
                        paragraph: {
                            elements: [
                                { textRun: { content: 'Normal ' } },
                                {
                                    textRun: {
                                        content: 'bold',
                                        textStyle: { bold: true },
                                    },
                                },
                                { textRun: { content: ' text\n' } },
                            ],
                        },
                    },
                ],
            },
        };
        const md = docsJsonToMarkdown(docData);
        expect(md).toContain('**bold**');
    });

    it('converts italic text', () => {
        const docData = {
            body: {
                content: [
                    {
                        paragraph: {
                            elements: [
                                {
                                    textRun: {
                                        content: 'emphasis',
                                        textStyle: { italic: true },
                                    },
                                },
                                { textRun: { content: '\n' } },
                            ],
                        },
                    },
                ],
            },
        };
        const md = docsJsonToMarkdown(docData);
        expect(md).toContain('*emphasis*');
    });

    it('converts links', () => {
        const docData = {
            body: {
                content: [
                    {
                        paragraph: {
                            elements: [
                                {
                                    textRun: {
                                        content: 'Click here',
                                        textStyle: {
                                            link: { url: 'https://example.com' },
                                        },
                                    },
                                },
                                { textRun: { content: '\n' } },
                            ],
                        },
                    },
                ],
            },
        };
        const md = docsJsonToMarkdown(docData);
        expect(md).toContain('[Click here](https://example.com)');
    });

    it('converts unordered lists', () => {
        const docData = {
            body: {
                content: [
                    {
                        paragraph: {
                            bullet: { listId: 'list1', nestingLevel: 0 },
                            elements: [{ textRun: { content: 'Item 1\n' } }],
                        },
                    },
                    {
                        paragraph: {
                            bullet: { listId: 'list1', nestingLevel: 0 },
                            elements: [{ textRun: { content: 'Item 2\n' } }],
                        },
                    },
                ],
            },
            lists: {
                list1: {
                    listProperties: {
                        nestingLevels: [{ glyphType: 'GLYPH_TYPE_UNSPECIFIED' }],
                    },
                },
            },
        };
        const md = docsJsonToMarkdown(docData);
        expect(md).toContain('- Item 1');
        expect(md).toContain('- Item 2');
    });

    it('returns empty string for empty body', () => {
        expect(docsJsonToMarkdown({})).toBe('');
        expect(docsJsonToMarkdown({ body: {} })).toBe('');
        expect(docsJsonToMarkdown({ body: { content: [] } })).toBe('');
    });

    it('converts section breaks to horizontal rules', () => {
        const docData = {
            body: {
                content: [
                    {
                        paragraph: {
                            elements: [{ textRun: { content: 'Before\n' } }],
                        },
                    },
                    { sectionBreak: {} },
                    {
                        paragraph: {
                            elements: [{ textRun: { content: 'After\n' } }],
                        },
                    },
                ],
            },
        };
        const md = docsJsonToMarkdown(docData);
        expect(md).toContain('---');
    });
});

// ---------------------------------------------------------------------------
// convertMarkdownToRequests — markdown to Docs API requests
// ---------------------------------------------------------------------------
describe('convertMarkdownToRequests', () => {
    it('returns empty array for empty/whitespace markdown', () => {
        expect(convertMarkdownToRequests('')).toEqual([]);
        expect(convertMarkdownToRequests('   ')).toEqual([]);
        expect(convertMarkdownToRequests(null)).toEqual([]);
    });

    it('generates insertText for plain text', () => {
        const requests = convertMarkdownToRequests('Hello world', 1);
        const inserts = requests.filter(r => 'insertText' in r);
        expect(inserts.length).toBeGreaterThan(0);
        // The inserted text should contain 'Hello world'
        const allInsertedText = inserts.map(r => r.insertText.text).join('');
        expect(allInsertedText).toContain('Hello world');
    });

    it('generates heading style for # heading', () => {
        const requests = convertMarkdownToRequests('# My Heading', 1);
        const paragraphStyles = requests.filter(r => 'updateParagraphStyle' in r);
        expect(paragraphStyles.length).toBeGreaterThan(0);
        // At least one should set HEADING_1 or TITLE
        const headingRequest = paragraphStyles.find(r => {
            const style = r.updateParagraphStyle?.paragraphStyle?.namedStyleType;
            return style === 'HEADING_1' || style === 'TITLE';
        });
        expect(headingRequest).toBeDefined();
    });

    it('generates bold formatting for **text**', () => {
        const requests = convertMarkdownToRequests('**bold text**', 1);
        const textStyles = requests.filter(r => 'updateTextStyle' in r);
        const boldRequest = textStyles.find(r =>
            r.updateTextStyle?.textStyle?.bold === true
        );
        expect(boldRequest).toBeDefined();
    });

    it('uses the provided startIndex for insertions', () => {
        const requests = convertMarkdownToRequests('Text', 42);
        const inserts = requests.filter(r => 'insertText' in r);
        // First insert should be at index 42
        expect(inserts[0].insertText.location.index).toBe(42);
    });

    it('includes tabId in requests when provided', () => {
        const requests = convertMarkdownToRequests('Text', 1, 'tab-99');
        const inserts = requests.filter(r => 'insertText' in r);
        expect(inserts[0].insertText.location.tabId).toBe('tab-99');
    });

    it('handles multiple paragraphs', () => {
        const md = 'Paragraph one\n\nParagraph two';
        const requests = convertMarkdownToRequests(md, 1);
        const inserts = requests.filter(r => 'insertText' in r);
        const allText = inserts.map(r => r.insertText.text).join('');
        expect(allText).toContain('Paragraph one');
        expect(allText).toContain('Paragraph two');
    });

    it('handles bullet lists', () => {
        const md = '- Item 1\n- Item 2\n- Item 3';
        const requests = convertMarkdownToRequests(md, 1);
        const inserts = requests.filter(r => 'insertText' in r);
        const allText = inserts.map(r => r.insertText.text).join('');
        expect(allText).toContain('Item 1');
        expect(allText).toContain('Item 2');
        expect(allText).toContain('Item 3');
    });

    // --- Issue #14: default foreground color ---
    it('adds base foreground color when defaultForegroundColor option is provided', () => {
        const requests = convertMarkdownToRequests('Hello world', 1, undefined, {
            defaultForegroundColor: { red: 0, green: 0, blue: 0 },
        });
        const colorRequests = requests.filter(r =>
            r.updateTextStyle?.fields === 'foregroundColor'
        );
        expect(colorRequests.length).toBe(1);
        expect(colorRequests[0].updateTextStyle.textStyle.foregroundColor.color.rgbColor).toEqual({
            red: 0, green: 0, blue: 0,
        });
    });

    it('base foreground color covers the full inserted range', () => {
        const requests = convertMarkdownToRequests('Hello world', 5, undefined, {
            defaultForegroundColor: { red: 0, green: 0, blue: 0 },
        });
        const colorReq = requests.find(r =>
            r.updateTextStyle?.fields === 'foregroundColor'
        );
        expect(colorReq).toBeDefined();
        expect(colorReq.updateTextStyle.range.startIndex).toBe(5);
        // endIndex should be > startIndex (covers the inserted text)
        expect(colorReq.updateTextStyle.range.endIndex).toBeGreaterThan(5);
    });

    it('does not add foreground color when option is not provided', () => {
        const requests = convertMarkdownToRequests('Hello world', 1);
        const colorRequests = requests.filter(r =>
            r.updateTextStyle?.fields === 'foregroundColor'
        );
        expect(colorRequests.length).toBe(0);
    });

    it('includes tabId in foreground color request when tabId is provided', () => {
        const requests = convertMarkdownToRequests('Hello', 1, 'tab-42', {
            defaultForegroundColor: { red: 0, green: 0, blue: 0 },
        });
        const colorReq = requests.find(r =>
            r.updateTextStyle?.fields === 'foregroundColor'
        );
        expect(colorReq).toBeDefined();
        expect(colorReq.updateTextStyle.range.tabId).toBe('tab-42');
    });

    it('supports non-black default colors (e.g. document with dark theme)', () => {
        const requests = convertMarkdownToRequests('Hello', 1, undefined, {
            defaultForegroundColor: { red: 1, green: 1, blue: 1 },
        });
        const colorReq = requests.find(r =>
            r.updateTextStyle?.fields === 'foregroundColor'
        );
        expect(colorReq.updateTextStyle.textStyle.foregroundColor.color.rgbColor).toEqual({
            red: 1, green: 1, blue: 1,
        });
    });
});

// ---------------------------------------------------------------------------
// formatInsertResult
// ---------------------------------------------------------------------------
describe('formatInsertResult', () => {
    it('formats a complete result', () => {
        const result = {
            totalElapsedMs: 150,
            parseElapsedMs: 5,
            totalRequests: 10,
            requestsByType: { insertText: 5, updateTextStyle: 3, updateParagraphStyle: 2 },
            batchUpdate: {
                totalApiCalls: 2,
                totalElapsedMs: 140,
                phases: {
                    delete: { requests: 0, apiCalls: 0, elapsedMs: 0 },
                    insert: { requests: 5, apiCalls: 1, elapsedMs: 80 },
                    format: { requests: 5, apiCalls: 1, elapsedMs: 60 },
                },
            },
        };
        const output = formatInsertResult(result);
        expect(output).toContain('150ms');
        expect(output).toContain('10 total');
        expect(output).toContain('5 insertText');
        expect(output).toContain('Insert phase');
        expect(output).toContain('Format phase');
        // Delete phase should not appear (0 requests)
        expect(output).not.toContain('Delete phase');
    });

    it('shows delete phase when present', () => {
        const result = {
            totalElapsedMs: 100,
            parseElapsedMs: 2,
            totalRequests: 3,
            requestsByType: { deleteContentRange: 1, insertText: 2 },
            batchUpdate: {
                totalApiCalls: 2,
                totalElapsedMs: 95,
                phases: {
                    delete: { requests: 1, apiCalls: 1, elapsedMs: 30 },
                    insert: { requests: 2, apiCalls: 1, elapsedMs: 60 },
                    format: { requests: 0, apiCalls: 0, elapsedMs: 0 },
                },
            },
        };
        const output = formatInsertResult(result);
        expect(output).toContain('Delete phase');
    });
});
