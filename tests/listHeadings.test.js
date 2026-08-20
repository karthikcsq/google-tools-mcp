// Coverage for listHeadings (issue #98, consolidated into #88).
//
// The acceptance items are all about honesty of the outline: TITLE/SUBTITLE
// count, a missing headingId stays null instead of being invented, an empty
// outline is distinguishable from a broken call, the mask is narrow, and the
// payload tracks the heading count rather than the document size.
import { describe, it, expect, jest } from '@jest/globals';

let fakeDocs;
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => fakeDocs,
    getDriveClient: async () => { throw new Error('not used'); },
    getSheetsClient: async () => { throw new Error('not used'); },
    getCalendarClient: async () => { throw new Error('not used'); },
}));

const { register } = await import('../dist/tools/docs/listHeadings.js');
const { collectHeadings, collectHeadingLinks } = await import('../dist/docsIndex.js');

const noopLog = { info() {}, error() {}, warn() {}, debug() {} };

function getTool() {
    const tools = new Map();
    register({ addTool(def) { tools.set(def.name, def); } });
    return tools.get('listHeadings');
}

/**
 * Body from a compact spec. `style` is the namedStyleType; `headingId` is
 * omitted for headings Google has not assigned an anchor id to yet.
 */
function buildBody(specs) {
    const content = [];
    let index = 1;
    for (const spec of specs) {
        const text = spec.text ?? '';
        const start = index;
        const end = start + text.length + 1;
        const paragraph = { elements: [{ startIndex: start, endIndex: end, textRun: { content: `${text}\n` } }] };
        if (spec.style || spec.headingId) {
            paragraph.paragraphStyle = {
                ...(spec.style ? { namedStyleType: spec.style } : {}),
                ...(spec.headingId ? { headingId: spec.headingId } : {}),
            };
        }
        if (spec.bullet) paragraph.bullet = spec.bullet;
        content.push({ startIndex: start, endIndex: end, paragraph });
        index = end;
    }
    return { content };
}

function setUp(body, { tabId = null, revisionId = 'rev-1' } = {}) {
    const documentsGet = jest.fn(async ({ fields, includeTabsContent }) => {
        if (includeTabsContent) {
            return { data: { revisionId, tabs: [{ tabProperties: { tabId: tabId ?? 'tab-1' }, documentTab: { body } }] } };
        }
        return { data: { revisionId, body } };
    });
    fakeDocs = { documents: { get: documentsGet } };
    return { documentsGet };
}

const DOC = [
    { text: 'The Whole Document', style: 'TITLE', headingId: 'h.title' },
    { text: 'A subtitle', style: 'SUBTITLE' },
    { text: 'Ordinary paragraph text', style: 'NORMAL_TEXT' },
    { text: 'Section One', style: 'HEADING_1', headingId: 'h.one' },
    { text: 'Subsection', style: 'HEADING_3', headingId: 'h.sub' },
    { text: 'A bulleted line', style: 'HEADING_2', bullet: { listId: 'l1', nestingLevel: 0 } },
];

