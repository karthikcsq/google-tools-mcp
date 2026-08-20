// Coverage for replaceRangeWithMarkdown (issue #107, canonical for #104).
//
// dist/clients.js is the only mock: the range resolver, the structural walker,
// the fidelity scanner, the markdown importer, readTracker and the read-handle
// guard all run for real. The Google fake keeps a running body-end so the tool's
// *measured* insert length (body growth, not the sum of the insertText payloads)
// is exercised the same way a real document would exercise it — including the
// tab characters createParagraphBullets consumes to build list nesting.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

let fakeDocs;
let fakeDrive;
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => fakeDocs,
    getDriveClient: async () => fakeDrive,
    getSheetsClient: async () => { throw new Error('not used'); },
    getCalendarClient: async () => { throw new Error('not used'); },
}));

const { trackRead } = await import('../dist/readTracker.js');
const { register } = await import('../dist/tools/docs/replaceRangeWithMarkdown.js');
const { docsJsonToMarkdown } = await import('../dist/markdown-transformer/index.js');

const noopLog = { info() {}, error() {}, warn() {}, debug() {} };

function createMockServer() {
    const tools = new Map();
    return {
        addTool(def) { tools.set(def.name, def); },
        getTool(name) { return tools.get(name); },
    };
}

function getTool() {
    const server = createMockServer();
    register(server);
    return server.getTool('replaceRangeWithMarkdown');
}

// --- document fixtures ------------------------------------------------------

/**
 * Build a Docs API body from a compact spec. Each paragraph occupies
 * [start, start + text.length + 1): the trailing paragraph mark is the +1, the
 * same way the real API reports it.
 */
