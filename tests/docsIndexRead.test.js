// readDocument(format:'index') — the affordable structural index (issue #105).
//
// Covers the output schema, semantic classification on top of the shared
// dist/docsStructure.js walker, tab and legacy shapes, the narrow field masks
// actually sent to the Docs API, budget/pagination round-tripping, and the
// read handle an index read must still mint.
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { z } from 'zod';

const documentsGet = jest.fn();
const mintDocsReadHandle = jest.fn(async () => null);

jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => ({ documents: { get: documentsGet } }),
    getDriveClient: async () => ({
        files: { get: async () => ({ data: { modifiedTime: null } }) },
    }),
}));

jest.unstable_mockModule('../dist/docsHandles.js', () => ({
    mintDocsReadHandle,
    ReadHandleParameter: z.string().optional(),
    beginDocsMutation: async () => { throw new Error('not used in this suite'); },
}));

const { register } = await import('../dist/tools/docs/readGoogleDoc.js');
const { INDEX_BODY_FIELDS, INDEX_TABS_FIELDS, buildDocumentIndex } = await import('../dist/docsIndex.js');

function createServer() {
    const tools = new Map();
    return {
        addTool(tool) { tools.set(tool.name, tool); },
        getTool(name) { return tools.get(name); },
    };
}

const log = { info() {}, error() {}, warn() {}, debug() {} };

function readDocument(args) {
    const server = createServer();
    register(server);
    const tool = server.getTool('readDocument');
    const parsed = tool.parameters.parse({ diffFromLastRead: false, ...args });
    return tool.execute(parsed, { log });
}

// --- fixtures ---------------------------------------------------------------

function cellContent(text, start, end) {
    return [{
        startIndex: start,
        endIndex: end,
        paragraph: { elements: [{ startIndex: start, endIndex: end, textRun: { content: text } }] },
    }];
}

function bodyFixture() {
    return {
        content: [
            {
                startIndex: 1, endIndex: 12,
                paragraph: {
                    paragraphStyle: { namedStyleType: 'HEADING_1' },
                    elements: [{ startIndex: 1, endIndex: 12, textRun: { content: 'To Do List\n' } }],
                },
            },
            {
                startIndex: 12, endIndex: 25,
                paragraph: {
                    bullet: { listId: 'ol', nestingLevel: 0 },
                    elements: [{ startIndex: 12, endIndex: 25, textRun: { content: 'Follow up now\n' } }],
                },
            },
            {
                startIndex: 25, endIndex: 40,
                paragraph: {
                    bullet: { listId: 'ul', nestingLevel: 1 },
                    elements: [{ startIndex: 25, endIndex: 40, textRun: { content: 'A sub bullet\n' } }],
                },
            },
            {
                startIndex: 40, endIndex: 80,
                table: {
                    rows: 2,
                    columns: 2,
                    tableRows: [
                        {
                            startIndex: 41, endIndex: 60,
                            tableCells: [
                                { startIndex: 42, endIndex: 50, content: cellContent('Name\n', 42, 50) },
                                { startIndex: 50, endIndex: 60, content: cellContent('Age\n', 50, 60) },
                            ],
                        },
                        {
                            startIndex: 60, endIndex: 79,
                            tableCells: [
                                { startIndex: 61, endIndex: 70, content: cellContent('Alice\n', 61, 70) },
                                { startIndex: 70, endIndex: 79, content: cellContent('30\n', 70, 79) },
                            ],
                        },
                    ],
                },
            },
            {
                startIndex: 80, endIndex: 82,
                paragraph: {
                    elements: [
                        { startIndex: 80, endIndex: 81, inlineObjectElement: { inlineObjectId: 'kix.img1' } },
                        { startIndex: 81, endIndex: 82, textRun: { content: '\n' } },
                    ],
                },
            },
            {
                startIndex: 82, endIndex: 83,
                paragraph: { elements: [{ startIndex: 82, endIndex: 83, horizontalRule: {} }] },
            },
            { startIndex: 83, endIndex: 84, sectionBreak: {} },
        ],
    };
}

