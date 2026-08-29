// Round-trip safety for the Docs <-> markdown converter (issues #118, #123).
//
// The property under test: what docsJsonToMarkdown emits must be valid input to
// convertMarkdownToRequests. Both bugs were the same shape — a read-then-write
// with ZERO edits corrupted the document, because the exporter emitted markdown
// the importer parses as something else:
//
//   #118  a styled run whose range includes trailing whitespace exported as
//         `**text **`, which CommonMark does not read as emphasis, so the
//         delimiters landed in the document as literal characters and the bold
//         was lost.
//   #123  a header paragraph directly after a list item exported with no blank
//         line, which CommonMark reads as a lazy continuation of that item, so
//         the header was merged into the last bullet.
//
// Asserting on the markdown string is what made #118 invisible in the first
// place: the corrupted document and the correct one export to identical
// markdown. So both sides are projected to the same structural shape instead —
// flat text, character-style spans, and which paragraphs are headings/bullets —
// and those are compared.
import { describe, it, expect } from '@jest/globals';
import { docsJsonToMarkdown } from '../dist/markdown-transformer/docsToMarkdown.js';
import { convertMarkdownToRequests } from '../dist/markdown-transformer/markdownToDocs.js';

const STYLE_KEYS = ['bold', 'italic', 'strikethrough'];

/** Maximal runs of consecutive characters carrying `key`, as [start, end) offsets. */
function spansOf(flags, key, text) {
    const spans = [];
    let open = null;
    for (let i = 0; i <= flags.length; i += 1) {
        // A newline is a paragraph mark, never emphasizable content: the
        // importer cannot style one and the exporter never wraps one.
        const on = i < flags.length && flags[i][key] === true && text[i] !== '\n';
        if (on && open === null) open = i;
        if (!on && open !== null) {
            spans.push([open, i]);
            open = null;
        }
    }
    return spans;
}

/** Paragraph boundaries of a flat text, as [start, end) offsets excluding the newline. */
function paragraphsOf(text) {
    const bounds = [];
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] === '\n') {
            bounds.push([start, i]);
            start = i + 1;
        }
    }
    if (start < text.length) bounds.push([start, text.length]);
    return bounds;
}

const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];

/** Trim whitespace off both ends of a span. The #118 normalization is exactly this. */
function trimSpan(text, [start, end]) {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(text[s])) s += 1;
    while (e > s && /\s/.test(text[e - 1])) e -= 1;
    return [s, e];
}

/** Structural projection of a Docs JSON body. */
function projectDoc(docData) {
    let text = '';
    const flags = [];
    const headings = [];
    const bullets = [];
    for (const element of docData.body.content) {
        const paragraph = element.paragraph;
        if (!paragraph) continue;
        const paragraphStart = text.length;
        for (const pe of paragraph.elements ?? []) {
            const content = pe.textRun?.content ?? '';
            const style = pe.textRun?.textStyle ?? {};
            for (const character of content) {
                text += character;
                flags.push(Object.fromEntries(STYLE_KEYS.map((k) => [k, style[k] === true])));
            }
        }
        const paragraphEnd = text.endsWith('\n') ? text.length - 1 : text.length;
        const bounds = [paragraphStart, paragraphEnd];
        if (paragraph.paragraphStyle?.namedStyleType?.startsWith('HEADING_')) headings.push(bounds);
        if (paragraph.bullet) bullets.push(bounds);
    }
    return {
        text,
        spans: Object.fromEntries(STYLE_KEYS.map((key) => [
            key,
            spansOf(flags, key, text).map((span) => trimSpan(text, span)),
        ])),
        headings,
        bullets,
    };
}

/**
 * The same projection, rebuilt by applying the importer's requests. The importer
 * emits inserts first, in document order and at final absolute indices, then
 * formatting over those indices — so replaying is a concatenation plus range
 * marking. Doc indices are 1-based and text offsets are 0-based, hence the -1.
 */