function buildBody(specs) {
    const content = [];
    let index = 1;
    for (const spec of specs) {
        if (spec.table) {
            const rows = spec.table.rows ?? 1;
            const columns = spec.table.columns ?? 1;
            const length = spec.table.length ?? 20;
            content.push({
                startIndex: index,
                endIndex: index + length,
                table: { rows, columns, tableRows: [] },
            });
            index += length;
            continue;
        }
        const text = spec.text ?? '';
        const start = index;
        const end = start + text.length + 1;
        const elements = [];
        if (spec.image) {
            elements.push({ startIndex: start, endIndex: start + 1, inlineObjectElement: { inlineObjectId: spec.image } });
            if (text) elements.push({ startIndex: start + 1, endIndex: end - 1, textRun: { content: text } });
        } else {
            elements.push({ startIndex: start, endIndex: end, textRun: { content: `${text}\n` } });
        }
        const paragraph = { elements };
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

const LISTS = {
    'list-1': { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL' }, { glyphType: 'ALPHA' }, { glyphType: 'ROMAN' }] } },
};

/**
 * Google fake. `documents.get` is dispatched on the field mask the tool uses;
 * `documents.batchUpdate` records every request and advances a simulated body
 * end so the post-insert measurement is meaningful.
 */
function makeGoogle(body, { lists = LISTS, revisionId = 'rev-read', tabId = null, failDelete = false } = {}) {
    const batches = [];
    let growth = 0;
    const bodyEnd = () => body.content[body.content.length - 1].endIndex + growth;

    const bodyWithGrowth = () => ({
        content: body.content.map((element, i) => (
            i === body.content.length - 1
                ? { ...element, endIndex: element.endIndex + growth }
                : element
        )),
    });

    const documentsGet = jest.fn(async ({ fields, includeTabsContent }) => {
        if (fields === 'namedStyles') return { data: { namedStyles: { styles: [] } } };
        const payloadBody = fields?.includes('endIndex)') ? bodyWithGrowth() : body;
        if (includeTabsContent) {
            return {
                data: {
                    revisionId,
                    tabs: [{ tabProperties: { tabId: tabId ?? 'tab-1' }, documentTab: { body: payloadBody, lists } }],
                },
            };
        }
        return { data: { revisionId, body: payloadBody, lists } };
    });

    const batchUpdate = jest.fn(async ({ requestBody }) => {
        const requests = requestBody.requests;
        batches.push({ requests, writeControl: requestBody.writeControl });
        if (failDelete && requests.some((r) => 'deleteContentRange' in r)) {
            throw Object.assign(new Error('backend refused the delete'), { code: 500 });
        }
        for (const request of requests) {
            if (request.insertText) growth += request.insertText.text.length;
            if (request.deleteContentRange) {
                const { startIndex, endIndex } = request.deleteContentRange.range;
                growth -= endIndex - startIndex;
            }
            if (request.createParagraphBullets) {
                // The real API strips the leading tab of every nested item.
                const { startIndex, endIndex } = request.createParagraphBullets.range;
                growth -= countTabsInserted(batches, startIndex, endIndex);
            }
        }
        return { data: { writeControl: { requiredRevisionId: `rev-${batches.length}` } } };
    });

    fakeDocs = { documents: { get: documentsGet, batchUpdate } };
    fakeDrive = { files: { get: async () => ({ data: { modifiedTime: null } }) } };
    return { batches, documentsGet, batchUpdate, bodyEnd };
}

function countTabsInserted(batches, startIndex, endIndex) {
    let tabs = 0;
    for (const batch of batches) {
        for (const request of batch.requests) {
            const insert = request.insertText;
            if (!insert) continue;
            const at = insert.location.index;
            if (insert.text === '\t' && at >= startIndex && at < endIndex) tabs += 1;
        }
    }
    return tabs;
}

const allRequests = (batches) => batches.flatMap((batch) => batch.requests);
const requestsOf = (batches, kind) => allRequests(batches).filter((request) => kind in request);

/** Every document index any request touches. */
function touchedIndices(batches) {
    const indices = [];
    for (const request of allRequests(batches)) {
        const value = Object.values(request)[0];
        if (value.location) indices.push(value.location.index);
        if (value.range) indices.push(value.range.startIndex, value.range.endIndex);
    }
    return indices;
}

// A three-section document: an intro, a "Roadmap" section holding a flat list,
// and a following section that must survive byte-exact.
const SECTIONS = [
    { text: 'Project plan', style: 'HEADING_1' },
    { text: 'Roadmap', style: 'HEADING_2', headingId: 'h.roadmap' },
    { text: 'ship the thing', bullet: { listId: 'list-1', nestingLevel: 0 } },
    { text: 'then rest', bullet: { listId: 'list-1', nestingLevel: 0 } },
    { text: 'Risks', style: 'HEADING_2' },
    { text: 'none at all' },
];

// Index math for SECTIONS, recomputed rather than hard-coded.
function boundsOf(specs) {
    const body = buildBody(specs);
    return body.content.map((element) => ({ start: element.startIndex, end: element.endIndex }));
}

beforeEach(() => {
    // Legacy (no request context) guard path: a tracked read authorizes the write.
    fakeDocs = undefined;
    fakeDrive = undefined;
});

describe('replaceRangeWithMarkdown — section-scoped replacement', () => {
    it('replaces exactly the section under a heading and touches nothing before it', async () => {
        const body = buildBody(SECTIONS);
        const bounds = boundsOf(SECTIONS);
        const sectionStart = bounds[1].end;   // just after the "Roadmap" heading
        const sectionEnd = bounds[4].start;   // start of the "Risks" heading
        const { batches } = makeGoogle(body);
        const documentId = `range-section-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');

        const output = await getTool().execute({
            documentId,
            target: { afterHeading: 'Roadmap' },
            markdown: '- first\n- second\n',
        }, { log: noopLog });

        expect(output).toContain(`Replaced range ${sectionStart}-${sectionEnd}`);

        // Nothing is addressed before the section start: the preceding headings
        // and the intro paragraph are untouched by construction.
        for (const index of touchedIndices(batches)) {
            expect(index).toBeGreaterThanOrEqual(sectionStart);
        }

        // The old content is deleted from its shifted position, and the shift is
        // exactly the measured insert length — so the delete lands on the old
        // section and not one character into "Risks".
        const deletes = requestsOf(batches, 'deleteContentRange');
        expect(deletes).toHaveLength(1);
        const { startIndex, endIndex } = deletes[0].deleteContentRange.range;
        expect(endIndex - startIndex).toBe(sectionEnd - sectionStart);
        const inserted = startIndex - sectionStart;
        expect(inserted).toBeGreaterThan(0);
        // Insert first, delete second: nothing is ever missing from the document.
        const order = batches.findIndex((batch) => batch.requests.some((r) => 'insertText' in r));
        const deleteBatch = batches.findIndex((batch) => batch.requests.some((r) => 'deleteContentRange' in r));
        expect(order).toBeLessThan(deleteBatch);
    });

    it('neutralizes the range\'s own first paragraph so inserted content inherits no list membership', async () => {
        const body = buildBody(SECTIONS);
        const bounds = boundsOf(SECTIONS);
        const sectionStart = bounds[1].end;
        const { batches } = makeGoogle(body);
        const documentId = `range-cleanup-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');

        await getTool().execute({
            documentId,
            target: { afterHeading: 'Roadmap' },
            markdown: 'Just a plain paragraph now.\n',
        }, { log: noopLog });

        const cleanup = requestsOf(batches, 'deleteParagraphBullets');
        expect(cleanup).toHaveLength(1);
        // Scoped to the first paragraph OF THE RANGE (a list item we delete
        // anyway), never to the surviving paragraph that follows the range.
        expect(cleanup[0].deleteParagraphBullets.range.startIndex).toBe(sectionStart);
        expect(cleanup[0].deleteParagraphBullets.range.endIndex).toBe(bounds[2].end);
        const styleReset = requestsOf(batches, 'updateParagraphStyle')
            .find((r) => r.updateParagraphStyle.paragraphStyle.namedStyleType === 'NORMAL_TEXT');
        expect(styleReset).toBeDefined();
        // The cleanup runs before anything is inserted.
        expect(batches[0].requests.some((r) => 'deleteParagraphBullets' in r)).toBe(true);
        expect(batches[0].requests.some((r) => 'insertText' in r)).toBe(false);
    });

    it('preserveHeading:false moves the start boundary onto the heading paragraph', async () => {
        const bounds = boundsOf(SECTIONS);
        makeGoogle(buildBody(SECTIONS));
        const documentId = `range-heading-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');

        const output = await getTool().execute({
            documentId,
            target: { afterHeading: 'Roadmap' },
            preserveHeading: false,
            markdown: '## Roadmap (revised)\n\n- one\n',
            dryRun: true,
        }, { log: noopLog });

        expect(output).toContain(`Resolved range: ${bounds[1].start}-${bounds[4].start}`);
    });

    it('resolves a section by headingId and runs it to the end of the body when no heading follows', async () => {
        const specs = [
            { text: 'Intro', style: 'HEADING_1' },
            { text: 'Notes', style: 'HEADING_2', headingId: 'h.notes' },
            { text: 'old note' },
        ];
        const bounds = boundsOf(specs);
        const bodyEnd = bounds[bounds.length - 1].end;
        makeGoogle(buildBody(specs));
        const documentId = `range-headingid-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');

        const output = await getTool().execute({
            documentId,
            target: { headingId: 'h.notes' },
            markdown: 'new note\n',
            dryRun: true,
        }, { log: noopLog });

        expect(output).toContain(`Resolved range: ${bounds[1].end}-${bodyEnd - 1}`);
    });

    it('includes deeper sub-headings in the section and stops at the next same-level heading', async () => {
        const specs = [
            { text: 'Part one', style: 'HEADING_2' },
            { text: 'Detail', style: 'HEADING_3' },
            { text: 'body text' },
            { text: 'Part two', style: 'HEADING_2' },
            { text: 'more' },
        ];
        const bounds = boundsOf(specs);
        makeGoogle(buildBody(specs));
        const documentId = `range-nested-heading-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');

        const output = await getTool().execute({
            documentId,
            target: { afterHeading: 'Part one' },
            markdown: 'replacement\n',
            dryRun: true,
        }, { log: noopLog });

        expect(output).toContain(`Resolved range: ${bounds[0].end}-${bounds[3].start}`);
        expect(output).toContain('heading (level 3)');
    });

    it('matches a heading longer than the 60/80-character index preview', async () => {
        const longHeading = 'A deliberately long heading that runs well past any preview truncation boundary used by the structural index';
        const specs = [
            { text: longHeading, style: 'HEADING_2' },
            { text: 'section body' },
        ];
        const bounds = boundsOf(specs);
        makeGoogle(buildBody(specs));
        const documentId = `range-longheading-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');

        const output = await getTool().execute({
            documentId,
            // Whitespace-normalized, case-insensitive full-text match.
            target: { afterHeading: `  ${longHeading.toUpperCase()}  ` },
            markdown: 'replacement\n',
            dryRun: true,
        }, { log: noopLog });

        expect(output).toContain(`Resolved range: ${bounds[0].end}-${bounds[1].end - 1}`);
    });
});

describe('replaceRangeWithMarkdown — list nesting inside a range (#104)', () => {
    it('emits per-level tabs and createParagraphBullets for a nested ordered list', async () => {
        const body = buildBody(SECTIONS);
        const { batches } = makeGoogle(body);
        const documentId = `range-nesting-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');

        await getTool().execute({
            documentId,
            target: { afterHeading: 'Roadmap' },
            markdown: '1. one\n   1. nested a\n   2. nested b\n2. two\n',
        }, { log: noopLog });

        const tabInserts = requestsOf(batches, 'insertText')
            .filter((r) => r.insertText.text === '\t');
        expect(tabInserts).toHaveLength(2);
        const bullets = requestsOf(batches, 'createParagraphBullets');
        expect(bullets).toHaveLength(1);
        expect(bullets[0].createParagraphBullets.bulletPreset).toBe('NUMBERED_DECIMAL_ALPHA_ROMAN');
    });

    it('round-trips a nested ordered list exported by readDocument back into the same range', async () => {
        // The real workflow: read the section as markdown, hand it straight back.
        // #106's marker-width-aware indentation is what makes this hold.
        const nested = [
            { text: 'Roadmap', style: 'HEADING_2' },
            { text: 'one', bullet: { listId: 'list-1', nestingLevel: 0 } },
            { text: 'nested a', bullet: { listId: 'list-1', nestingLevel: 1 } },
            { text: 'nested b', bullet: { listId: 'list-1', nestingLevel: 1 } },
            { text: 'two', bullet: { listId: 'list-1', nestingLevel: 0 } },
        ];
        const body = buildBody(nested);
        const exported = docsJsonToMarkdown({ body, lists: LISTS });
        // The exporter really does produce nested markdown, not a flat list.
        expect(exported).toMatch(/\n\s+1\. nested a/);

        const bounds = boundsOf(nested);
        const { batches } = makeGoogle(body);
        const documentId = `range-roundtrip-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');

        await getTool().execute({
            documentId,
            // The list runs to the end of the body, so the range ends at the last
            // addressable index (the final paragraph mark cannot be deleted).
            target: { startIndex: bounds[1].start, endIndex: bounds[4].end - 1 },
            markdown: exported.split('\n').slice(1).join('\n'),
        }, { log: noopLog });

        // Two nested items go back in as two tab-indented paragraphs under one
        // merged bullet range: the nesting survived the round trip.
        expect(requestsOf(batches, 'insertText').filter((r) => r.insertText.text === '\t')).toHaveLength(2);
        expect(requestsOf(batches, 'createParagraphBullets')).toHaveLength(1);
    });
});

describe('replaceRangeWithMarkdown — insertion mode', () => {
    it('startIndex == endIndex inserts through an owned seam paragraph and removes it', async () => {
        const specs = [
            { text: 'first', bullet: { listId: 'list-1', nestingLevel: 0 } },
            { text: 'second', bullet: { listId: 'list-1', nestingLevel: 0 } },
        ];
        const bounds = boundsOf(specs);
        const at = bounds[1].start;
        const { batches } = makeGoogle(buildBody(specs));
        const documentId = `range-insert-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');

        const output = await getTool().execute({
            documentId,
            target: { startIndex: at, endIndex: at },
            markdown: '## A heading in the middle\n',
        }, { log: noopLog });

        expect(output).toContain(`Inserted `);
        // A one-character seam paragraph is created and neutralized first, so the
        // inserted heading does not join the existing bulleted list...
        const seam = batches[0].requests[0];
        expect(seam.insertText).toEqual({ location: { index: at }, text: '\n' });
        expect(batches[0].requests.some((r) => 'deleteParagraphBullets' in r)).toBe(true);
        // ...and the seam is removed afterwards, exactly one character wide.
        const deletes = requestsOf(batches, 'deleteContentRange');
        expect(deletes).toHaveLength(1);
        const range = deletes[0].deleteContentRange.range;
        expect(range.endIndex - range.startIndex).toBe(1);
    });
});

describe('replaceRangeWithMarkdown — empty sections', () => {
    it('fills an empty section between two headings through the seam, deleting nothing', async () => {
        const specs = [
            { text: 'Roadmap', style: 'HEADING_2' },
            { text: 'Risks', style: 'HEADING_2' },
            { text: 'none' },
        ];
        const bounds = boundsOf(specs);
        const { batches } = makeGoogle(buildBody(specs));
        const documentId = `range-emptysection-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');

        const output = await getTool().execute({
            documentId, target: { afterHeading: 'Roadmap' }, markdown: '- first item\n',
        }, { log: noopLog });

        expect(output).toContain(`Inserted `);
        expect(batches[0].requests[0].insertText).toEqual({ location: { index: bounds[1].start }, text: '\n' });
        const deletes = requestsOf(batches, 'deleteContentRange');
        expect(deletes).toHaveLength(1);
        // Only the seam is removed; the "Risks" section is untouched.
        const range = deletes[0].deleteContentRange.range;
        expect(range.endIndex - range.startIndex).toBe(1);
    });

    it('treats a trailing heading with nothing under it as an append, not a backwards range', async () => {
        const specs = [{ text: 'Body text' }, { text: 'Appendix', style: 'HEADING_2' }];
        const bounds = boundsOf(specs);
        const maxIndex = bounds[1].end - 1;
        makeGoogle(buildBody(specs));
        const documentId = `range-trailingheading-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');

        const output = await getTool().execute({
            documentId, target: { afterHeading: 'Appendix' }, markdown: '- added\n', dryRun: true,
        }, { log: noopLog });

        expect(output).toContain(`Resolved range: ${maxIndex}-${maxIndex}`);
        expect(output).toContain(`Would INSERT`);
    });
});

describe('replaceRangeWithMarkdown — tab-scoped ranges', () => {
    it('resolves the range inside the named tab and stamps tabId on every request', async () => {
        const body = buildBody(SECTIONS);
        const bounds = boundsOf(SECTIONS);
        const { batches } = makeGoogle(body, { tabId: 'tab-42' });
        const documentId = `range-tab-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');

        await getTool().execute({
            documentId,
            tabId: 'tab-42',
            target: { afterHeading: 'Roadmap' },
            markdown: '- replacement\n',
        }, { log: noopLog });

        for (const request of allRequests(batches)) {
            const value = Object.values(request)[0];
            const target = value.range ?? value.location;
            if (target) expect(target.tabId).toBe('tab-42');
        }
        const deletes = requestsOf(batches, 'deleteContentRange');
        expect(deletes[0].deleteContentRange.range.endIndex
            - deletes[0].deleteContentRange.range.startIndex).toBe(bounds[4].start - bounds[1].end);
    });

    it('rejects an unknown tab before touching the document', async () => {
        const { batchUpdate } = makeGoogle(buildBody(SECTIONS), { tabId: 'tab-42' });
        const documentId = `range-badtab-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');

        await expect(getTool().execute({
            documentId,
            tabId: 'nope',
            target: { afterHeading: 'Roadmap' },
            markdown: 'x\n',
        }, { log: noopLog })).rejects.toThrow(/Tab with ID "nope" not found/);
        expect(batchUpdate).not.toHaveBeenCalled();
    });
});

describe('replaceRangeWithMarkdown — error tiers', () => {
    it('refuses an empty replacement and points at deleteRange', async () => {
        makeGoogle(buildBody(SECTIONS));
        const documentId = `range-empty-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');
        await expect(getTool().execute({
            documentId, target: { startIndex: 2, endIndex: 5 }, markdown: '   \n',
        }, { log: noopLog })).rejects.toThrow(/deleteRange/);
    });

    it('rejects a range that runs past the end of the body and names the index read', async () => {
        const { batchUpdate } = makeGoogle(buildBody(SECTIONS));
        const documentId = `range-oob-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');
        const bounds = boundsOf(SECTIONS);
        const past = bounds[bounds.length - 1].end + 50;
        await expect(getTool().execute({
            documentId, target: { startIndex: 2, endIndex: past }, markdown: 'x\n',
        }, { log: noopLog })).rejects.toThrow(/runs past the end.*format='index'/s);
        expect(batchUpdate).not.toHaveBeenCalled();
    });

    it('rejects a range whose boundary falls inside a table, naming the table', async () => {
        const specs = [
            { text: 'Before' },
            { table: { rows: 2, columns: 3, length: 30 } },
            { text: 'After' },
        ];
        const bounds = boundsOf(specs);
        makeGoogle(buildBody(specs));
        const documentId = `range-table-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');
        await expect(getTool().execute({
            documentId,
            target: { startIndex: bounds[1].start + 5, endIndex: bounds[2].start },
            markdown: 'x\n',
        }, { log: noopLog })).rejects.toThrow(/2x3 table at/);
    });

    it('lists the available headings when the heading is not found', async () => {
        makeGoogle(buildBody(SECTIONS));
        const documentId = `range-nohead-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');
        await expect(getTool().execute({
            documentId, target: { afterHeading: 'Nonexistent' }, markdown: 'x\n',
        }, { log: noopLog })).rejects.toThrow(/Headings present:[\s\S]*Roadmap/);
    });

    it('lists candidates when the heading text is ambiguous', async () => {
        const specs = [
            { text: 'Notes', style: 'HEADING_2', headingId: 'h.a' },
            { text: 'a' },
            { text: 'Notes', style: 'HEADING_2', headingId: 'h.b' },
            { text: 'b' },
        ];
        makeGoogle(buildBody(specs));
        const documentId = `range-ambig-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');
        await expect(getTool().execute({
            documentId, target: { afterHeading: 'Notes' }, markdown: 'x\n',
        }, { log: noopLog })).rejects.toThrow(/Found 2 headings matching heading "Notes"[\s\S]*headingId/);
    });

    it('rejects a text-located range that splits a paragraph, and names the whole paragraph', async () => {
        const specs = [{ text: 'Alpha beta gamma' }, { text: 'next' }];
        const bounds = boundsOf(specs);
        makeGoogle(buildBody(specs));
        const documentId = `range-split-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');
        await expect(getTool().execute({
            documentId, target: { textToFind: 'beta' }, markdown: '- x\n',
        }, { log: noopLog })).rejects.toThrow(
            new RegExp(`splits a paragraph[\\s\\S]*${bounds[0].start}-${bounds[0].end}`),
        );
    });

    it('allows the same mid-paragraph range when the caller passes explicit indices', async () => {
        const specs = [{ text: 'Alpha beta gamma' }, { text: 'next' }];
        makeGoogle(buildBody(specs));
        const documentId = `range-split-ok-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');
        const output = await getTool().execute({
            documentId, target: { startIndex: 7, endIndex: 11 }, markdown: 'delta\n', dryRun: true,
        }, { log: noopLog });
        expect(output).toContain('Resolved range: 7-11');
        expect(output).toContain('starts mid-paragraph');
    });

    it('reports a text search miss with the diagnosis, not a bare "not found"', async () => {
        makeGoogle(buildBody(SECTIONS));
        const documentId = `range-nomatch-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');
        await expect(getTool().execute({
            documentId, target: { textToFind: 'nowhere in this document at all' }, markdown: 'x\n',
        }, { log: noopLog })).rejects.toThrow(/Could not find/);
    });
});

describe('replaceRangeWithMarkdown — fidelity is scoped to the range', () => {
    const WITH_IMAGES = [
        { text: 'Title', style: 'HEADING_1' },
        { text: 'diagram', image: 'img-1' },
        { text: 'Roadmap', style: 'HEADING_2' },
        { text: 'plain section body' },
        { text: 'Risks', style: 'HEADING_2' },
        { text: 'another diagram', image: 'img-2' },
    ];

    it('proceeds silently when the range is clean even though the rest of the document is not', async () => {
        const { batchUpdate } = makeGoogle(buildBody(WITH_IMAGES));
        const documentId = `range-clean-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');
        const output = await getTool().execute({
            documentId, target: { afterHeading: 'Roadmap' }, markdown: '- rewritten\n',
        }, { log: noopLog });
        expect(output).not.toMatch(/Fidelity warnings/);
        expect(batchUpdate).toHaveBeenCalled();
    });

    it('blocks by default when the range itself holds an image, naming what would be lost', async () => {
        const { batchUpdate } = makeGoogle(buildBody(WITH_IMAGES));
        const documentId = `range-image-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');
        await expect(getTool().execute({
            documentId, target: { afterHeading: 'Risks' }, markdown: '- rewritten\n',
        }, { log: noopLog })).rejects.toThrow(/cannot represent[\s\S]*image\(s\)/);
        expect(batchUpdate).not.toHaveBeenCalled();
    });

    it("onFidelityLoss:'warn' proceeds and reports the loss", async () => {
        const { batchUpdate } = makeGoogle(buildBody(WITH_IMAGES));
        const documentId = `range-image-warn-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');
        const output = await getTool().execute({
            documentId, target: { afterHeading: 'Risks' }, markdown: '- rewritten\n', onFidelityLoss: 'warn',
        }, { log: noopLog });
        expect(output).toMatch(/Fidelity warnings[\s\S]*image\(s\)/);
        expect(batchUpdate).toHaveBeenCalled();
    });
});

describe('replaceRangeWithMarkdown — dryRun and partial-failure reporting', () => {
    it('dryRun resolves and reports without issuing a single write', async () => {
        const { batchUpdate } = makeGoogle(buildBody(SECTIONS));
        const documentId = `range-dry-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');
        const output = await getTool().execute({
            documentId, target: { afterHeading: 'Roadmap' }, markdown: '- x\n', dryRun: true,
        }, { log: noopLog });
        expect(output).toContain('DRY RUN — nothing was written.');
        expect(output).toContain('Covered elements:');
        expect(batchUpdate).not.toHaveBeenCalled();
    });

    it('a failed delete after a successful insert reports both copies and the exact leftover range', async () => {
        const bounds = boundsOf(SECTIONS);
        const { batches } = makeGoogle(buildBody(SECTIONS), { failDelete: true });
        const documentId = `range-partial-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');
        await expect(getTool().execute({
            documentId, target: { afterHeading: 'Roadmap' }, markdown: '- rewritten\n',
        }, { log: noopLog })).rejects.toThrow(/contains BOTH copies[\s\S]*deleteRange/);

        // The reported leftover range is the one the tool actually asked to delete.
        const attempted = requestsOf(batches, 'deleteContentRange')[0].deleteContentRange.range;
        expect(attempted.endIndex - attempted.startIndex).toBe(bounds[4].start - bounds[1].end);
    });
});

describe('replaceRangeWithMarkdown — WriteControl chain', () => {
    it('carries the tracked revision into the first write and advances it across every batch', async () => {
        const { batches } = makeGoogle(buildBody(SECTIONS));
        const documentId = `range-writecontrol-${Date.now()}`;
        trackRead(documentId, null, '# doc', 'rev-read');

        await getTool().execute({
            documentId, target: { afterHeading: 'Roadmap' }, markdown: '- one\n- two\n',
        }, { log: noopLog });

        expect(batches[0].writeControl).toEqual({ requiredRevisionId: 'rev-read' });
        // Every subsequent batch requires the revision the previous one produced.
        for (let i = 1; i < batches.length; i += 1) {
            expect(batches[i].writeControl).toEqual({ requiredRevisionId: `rev-${i}` });
        }
    });
});