const LISTS = {
    ol: { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL' }, { glyphType: 'ALPHA' }] } },
    ul: { listProperties: { nestingLevels: [{ glyphSymbol: '●' }, { glyphSymbol: '○' }] } },
};

function legacyDoc() {
    return { revisionId: 'rev-index-1', body: bodyFixture(), lists: LISTS };
}

function tabbedDoc() {
    return {
        revisionId: 'rev-index-tabs',
        tabs: [
            {
                tabProperties: { tabId: 'tab-1' },
                documentTab: { body: bodyFixture(), lists: LISTS },
            },
            {
                tabProperties: { tabId: 'tab-2' },
                documentTab: {
                    body: { content: [{ startIndex: 1, endIndex: 8, paragraph: { elements: [{ startIndex: 1, endIndex: 8, textRun: { content: 'Other\n' } }] } }] },
                    lists: {},
                },
            },
        ],
    };
}

beforeEach(() => {
    documentsGet.mockReset();
    mintDocsReadHandle.mockClear();
});

// ---------------------------------------------------------------------------

describe('readDocument format=index: output shape', () => {
    it('classifies every element with its raw start/end, heading level, list nesting and orderedness', async () => {
        documentsGet.mockResolvedValue({ data: legacyDoc() });
        const payload = JSON.parse(await readDocument({ documentId: 'doc-1', format: 'index' }));

        expect(payload.format).toBe('index');
        expect(payload.documentId).toBe('doc-1');
        expect(payload.revisionId).toBe('rev-index-1');
        expect(payload.tabId).toBeNull();
        expect(payload.documentEnd).toBe(84);
        expect(payload.truncated).toBe(false);
        expect(payload.totalElementCount).toBe(7);
        expect(payload.elementCount).toBe(7);

        expect(payload.elements.map((e) => e.type)).toEqual([
            'heading', 'listItem', 'listItem', 'table', 'inlineObject', 'horizontalRule', 'sectionBreak',
        ]);
        expect(payload.elements.map((e) => [e.start, e.end])).toEqual([
            [1, 12], [12, 25], [25, 40], [40, 80], [80, 82], [82, 83], [83, 84],
        ]);

        const [heading, ordered, unordered] = payload.elements;
        expect(heading).toMatchObject({ type: 'heading', level: 1, nesting: null, preview: 'To Do List' });
        expect(ordered).toMatchObject({ type: 'listItem', ordered: true, nesting: 0, preview: 'Follow up now' });
        expect(unordered).toMatchObject({ type: 'listItem', ordered: false, nesting: 1, preview: 'A sub bullet' });
        expect(heading.ordered).toBeUndefined();
        expect(ordered.level).toBeUndefined();
        expect(payload.elements[4].objectId).toBe('kix.img1');
    });

    it('nests table cells with their own indices, row and column addresses', async () => {
        documentsGet.mockResolvedValue({ data: legacyDoc() });
        const payload = JSON.parse(await readDocument({ documentId: 'doc-1', format: 'index' }));
        const table = payload.elements.find((e) => e.type === 'table');

        expect(table).toMatchObject({ start: 40, end: 80, rows: 2, columns: 2 });
        expect(table.cells).toEqual([
            { start: 42, end: 50, row: 0, col: 0, preview: 'Name' },
            { start: 50, end: 60, row: 0, col: 1, preview: 'Age' },
            { start: 61, end: 70, row: 1, col: 0, preview: 'Alice' },
            { start: 70, end: 79, row: 1, col: 1, preview: '30' },
        ]);
    });

    it('keeps top-level element ranges non-overlapping and contiguous with the raw document', async () => {
        documentsGet.mockResolvedValue({ data: legacyDoc() });
        const payload = JSON.parse(await readDocument({ documentId: 'doc-1', format: 'index' }));
        const raw = legacyDoc().body.content;
        payload.elements.forEach((element, i) => {
            expect(element.start).toBe(raw[i].startIndex);
            expect(element.end).toBe(raw[i].endIndex);
        });
        for (let i = 1; i < payload.elements.length; i += 1) {
            expect(payload.elements[i].start).toBeGreaterThanOrEqual(payload.elements[i - 1].end);
        }
    });

    it('reports 1-based, end-exclusive ranges the mutating tools can consume as-is', async () => {
        // Index-accurate fixture: Docs indices start at 1 and end exclusive, so
        // "Alpha\n" occupies [1,7) and "Beta\n" occupies [7,12). A range taken
        // from the index and handed to deleteRange/modifyText must select
        // exactly that element and nothing of its neighbour.
        const text = 'Alpha\nBeta\n';
        documentsGet.mockResolvedValue({
            data: {
                revisionId: 'rev-exact',
                body: {
                    content: [
                        { startIndex: 1, endIndex: 7, paragraph: { elements: [{ startIndex: 1, endIndex: 7, textRun: { content: 'Alpha\n' } }] } },
                        { startIndex: 7, endIndex: 12, paragraph: { elements: [{ startIndex: 7, endIndex: 12, textRun: { content: 'Beta\n' } }] } },
                    ],
                },
            },
        });
        const payload = JSON.parse(await readDocument({ documentId: 'doc-1', format: 'index' }));
        const [first, second] = payload.elements;

        expect(text.slice(first.start - 1, first.end - 1)).toBe('Alpha\n');
        expect(text.slice(second.start - 1, second.end - 1)).toBe('Beta\n');
        expect(first.end).toBe(second.start); // end-exclusive, no off-by-one gap
        expect(payload.documentEnd).toBe(12);
    });

    it('is far smaller than the same document rendered as raw json', async () => {
        documentsGet.mockResolvedValue({ data: legacyDoc() });
        const index = await readDocument({ documentId: 'doc-1', format: 'index' });
        documentsGet.mockResolvedValue({ data: legacyDoc() });
        const json = await readDocument({ documentId: 'doc-1', format: 'json' });
        expect(index.length).toBeLessThan(json.length);
    });
});

describe('readDocument format=index: field masks', () => {
    it('requests the narrow body mask, never "*", for a legacy document', async () => {
        documentsGet.mockResolvedValue({ data: legacyDoc() });
        await readDocument({ documentId: 'doc-1', format: 'index' });

        const request = documentsGet.mock.calls[0][0];
        expect(request.fields).toBe(INDEX_BODY_FIELDS);
        expect(request.fields).not.toContain('*');
        expect(request.includeTabsContent).toBe(false);
        // The affordability claim is about the fetch: nothing inherited comes back.
        expect(request.fields).not.toContain('textStyle');
        expect(request.fields).toContain('namedStyleType');
        expect(request.fields).toContain('nestingLevel');
        expect(request.fields).toContain('revisionId');
    });

    it('requests the narrow tab mask, never "*", for a tab-scoped read', async () => {
        documentsGet.mockResolvedValue({ data: tabbedDoc() });
        await readDocument({ documentId: 'doc-1', format: 'index', tabId: 'tab-1' });

        const request = documentsGet.mock.calls[0][0];
        expect(request.fields).toBe(INDEX_TABS_FIELDS);
        expect(request.fields).not.toContain('*');
        expect(request.includeTabsContent).toBe(true);
        expect(request.fields).toContain('tabProperties(tabId)');
        expect(request.fields).toContain('revisionId');
    });

    it('returns tab-local indices and labels every element with its tab', async () => {
        documentsGet.mockResolvedValue({ data: tabbedDoc() });
        const payload = JSON.parse(await readDocument({ documentId: 'doc-1', format: 'index', tabId: 'tab-1' }));

        expect(payload.tabId).toBe('tab-1');
        expect(payload.revisionId).toBe('rev-index-tabs');
        expect(payload.elements).toHaveLength(7);
        expect(payload.elements[0]).toMatchObject({ start: 1, end: 12, type: 'heading', tabId: 'tab-1' });
        // tab-2's content must not leak into a tab-1 read.
        expect(JSON.stringify(payload)).not.toContain('Other');
    });

    it('serves a legacy body-only document with no tabs array at all', async () => {
        documentsGet.mockResolvedValue({ data: { revisionId: 'rev-legacy', body: bodyFixture() } });
        const payload = JSON.parse(await readDocument({ documentId: 'doc-legacy', format: 'index' }));
        expect(payload.tabId).toBeNull();
        expect(payload.elements[0].tabId).toBeNull();
        expect(payload.elements).toHaveLength(7);
        // No lists map: nesting is still reported, orderedness falls back to false.
        expect(payload.elements[1]).toMatchObject({ type: 'listItem', nesting: 0, ordered: false });
    });
});

describe('readDocument format=index: budget and pagination', () => {
    it('truncates at an element boundary with valid JSON and a resume point', async () => {
        documentsGet.mockResolvedValue({ data: legacyDoc() });
        const raw = await readDocument({ documentId: 'doc-1', format: 'index', maxResponseChars: 700 });
        expect(() => JSON.parse(raw)).not.toThrow();
        const payload = JSON.parse(raw);

        expect(raw.length).toBeLessThanOrEqual(700);
        expect(payload.truncated).toBe(true);
        expect(payload.elementCount).toBeLessThan(payload.totalElementCount);
        expect(payload.elementCount).toBeGreaterThan(0);
        expect(payload.nextFromIndex).toBe(payload.elements[payload.elements.length - 1].end);
        expect(payload.note).toMatch(/fromIndex=/);
        expect(payload.note).toMatch(/no free resumption|no start-index cursor/);
    });

    it('round-trips nextFromIndex with no gap and no overlap', async () => {
        documentsGet.mockResolvedValue({ data: legacyDoc() });
        const first = JSON.parse(await readDocument({ documentId: 'doc-1', format: 'index', maxResponseChars: 700 }));
        const second = JSON.parse(await readDocument({
            documentId: 'doc-1', format: 'index', maxResponseChars: 700, fromIndex: first.nextFromIndex,
        }));

        expect(second.fromIndex).toBe(first.nextFromIndex);
        expect(second.elements[0].start).toBeGreaterThanOrEqual(first.nextFromIndex);

        // Walk the whole document by paging and confirm it reconstructs exactly.
        const seen = [];
        let cursor = 0;
        for (let page = 0; page < 20; page += 1) {
            // eslint-disable-next-line no-await-in-loop
            const p = JSON.parse(await readDocument({
                documentId: 'doc-1', format: 'index', maxResponseChars: 700, fromIndex: cursor,
            }));
            seen.push(...p.elements);
            if (!p.truncated) break;
            cursor = p.nextFromIndex;
        }
        documentsGet.mockResolvedValue({ data: legacyDoc() });
        const whole = JSON.parse(await readDocument({ documentId: 'doc-1', format: 'index' }));
        expect(seen.map((e) => [e.start, e.end, e.type]))
            .toEqual(whole.elements.map((e) => [e.start, e.end, e.type]));
    });

    it('fromIndex drops only elements wholly behind the cursor', async () => {
        documentsGet.mockResolvedValue({ data: legacyDoc() });
        const payload = JSON.parse(await readDocument({ documentId: 'doc-1', format: 'index', fromIndex: 40 }));
        expect(payload.fromIndex).toBe(40);
        expect(payload.totalElementCount).toBe(7);
        expect(payload.elements.map((e) => e.type))
            .toEqual(['table', 'inlineObject', 'horizontalRule', 'sectionBreak']);
        expect(payload.documentEnd).toBe(84);
    });

    it('always makes forward progress, even when one element alone exceeds the budget', () => {
        const payload = buildDocumentIndex(legacyDoc(), { maxResponseChars: 40 });
        expect(payload.truncated).toBe(true);
        expect(payload.budgetExceeded).toBe(true);
        expect(payload.elements).toHaveLength(1);
        expect(payload.nextFromIndex).toBe(payload.elements[0].end);
        expect(payload.note).toMatch(/larger than maxResponseChars/);
    });

    it('maxResponseChars=0 disables the budget', async () => {
        documentsGet.mockResolvedValue({ data: legacyDoc() });
        const payload = JSON.parse(await readDocument({ documentId: 'doc-1', format: 'index', maxResponseChars: 0 }));
        expect(payload.truncated).toBe(false);
        expect(payload.elementCount).toBe(7);
    });
});

describe('readDocument format=index: read handle', () => {
    it('mints a read handle from the same document JSON it serialized', async () => {
        documentsGet.mockResolvedValue({ data: legacyDoc() });
        const output = await readDocument({ documentId: 'doc-1', format: 'index' });

        expect(mintDocsReadHandle).toHaveBeenCalledTimes(1);
        const minted = mintDocsReadHandle.mock.calls[0][0];
        expect(minted.documentId).toBe('doc-1');
        expect(minted.tabId).toBeNull();
        expect(minted.revisionId).toBe('rev-index-1');
        expect(minted.content).toBe(output);
        // One fetch serves both: the fingerprint source is the exact object the
        // index was built from.
        expect(minted.contentSource.body.content).toHaveLength(7);
        expect(documentsGet).toHaveBeenCalledTimes(1);
    });

    it('binds the handle to the tab a tab-scoped index read saw', async () => {
        documentsGet.mockResolvedValue({ data: tabbedDoc() });
        await readDocument({ documentId: 'doc-1', format: 'index', tabId: 'tab-1' });
        expect(mintDocsReadHandle.mock.calls[0][0].tabId).toBe('tab-1');
    });
});

describe('readDocument format=json guardrails', () => {
    it('rejects maxLength of 0 or a negative at the schema', () => {
        const server = createServer();
        register(server);
        const schema = server.getTool('readDocument').parameters;
        expect(schema.safeParse({ documentId: 'd', maxLength: 0 }).success).toBe(false);
        expect(schema.safeParse({ documentId: 'd', maxLength: -5 }).success).toBe(false);
        expect(schema.safeParse({ documentId: 'd', maxLength: 1.5 }).success).toBe(false);
        expect(schema.safeParse({ documentId: 'd', maxLength: 100 }).success).toBe(true);
    });

    it('fails an oversized json read with a directive naming format=index', async () => {
        const huge = { revisionId: 'r', body: { content: [] } };
        for (let i = 0; i < 4000; i += 1) {
            huge.body.content.push({
                startIndex: i, endIndex: i + 1,
                paragraph: {
                    paragraphStyle: { namedStyleType: 'NORMAL_TEXT', alignment: 'START', lineSpacing: 100 },
                    elements: [{ startIndex: i, endIndex: i + 1, textRun: { content: 'x\n', textStyle: { bold: false, italic: false, underline: false } } }],
                },
            });
        }
        documentsGet.mockResolvedValue({ data: huge });
        await expect(readDocument({ documentId: 'doc-big', format: 'json' }))
            .rejects.toThrow(/format='index'/);
        expect(mintDocsReadHandle).not.toHaveBeenCalled();
    });

    it('keeps raw fidelity by default and strips only inherited styles when asked', async () => {
        const doc = {
            revisionId: 'r',
            body: {
                content: [{
                    startIndex: 1, endIndex: 5,
                    paragraph: {
                        paragraphStyle: { namedStyleType: 'HEADING_2' },
                        elements: [{ startIndex: 1, endIndex: 5, textRun: { content: 'Hi\n', textStyle: { bold: true } } }],
                    },
                }],
            },
            namedStyles: { styles: [{ namedStyleType: 'NORMAL_TEXT' }] },
            suggestedNamedStylesChanges: { abc: {} },
        };

        documentsGet.mockResolvedValue({ data: doc });
        const rawOut = JSON.parse(await readDocument({ documentId: 'doc-1', format: 'json' }));
        expect(rawOut.namedStyles).toBeDefined();
        expect(rawOut.suggestedNamedStylesChanges).toBeDefined();
        expect(rawOut.body.content[0].paragraph.elements[0].textRun.textStyle).toEqual({ bold: true });

        documentsGet.mockResolvedValue({ data: doc });
        const stripped = JSON.parse(await readDocument({
            documentId: 'doc-1', format: 'json', stripInheritedStyles: true,
        }));
        expect(stripped.namedStyles).toBeUndefined();
        expect(stripped.suggestedNamedStylesChanges).toBeUndefined();
        expect(stripped.body.content[0].paragraph.elements[0].textRun.textStyle).toBeUndefined();
        // Structure and every index survive.
        expect(stripped.body.content[0].startIndex).toBe(1);
        expect(stripped.body.content[0].endIndex).toBe(5);
        expect(stripped.body.content[0].paragraph.paragraphStyle.namedStyleType).toBe('HEADING_2');
        expect(stripped.body.content[0].paragraph.elements[0].startIndex).toBe(1);
    });
});
