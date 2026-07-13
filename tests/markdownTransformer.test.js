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

    it('ignores the boilerplate initial document section break', () => {
        const docData = {
            body: {
                content: [
                    { endIndex: 1, sectionBreak: {} },
                    {
                        paragraph: {
                            elements: [{ textRun: { content: 'First paragraph\n' } }],
                        },
                    },
                ],
            },
        };
        const md = docsJsonToMarkdown(docData);
        expect(md).toBe('First paragraph');
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

    it('emits rich markdown by default for Docs-only text styles', () => {
        const docData = {
            body: {
                content: [
                    {
                        paragraph: {
                            paragraphStyle: { alignment: 'CENTER' },
                            elements: [
                                {
                                    textRun: {
                                        content: 'Styled',
                                        textStyle: {
                                            underline: true,
                                            foregroundColor: { color: { rgbColor: { red: 1, green: 0, blue: 0 } } },
                                            backgroundColor: { color: { rgbColor: { red: 1, green: 1, blue: 0 } } },
                                            fontSize: { magnitude: 14, unit: 'PT' },
                                            weightedFontFamily: { fontFamily: 'Arial' },
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
        expect(md).toContain('<p align="center">');
        expect(md).toContain('<u>');
        expect(md).toContain('color:#ff0000');
        expect(md).toContain('background-color:#ffff00');
        expect(md).toContain('font-size:14pt');
        expect(md).toContain('font-family:Arial');
    });

    it('can opt out of rich markdown extensions', () => {
        const docData = {
            body: {
                content: [
                    {
                        paragraph: {
                            paragraphStyle: { alignment: 'CENTER' },
                            elements: [
                                {
                                    textRun: {
                                        content: 'Styled\n',
                                        textStyle: {
                                            underline: true,
                                            foregroundColor: { color: { rgbColor: { red: 1, green: 0, blue: 0 } } },
                                        },
                                    },
                                },
                            ],
                        },
                    },
                ],
            },
        };
        const md = docsJsonToMarkdown(docData, { plainMarkdown: true });
        expect(md).toBe('Styled');
    });

    it('emits markdown table alignment from Google Docs table cells', () => {
        const docData = {
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
                                                        paragraphStyle: { alignment: 'CENTER' },
                                                        elements: [{ textRun: { content: 'Name\n' } }],
                                                    },
                                                },
                                            ],
                                        },
                                        {
                                            content: [
                                                {
                                                    paragraph: {
                                                        paragraphStyle: { alignment: 'END' },
                                                        elements: [{ textRun: { content: 'Value\n' } }],
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
        const md = docsJsonToMarkdown(docData);
        expect(md).toContain('| :---: | ---: |');
    });
});

// ---------------------------------------------------------------------------
// convertMarkdownToRequests — markdown to Docs API requests
// ---------------------------------------------------------------------------
describe('convertMarkdownToRequests', () => {
    it('returns empty requests and warnings for empty/whitespace markdown', () => {
        expect(convertMarkdownToRequests('')).toEqual({ requests: [], warnings: [] });
        expect(convertMarkdownToRequests('   ')).toEqual({ requests: [], warnings: [] });
        expect(convertMarkdownToRequests(null)).toEqual({ requests: [], warnings: [] });
    });

    it('generates insertText for plain text', () => {
        const { requests } = convertMarkdownToRequests('Hello world', 1);
        const inserts = requests.filter(r => 'insertText' in r);
        expect(inserts.length).toBeGreaterThan(0);
        // The inserted text should contain 'Hello world'
        const allInsertedText = inserts.map(r => r.insertText.text).join('');
        expect(allInsertedText).toContain('Hello world');
    });

    it('generates heading style for # heading', () => {
        const { requests } = convertMarkdownToRequests('# My Heading', 1);
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
        const { requests } = convertMarkdownToRequests('**bold text**', 1);
        const textStyles = requests.filter(r => 'updateTextStyle' in r);
        const boldRequest = textStyles.find(r =>
            r.updateTextStyle?.textStyle?.bold === true
        );
        expect(boldRequest).toBeDefined();
    });

    it('uses the provided startIndex for insertions', () => {
        const { requests } = convertMarkdownToRequests('Text', 42);
        const inserts = requests.filter(r => 'insertText' in r);
        // First insert should be at index 42
        expect(inserts[0].insertText.location.index).toBe(42);
    });

    it('includes tabId in requests when provided', () => {
        const { requests } = convertMarkdownToRequests('Text', 1, 'tab-99');
        const inserts = requests.filter(r => 'insertText' in r);
        expect(inserts[0].insertText.location.tabId).toBe('tab-99');
    });

    it('handles multiple paragraphs', () => {
        const md = 'Paragraph one\n\nParagraph two';
        const { requests } = convertMarkdownToRequests(md, 1);
        const inserts = requests.filter(r => 'insertText' in r);
        const allText = inserts.map(r => r.insertText.text).join('');
        expect(allText).toContain('Paragraph one');
        expect(allText).toContain('Paragraph two');
    });

    it('handles bullet lists', () => {
        const md = '- Item 1\n- Item 2\n- Item 3';
        const { requests } = convertMarkdownToRequests(md, 1);
        const inserts = requests.filter(r => 'insertText' in r);
        const allText = inserts.map(r => r.insertText.text).join('');
        expect(allText).toContain('Item 1');
        expect(allText).toContain('Item 2');
        expect(allText).toContain('Item 3');
    });

    it('parses rich inline HTML formatting into text style requests', () => {
        const { requests } = convertMarkdownToRequests('<u><span style="color:#ff0000; background-color:#ffff00; font-size:14pt; font-family:Arial">Styled</span></u>', 1);
        const richRequest = requests.find(r =>
            r.updateTextStyle?.textStyle?.underline === true &&
            r.updateTextStyle?.textStyle?.foregroundColor?.color?.rgbColor?.red === 1 &&
            r.updateTextStyle?.textStyle?.backgroundColor?.color?.rgbColor?.red === 1 &&
            r.updateTextStyle?.textStyle?.fontSize?.magnitude === 14 &&
            r.updateTextStyle?.textStyle?.weightedFontFamily?.fontFamily === 'Arial'
        );
        expect(richRequest).toBeDefined();
    });

    it('parses paragraph alignment wrappers', () => {
        const { requests } = convertMarkdownToRequests('<p align="center">Centered text</p>', 1);
        const alignmentRequest = requests.find(r =>
            r.updateParagraphStyle?.paragraphStyle?.alignment === 'CENTER'
        );
        expect(alignmentRequest).toBeDefined();
    });

    it('styles markdown blockquotes instead of dropping them', () => {
        const { requests } = convertMarkdownToRequests('> Quoted text', 1);
        const quoteRequest = requests.find(r =>
            r.updateParagraphStyle?.paragraphStyle?.indentStart?.magnitude === 36 &&
            r.updateParagraphStyle?.paragraphStyle?.borderLeft
        );
        expect(quoteRequest).toBeDefined();
    });

    it('applies markdown table alignment to table cell paragraphs', () => {
        const { requests } = convertMarkdownToRequests('| Left | Right |\n| --- | ---: |\n| a | b |', 1);
        const alignmentRequest = requests.find(r =>
            r.updateParagraphStyle?.paragraphStyle?.alignment === 'END'
        );
        expect(alignmentRequest).toBeDefined();
    });

    // --- Issue #14: default foreground color ---
    it('adds base foreground color when defaultForegroundColor option is provided', () => {
        const { requests } = convertMarkdownToRequests('Hello world', 1, undefined, {
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
        const { requests } = convertMarkdownToRequests('Hello world', 5, undefined, {
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
        const { requests } = convertMarkdownToRequests('Hello world', 1);
        const colorRequests = requests.filter(r =>
            r.updateTextStyle?.fields === 'foregroundColor'
        );
        expect(colorRequests.length).toBe(0);
    });

    it('includes tabId in foreground color request when tabId is provided', () => {
        const { requests } = convertMarkdownToRequests('Hello', 1, 'tab-42', {
            defaultForegroundColor: { red: 0, green: 0, blue: 0 },
        });
        const colorReq = requests.find(r =>
            r.updateTextStyle?.fields === 'foregroundColor'
        );
        expect(colorReq).toBeDefined();
        expect(colorReq.updateTextStyle.range.tabId).toBe('tab-42');
    });

    it('supports non-black default colors (e.g. document with dark theme)', () => {
        const { requests } = convertMarkdownToRequests('Hello', 1, undefined, {
            defaultForegroundColor: { red: 1, green: 1, blue: 1 },
        });
        const colorReq = requests.find(r =>
            r.updateTextStyle?.fields === 'foregroundColor'
        );
        expect(colorReq.updateTextStyle.textStyle.foregroundColor.color.rgbColor).toEqual({
            red: 1, green: 1, blue: 1,
        });
    });

    it('warns when a markdown image is dropped', () => {
        const { requests, warnings } = convertMarkdownToRequests('Before ![architecture diagram](https://example.com/diagram.png) after');
        // Surrounding text still converts; the image is the only thing dropped.
        expect(requests.some(r => 'insertText' in r)).toBe(true);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('architecture diagram');
        expect(warnings[0]).toContain('https://example.com/diagram.png');
    });

    it('warns when unsupported HTML block content is dropped', () => {
        const { warnings } = convertMarkdownToRequests('<details><summary>Notes</summary>Hidden details</details>');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('<details>');
        expect(warnings[0]).toContain('Hidden details');
    });

    it('returns zero warnings for supported markdown constructs', () => {
        const markdown = '# Heading\n\n- item\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n---\n\n```js\nconst ok = true;\n```';
        const { warnings } = convertMarkdownToRequests(markdown);
        expect(warnings).toEqual([]);
    });

    it('collapses repeated identical drops into one warning with an occurrence count', () => {
        const md = '![logo](https://example.com/logo.png)\n\n![logo](https://example.com/logo.png)\n\n![logo](https://example.com/logo.png)';
        const { warnings } = convertMarkdownToRequests(md);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('(3 occurrences)');
    });

    it('preserves warnings across array transformations (explicit object contract)', () => {
        // The warnings live on a sibling field, not a hidden array property, so
        // spreading/cloning the requests array cannot silently drop them.
        const result = convertMarkdownToRequests('![diagram](https://example.com/d.png)');
        const spreadRequests = [...result.requests];
        const clonedResult = JSON.parse(JSON.stringify(result));
        expect(spreadRequests).toEqual(result.requests);
        expect(clonedResult.warnings).toEqual(result.warnings);
        expect(result.warnings).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// formatInsertResult
// ---------------------------------------------------------------------------
describe('formatInsertResult', () => {
    it('puts content-drop warnings before the success summary', () => {
        const output = formatInsertResult({
            warnings: ['Dropped image "diagram" (https://example.com/image.png).'],
            totalElapsedMs: 1,
            parseElapsedMs: 1,
            totalRequests: 0,
            requestsByType: {},
            batchUpdate: { totalApiCalls: 0, totalElapsedMs: 0 },
        });
        expect(output).toMatch(/^WARNINGS \(content dropped\):/);
        expect(output).toContain('Dropped image "diagram"');
    });

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