function projectRequests(requests) {
    let text = '';
    for (const request of requests) {
        if (request.insertText) text += request.insertText.text;
    }
    const flags = Array.from({ length: text.length }, () => (
        Object.fromEntries(STYLE_KEYS.map((k) => [k, false]))
    ));
    const bulletRanges = [];
    for (const request of requests) {
        const style = request.updateTextStyle;
        if (style) {
            for (let i = style.range.startIndex - 1; i < style.range.endIndex - 1; i += 1) {
                for (const key of STYLE_KEYS) {
                    if (style.textStyle[key] === true) flags[i][key] = true;
                }
            }
        }
        if (request.createParagraphBullets) {
            const { startIndex, endIndex } = request.createParagraphBullets.range;
            bulletRanges.push([startIndex - 1, endIndex - 1]);
        }
    }
    const headingRanges = requests
        .filter((r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType?.startsWith('HEADING_'))
        .map((r) => [r.updateParagraphStyle.range.startIndex - 1, r.updateParagraphStyle.range.endIndex - 1]);
    const paragraphs = paragraphsOf(text);
    return {
        text,
        spans: Object.fromEntries(STYLE_KEYS.map((key) => [key, spansOf(flags, key, text)])),
        headings: paragraphs.filter((p) => headingRanges.some((r) => overlaps(p, r))),
        bullets: paragraphs.filter((p) => bulletRanges.some((r) => overlaps(p, r))),
    };
}

function expectRoundTripStable(docData) {
    const markdown = docsJsonToMarkdown(docData);
    const { requests, warnings } = convertMarkdownToRequests(markdown, 1);
    expect(warnings).toEqual([]);
    const source = projectDoc(docData);
    const imported = projectRequests(requests);
    // No emphasis delimiter or list marker survived as literal document text.
    expect(imported.text).not.toMatch(/\*\*|~~|^\s*[-*] /m);
    expect(imported.text).toBe(source.text);
    for (const key of STYLE_KEYS) {
        expect({ [key]: imported.spans[key] }).toEqual({ [key]: source.spans[key] });
    }
    expect(imported.headings).toEqual(source.headings);
    expect(imported.bullets).toEqual(source.bullets);
    return markdown;
}

const run = (content, textStyle) => ({ textRun: { content, ...(textStyle ? { textStyle } : {}) } });
const para = (elements, extra = {}) => ({ paragraph: { elements, ...extra } });
const BULLETS = { L1: { listProperties: { nestingLevels: [{ glyphSymbol: '●' }] } } };
const NUMBERS = { L1: { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL' }] } } };

describe('markdown export round-trips through the importer', () => {
    it('survives a bold run whose range includes the trailing space (#118)', () => {
        const markdown = expectRoundTripStable({
            body: {
                content: [
                    para([
                        run('Owner: Andres. ', { bold: true }),
                        run('The kickoff is Monday.\n'),
                    ]),
                ],
            },
        });
        // The normalization itself: the space moved out from between the text
        // and its closing delimiter, where CommonMark refuses to read one.
        expect(markdown).toBe('**Owner: Andres.** The kickoff is Monday.');
        expect(markdown).not.toContain('. **');
    });

    it('survives italic and strikethrough runs with edge whitespace (#118)', () => {
        const markdown = expectRoundTripStable({
            body: {
                content: [
                    para([run('draft note ', { italic: true }), run('follows.\n')]),
                    para([run('dropped text ', { strikethrough: true }), run('stays.\n')]),
                    para([run('leading'), run(' emphasised', { bold: true }), run(' tail.\n')]),
                ],
            },
        });
        expect(markdown).toContain('*draft note* follows.');
        expect(markdown).toContain('~~dropped text~~ stays.');
        expect(markdown).toContain('leading **emphasised** tail.');
    });

    it('emits no delimiters for a run that is nothing but whitespace (#118)', () => {
        const markdown = docsJsonToMarkdown({
            body: { content: [para([run('before'), run(' ', { bold: true }), run('after\n')])] },
        });
        expect(markdown).toBe('before after');
    });

    it('survives a bold-text header immediately following a bulleted list (#123)', () => {
        const markdown = expectRoundTripStable({
            body: {
                content: [
                    para([run('We hand you your sticker sheet at setup.\n')], { bullet: { listId: 'L1', nestingLevel: 0 } }),
                    para([run('Nobody misses you.\n')], { bullet: { listId: 'L1', nestingLevel: 0 } }),
                    para([run('Free Social Media Content\n', { bold: true })]),
                    para([run('Body copy under the header.\n')]),
                ],
            },
            lists: BULLETS,
        });
        // A blank line, not a bare newline: without it CommonMark reads the
        // header as a lazy continuation of the last bullet and merges them.
        expect(markdown).toContain('misses you.\n\n**Free Social Media Content**');
        expect(markdown).not.toMatch(/misses you\.\n\*\*/);
    });

    it('survives a real heading immediately following a numbered list (#123)', () => {
        const markdown = expectRoundTripStable({
            body: {
                content: [
                    para([run('First step.\n')], { bullet: { listId: 'L1', nestingLevel: 0 } }),
                    para([run('Second step.\n')], { bullet: { listId: 'L1', nestingLevel: 0 } }),
                    para([run('Risks\n')], { paragraphStyle: { namedStyleType: 'HEADING_2' } }),
                    para([run('None at all.\n')]),
                ],
            },
            lists: NUMBERS,
        });
        expect(markdown).toContain('2. Second step.\n\n## Risks');
    });

    it('survives both defects in one document (a styled label inside a list, then a header)', () => {
        expectRoundTripStable({
            body: {
                content: [
                    para([run('Plan\n')], { paragraphStyle: { namedStyleType: 'HEADING_1' } }),
                    para([run('Owner: Andres. ', { bold: true }), run('Ships Monday.\n')], { bullet: { listId: 'L1', nestingLevel: 0 } }),
                    para([run('Reviewer: Sam. ', { bold: true }), run('Reads Tuesday.\n')], { bullet: { listId: 'L1', nestingLevel: 0 } }),
                    para([run('Free Social Media Content\n', { bold: true })]),
                    para([run('Body copy.\n')]),
                ],
            },
            lists: BULLETS,
        });
    });
});