describe('listHeadings', () => {
    it('returns text, nullable headingId, level and start index for every heading', async () => {
        setUp(buildBody(DOC));
        const payload = JSON.parse(await getTool().execute({ documentId: 'doc-1' }, { log: noopLog }));

        expect(payload.headingCount).toBe(4);
        expect(payload.headings.map((h) => [h.text, h.level, h.headingId])).toEqual([
            ['The Whole Document', 1, 'h.title'],
            ['A subtitle', 2, null],
            ['Section One', 1, 'h.one'],
            ['Subsection', 3, 'h.sub'],
        ]);
        // Start indices are real Docs indices, usable straight in modifyText.
        expect(payload.headings[0].startIndex).toBe(1);
        expect(payload.headings[2].startIndex).toBe(
            1 + DOC.slice(0, 3).reduce((sum, s) => sum + s.text.length + 1, 0),
        );
        expect(payload.revisionId).toBe('rev-1');
    });

    it('counts TITLE as level 1 and SUBTITLE as level 2, matching the markdown export', async () => {
        setUp(buildBody(DOC));
        const payload = JSON.parse(await getTool().execute({ documentId: 'doc-1' }, { log: noopLog }));
        const byStyle = Object.fromEntries(payload.headings.map((h) => [h.namedStyleType, h.level]));
        expect(byStyle.TITLE).toBe(1);
        expect(byStyle.SUBTITLE).toBe(2);
    });

    it('never invents a headingId for a heading Google has not assigned one to', async () => {
        setUp(buildBody(DOC));
        const payload = JSON.parse(await getTool().execute({ documentId: 'doc-1' }, { log: noopLog }));
        const subtitle = payload.headings.find((h) => h.text === 'A subtitle');
        expect(subtitle.headingId).toBeNull();
        expect(Object.keys(subtitle)).toContain('headingId');
    });

    it('excludes a bulleted paragraph even when it carries a heading style', async () => {
        setUp(buildBody(DOC));
        const payload = JSON.parse(await getTool().execute({ documentId: 'doc-1' }, { log: noopLog }));
        expect(payload.headings.map((h) => h.text)).not.toContain('A bulleted line');
    });

    it('says so explicitly on a document with no headings', async () => {
        setUp(buildBody([{ text: 'Just a paragraph' }]));
        const payload = JSON.parse(await getTool().execute({ documentId: 'doc-empty' }, { log: noopLog }));
        expect(payload.headingCount).toBe(0);
        expect(payload.headings).toEqual([]);
        expect(payload.note).toContain('no headings');
    });

    it('handles a completely empty body', async () => {
        setUp({ content: [] });
        const payload = JSON.parse(await getTool().execute({ documentId: 'doc-void' }, { log: noopLog }));
        expect(payload.headingCount).toBe(0);
        expect(payload.note).toBeDefined();
    });

    it('uses a NARROW field mask and never fetches the whole document', async () => {
        const { documentsGet } = setUp(buildBody(DOC));
        await getTool().execute({ documentId: 'doc-1' }, { log: noopLog });
        const { fields, includeTabsContent } = documentsGet.mock.calls[0][0];
        expect(fields).not.toBe('*');
        expect(fields).toContain('namedStyleType');
        expect(fields).toContain('headingId');
        // Nothing that scales with the document rather than its outline.
        expect(fields).not.toContain('table');
        expect(fields).not.toContain('inlineObjects');
        expect(fields).not.toContain('textStyle');
        expect(includeTabsContent).toBe(false);
    });

    it('reads the requested TAB, with a tab-specific mask', async () => {
        const tabBody = buildBody([{ text: 'Tab heading', style: 'HEADING_1', headingId: 'h.tab' }]);
        const { documentsGet } = setUp(tabBody, { tabId: 'tab-9' });
        const payload = JSON.parse(await getTool().execute({ documentId: 'doc-1', tabId: 'tab-9' }, { log: noopLog }));

        expect(documentsGet.mock.calls[0][0].includeTabsContent).toBe(true);
        expect(documentsGet.mock.calls[0][0].fields).toContain('tabs(');
        expect(payload.tabId).toBe('tab-9');
        expect(payload.headings).toHaveLength(1);
        expect(payload.headings[0].headingId).toBe('h.tab');
    });

    it('rejects an unknown tab by name', async () => {
        setUp(buildBody(DOC), { tabId: 'tab-real' });
        await expect(getTool().execute({ documentId: 'doc-1', tabId: 'tab-missing' }, { log: noopLog }))
            .rejects.toThrow(/Tab with ID "tab-missing" not found/);
    });

    it('keeps the payload proportional to the heading count, not the document size', async () => {
        const many = Array.from({ length: 400 }, (_, i) => ({ text: `Body paragraph number ${i} with a fair amount of filler text` }));
        const withHeadings = [{ text: 'Only Heading', style: 'HEADING_1' }, ...many];
        setUp(buildBody(withHeadings));
        const text = await getTool().execute({ documentId: 'doc-big' }, { log: noopLog });
        expect(JSON.parse(text).headingCount).toBe(1);
        // 400 paragraphs of filler; the response stays tiny.
        expect(text.length).toBeLessThan(600);
    });

    it('truncates in document order and says so when maxResults is exceeded', async () => {
        const specs = Array.from({ length: 10 }, (_, i) => ({ text: `H${i}`, style: 'HEADING_2' }));
        setUp(buildBody(specs));
        const payload = JSON.parse(await getTool().execute({ documentId: 'doc-1', maxResults: 3 }, { log: noopLog }));
        expect(payload.headingCount).toBe(10);
        expect(payload.returnedCount).toBe(3);
        expect(payload.truncated).toBe(true);
        expect(payload.headings.map((h) => h.text)).toEqual(['H0', 'H1', 'H2']);
        expect(payload.note).toContain('Raise maxResults');
    });
});

describe('collectHeadings / collectHeadingLinks (shared with the collateral scan)', () => {
    it('ignores headings inside table cells: they are not part of the outline', () => {
        const body = {
            content: [
                { startIndex: 1, endIndex: 10, paragraph: { paragraphStyle: { namedStyleType: 'HEADING_1' }, elements: [{ textRun: { content: 'Real\n' } }] } },
                {
                    startIndex: 10,
                    endIndex: 40,
                    table: {
                        rows: 1,
                        columns: 1,
                        tableRows: [{
                            tableCells: [{
                                startIndex: 12,
                                endIndex: 30,
                                content: [{ startIndex: 13, endIndex: 25, paragraph: { paragraphStyle: { namedStyleType: 'HEADING_2' }, elements: [{ textRun: { content: 'In a cell\n' } }] } }],
                            }],
                        }],
                    },
                },
            ],
        };
        expect(collectHeadings({ body }).map((h) => h.text)).toEqual(['Real']);
    });

    it('finds a heading link buried in a TABLE CELL (recursive scan)', () => {
        const linkRun = (text, headingId, start) => ({
            startIndex: start,
            endIndex: start + text.length,
            textRun: { content: text, textStyle: { link: { headingId } } },
        });
        const body = {
            content: [
                { startIndex: 1, endIndex: 12, paragraph: { elements: [linkRun('top link', 'h.one', 1)] } },
                {
                    startIndex: 12,
                    endIndex: 60,
                    table: {
                        rows: 1,
                        columns: 1,
                        tableRows: [{
                            tableCells: [{
                                startIndex: 14,
                                endIndex: 50,
                                content: [{ startIndex: 15, endIndex: 40, paragraph: { elements: [linkRun('cell link', 'h.two', 15)] } }],
                            }],
                        }],
                    },
                },
            ],
        };
        const links = collectHeadingLinks({ body });
        expect(links.map((l) => [l.text, l.headingId, l.inTable])).toEqual([
            ['top link', 'h.one', false],
            ['cell link', 'h.two', true],
        ]);
    });

    it('merges runs that Docs split inside one visible hyperlink', () => {
        const body = {
            content: [{
                startIndex: 1,
                endIndex: 20,
                paragraph: {
                    elements: [
                        { startIndex: 1, endIndex: 5, textRun: { content: 'See ', textStyle: { link: { headingId: 'h.x' } } } },
                        { startIndex: 5, endIndex: 12, textRun: { content: 'chapter', textStyle: { link: { headingId: 'h.x' } } } },
                    ],
                },
            }],
        };
        const links = collectHeadingLinks({ body });
        expect(links).toHaveLength(1);
        expect(links[0].text).toBe('See chapter');
    });

    it('ignores external links, which have a url rather than a headingId', () => {
        const body = {
            content: [{
                startIndex: 1,
                endIndex: 10,
                paragraph: { elements: [{ startIndex: 1, endIndex: 9, textRun: { content: 'external', textStyle: { link: { url: 'https://example.com' } } } }] },
            }],
        };
        expect(collectHeadingLinks({ body })).toEqual([]);
    });
});
