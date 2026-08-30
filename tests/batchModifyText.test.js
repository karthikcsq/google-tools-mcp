// Coverage for batchModifyText (issue #88, canonical for #89).
//
// dist/clients.js is the only mock: the snapshot resolver, the overlap checker,
// the request builder shared with modifyText, readTracker and the read-handle
// guard all run for real. What these tests pin is the atomicity/ordering
// contract the tool sells — one snapshot, no overlaps, descending application,
// one batch, never split — plus the dryRun preview contract, where a formatting
// -only batch has to preview as something other than "no change".
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
const { register, findOverlap, applyTextOperations, buildTextImage, MAX_REQUESTS } =
    await import('../dist/tools/docs/batchModifyText.js');
const { buildModifyTextRequests } = await import('../dist/tools/docs/modifyText.js');
const GDocsHelpers = await import('../dist/googleDocsApiHelpers.js');

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
    return server.getTool('batchModifyText');
}

/** Body from a list of paragraph texts. Each occupies [start, start+len+1). */
function buildBody(texts) {
    const content = [];
    let index = 1;
    for (const text of texts) {
        const start = index;
        const end = start + text.length + 1;
        content.push({
            startIndex: start,
            endIndex: end,
            paragraph: { elements: [{ startIndex: start, endIndex: end, textRun: { content: `${text}\n` } }] },
        });
        index = end;
    }
    return { content };
}

/** Document index range covering `needle` inside paragraph `i` of `texts`. */
function rangeOf(texts, i, needle) {
    let start = 1;
    for (let k = 0; k < i; k += 1) start += texts[k].length + 1;
    const offset = texts[i].indexOf(needle);
    return { startIndex: start + offset, endIndex: start + offset + needle.length };
}

function makeGoogle(body, { revisionId = 'rev-read', tabId = null, color = null } = {}) {
    const batches = [];
    const documentsGet = jest.fn(async ({ fields, includeTabsContent }) => {
        if (fields === 'namedStyles') {
            return {
                data: {
                    namedStyles: {
                        styles: color
                            ? [{ namedStyleType: 'NORMAL_TEXT', textStyle: { foregroundColor: { color: { rgbColor: color } } } }]
                            : [],
                    },
                },
            };
        }
        if (includeTabsContent) {
            return {
                data: {
                    revisionId,
                    tabs: [{ tabProperties: { tabId: tabId ?? 'tab-1' }, documentTab: { body } }],
                },
            };
        }
        return { data: { revisionId, body } };
    });
    const batchUpdate = jest.fn(async ({ requestBody }) => {
        batches.push({ requests: requestBody.requests, writeControl: requestBody.writeControl });
        return { data: { writeControl: { requiredRevisionId: `rev-${batches.length}` } } };
    });
    fakeDocs = { documents: { get: documentsGet, batchUpdate } };
    fakeDrive = { files: { get: async () => ({ data: { modifiedTime: null } }) } };
    return { batches, documentsGet, batchUpdate };
}

const TEXTS = ['Alpha one', 'Beta two', 'Gamma three'];

let docCounter = 0;
const nextDocId = () => `batch-doc-${Date.now()}-${docCounter += 1}`;

describe('batchModifyText — atomicity and ordering contract', () => {
    it('applies three ascending-position edits in ONE batch, highest index first', async () => {
        const documentId = nextDocId();
        const { batches, batchUpdate } = makeGoogle(buildBody(TEXTS));
        trackRead(documentId, null, 'old', 'rev-read');

        await getTool().execute({
            documentId,
            operations: [
                { target: rangeOf(TEXTS, 0, 'one'), text: 'ONE' },
                { target: rangeOf(TEXTS, 1, 'two'), text: 'TWO' },
                { target: rangeOf(TEXTS, 2, 'three'), text: 'THREE' },
            ],
        }, { log: noopLog });

        expect(batchUpdate).toHaveBeenCalledTimes(1);
        const requests = batches[0].requests;
        // Every delete carries a strictly decreasing startIndex: that is what
        // makes all three callers' indices simultaneously valid.
        const deleteStarts = requests
            .filter((r) => r.deleteContentRange)
            .map((r) => r.deleteContentRange.range.startIndex);
        expect(deleteStarts).toEqual([...deleteStarts].sort((a, b) => b - a));
        expect(deleteStarts).toHaveLength(3);
        expect(deleteStarts[0]).toBeGreaterThan(deleteStarts[1]);
        expect(deleteStarts[1]).toBeGreaterThan(deleteStarts[2]);
    });

    it('sends the whole batch under one writeControl from the guard', async () => {
        const documentId = nextDocId();
        const { batches } = makeGoogle(buildBody(TEXTS));
        trackRead(documentId, null, 'old', 'rev-read');

        await getTool().execute({
            documentId,
            operations: [
                { target: rangeOf(TEXTS, 0, 'one'), text: 'ONE' },
                { target: rangeOf(TEXTS, 2, 'three'), text: 'THREE' },
            ],
        }, { log: noopLog });

        expect(batches).toHaveLength(1);
        expect(batches[0].writeControl).toEqual({ requiredRevisionId: 'rev-read' });
    });

    it('rejects overlapping operations by name, before any write', async () => {
        const documentId = nextDocId();
        const { batchUpdate } = makeGoogle(buildBody(TEXTS));
        trackRead(documentId, null, 'old', 'rev-read');

        const first = rangeOf(TEXTS, 0, 'Alpha one');
        const second = rangeOf(TEXTS, 0, 'one');
        await expect(getTool().execute({
            documentId,
            operations: [
                { target: first, text: 'X', label: 'headline' },
                { target: second, text: 'Y', label: 'word' },
            ],
        }, { log: noopLog })).rejects.toThrow(/operation 1 \("headline"\).*operation 2 \("word"\).*ranges overlap/s);

        expect(batchUpdate).not.toHaveBeenCalled();
    });

    it('rejects an insertion point that lands inside another operation\'s range', async () => {
        const documentId = nextDocId();
        makeGoogle(buildBody(TEXTS));
        trackRead(documentId, null, 'old', 'rev-read');

        const range = rangeOf(TEXTS, 0, 'Alpha one');
        await expect(getTool().execute({
            documentId,
            operations: [
                { target: range, text: 'X' },
                { target: { insertionIndex: range.startIndex + 2 }, text: 'Y' },
            ],
        }, { log: noopLog })).rejects.toThrow(/inserts text inside the range the other replaces/);
    });

    // Fix 8: an insertion point exactly AT a range operation's startIndex
    // used to be accepted, but after sorting both land at the same index and
    // caller order silently decides which text comes first — exactly the
    // ambiguity the overlap contract exists to reject. The boundary at
    // endIndex stays legal (covered by the "touch at a boundary" test above).
    it('rejects an insertion point exactly at a range operation\'s startIndex, by name', async () => {
        const documentId = nextDocId();
        const { batchUpdate } = makeGoogle(buildBody(TEXTS));
        trackRead(documentId, null, 'old', 'rev-read');

        const range = rangeOf(TEXTS, 0, 'one'); // e.g. startIndex 10, endIndex 20-ish
        await expect(getTool().execute({
            documentId,
            operations: [
                { target: range, text: 'REPLACED', label: 'range-op' },
                { target: { insertionIndex: range.startIndex }, text: 'X', label: 'point-op' },
            ],
        }, { log: noopLog })).rejects.toThrow(/operation 1 \("range-op"\).*operation 2 \("point-op"\)/s);

        expect(batchUpdate).not.toHaveBeenCalled();
    });

    it('allows two edits that merely touch at a boundary', async () => {
        const documentId = nextDocId();
        const { batchUpdate } = makeGoogle(buildBody(TEXTS));
        trackRead(documentId, null, 'old', 'rev-read');

        const a = rangeOf(TEXTS, 0, 'Alpha');
        const b = { startIndex: a.endIndex, endIndex: a.endIndex + 4 };
        await getTool().execute({
            documentId,
            operations: [{ target: a, text: 'A' }, { target: b, text: 'B' }],
        }, { log: noopLog });
        expect(batchUpdate).toHaveBeenCalledTimes(1);
    });

    it('refuses rather than splits when the batch exceeds the request cap', async () => {
        const documentId = nextDocId();
        // 81 operations x 5 requests each (delete, insert, default-colour
        // paint, text style, paragraph style) = 405, just over the cap.
        const texts = Array.from({ length: 90 }, (_, i) => `Line ${String(i).padStart(3, '0')} body`);
        const { batchUpdate } = makeGoogle(buildBody(texts), { color: { red: 0.1 } });
        trackRead(documentId, null, 'old', 'rev-read');

        const operations = Array.from({ length: 81 }, (_, i) => ({
            target: rangeOf(texts, i, 'body'),
            text: 'BODY',
            style: { bold: true },
            paragraphStyle: { alignment: 'CENTER' },
        }));

        let thrown;
        try {
            await getTool().execute({ documentId, operations }, { log: noopLog });
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeDefined();
        expect(thrown.message).toContain(`above this tool's limit of ${MAX_REQUESTS}`);
        expect(thrown.message).toContain('never split');
        // Fix 8: the real per-operation max is five requests (delete, insert,
        // default-colour paint, text style, paragraph style) — the message
        // used to undercount it at four.
        expect(thrown.message).toContain('up to five requests');
        expect(thrown.message).not.toContain('up to four requests');
        expect(batchUpdate).not.toHaveBeenCalled();
    });
});

describe('batchModifyText — request parity with modifyText', () => {
    it('emits exactly the requests buildModifyTextRequests produces per operation', async () => {
        const documentId = nextDocId();
        const { batches } = makeGoogle(buildBody(TEXTS), { color: { red: 0.2, green: 0.2, blue: 0.2 } });
        trackRead(documentId, null, 'old', 'rev-read');

        const target = rangeOf(TEXTS, 1, 'Beta two');
        await getTool().execute({
            documentId,
            operations: [{ target, text: 'Beta TWO', style: { bold: true }, paragraphStyle: { alignment: 'CENTER' } }],
        }, { log: noopLog });

        const expected = buildModifyTextRequests({
            startIndex: target.startIndex,
            endIndex: target.endIndex,
            text: 'Beta TWO',
            style: { bold: true },
            paragraphStyle: { alignment: 'CENTER' },
            tabId: undefined,
            defaultColor: { red: 0.2, green: 0.2, blue: 0.2 },
        });
        expect(batches[0].requests).toEqual(expected);
    });

    it('normalizes literal \\n and \\t exactly as modifyText does', async () => {
        const documentId = nextDocId();
        const { batches } = makeGoogle(buildBody(TEXTS));
        trackRead(documentId, null, 'old', 'rev-read');

        const target = rangeOf(TEXTS, 0, 'Alpha one');
        await getTool().execute({
            documentId,
            operations: [{ target, text: 'first\\nsecond\\tindented' }],
        }, { log: noopLog });

        const inserted = batches[0].requests.find((r) => r.insertText).insertText.text;
        expect(inserted).toBe('first\nsecond\tindented');
        expect(inserted).not.toContain('\\n');
    });
});

describe('batchModifyText — snapshot target resolution', () => {
    it('findTextRangeInDoc matches findTextRange across the whole fallback chain', async () => {
        // Exact, markdown-list-marker-stripped, and unicode-normalized fixtures:
        // the three strategies findTextRange falls through. A snapshot resolver
        // that only did exact matching would pass a naive test and silently
        // change behavior for every real caller.
        const fixtures = [
            { texts: ['Plain exact line'], search: 'exact line' },
            { texts: ['bullet item text'], search: '- bullet item text' },
            { texts: ['smart ‘quoted’ words'], search: "smart 'quoted' words" },
            { texts: ['dash — separated'], search: 'dash -- separated' },
        ];
        for (const fixture of fixtures) {
            const body = buildBody(fixture.texts);
            makeGoogle(body);
            const viaFetch = await GDocsHelpers.findTextRange(fakeDocs, 'doc-parity', fixture.search, undefined, undefined);
            const viaSnapshot = GDocsHelpers.findTextRangeInDoc({ body }, fixture.search, undefined, undefined);
            expect(viaSnapshot).toEqual(viaFetch);
            expect(viaSnapshot.startIndex).toBeGreaterThan(0);
        }
    });

    it('resolves a textToFind operation against the requested TAB, not the default body', async () => {
        const documentId = nextDocId();
        const tabId = 'tab-target';
        const tabTexts = ['Only in the tab'];
        const body = buildBody(tabTexts);
        const batches = [];
        // The default body holds DIFFERENT text at different indices. A resolver
        // that ignored tabId would either miss or hit the wrong index.
        const defaultBody = buildBody(['padding padding padding padding', 'Only in the tab']);
        fakeDocs = {
            documents: {
                get: jest.fn(async ({ fields, includeTabsContent }) => {
                    if (fields === 'namedStyles') return { data: { namedStyles: { styles: [] } } };
                    if (includeTabsContent) {
                        return { data: { revisionId: 'rev-read', tabs: [{ tabProperties: { tabId }, documentTab: { body } }] } };
                    }
                    return { data: { revisionId: 'rev-read', body: defaultBody } };
                }),
                batchUpdate: jest.fn(async ({ requestBody }) => {
                    batches.push(requestBody.requests);
                    return { data: { writeControl: { requiredRevisionId: 'rev-1' } } };
                }),
            },
        };
        fakeDrive = { files: { get: async () => ({ data: { modifiedTime: null } }) } };
        trackRead(documentId, null, 'old', 'rev-read');

        await getTool().execute({
            documentId,
            tabId,
            operations: [{ target: { textToFind: 'Only in the tab' }, text: 'REPLACED' }],
        }, { log: noopLog });

        const del = batches[0].find((r) => r.deleteContentRange).deleteContentRange.range;
        expect(del.startIndex).toBe(1); // tab-local index, not the default body's 33
        expect(del.tabId).toBe(tabId);
    });

    it('names the operation when its text search finds nothing', async () => {
        const documentId = nextDocId();
        makeGoogle(buildBody(TEXTS));
        trackRead(documentId, null, 'old', 'rev-read');

        await expect(getTool().execute({
            documentId,
            operations: [
                { target: rangeOf(TEXTS, 0, 'Alpha'), text: 'A' },
                { target: { textToFind: 'nowhere in this document at all' }, text: 'B', label: 'missing' },
            ],
        }, { log: noopLog })).rejects.toThrow(/Operation 2 \("missing"\)/);
    });
});

describe('batchModifyText — dryRun preview contract', () => {
    it('writes nothing and returns a proposed-vs-current diff for text operations', async () => {
        const documentId = nextDocId();
        const { batchUpdate } = makeGoogle(buildBody(TEXTS));
        trackRead(documentId, null, 'old', 'rev-read');

        const result = await getTool().execute({
            documentId,
            dryRun: true,
            operations: [
                { target: rangeOf(TEXTS, 0, 'one'), text: 'ONE' },
                { target: rangeOf(TEXTS, 2, 'three'), text: 'THREE' },
            ],
        }, { log: noopLog });

        expect(batchUpdate).not.toHaveBeenCalled();
        expect(result).toContain('DRY RUN — nothing was written.');
        expect(result).toContain('--- DIFF (current → proposed) ---');
        expect(result).toContain('-Alpha one');
        expect(result).toContain('+Alpha ONE');
        expect(result).toContain('+Gamma THREE');
        expect(result).toContain('Deletion summary: 8 character(s) removed across 2 operation(s)');
    });

    it('previews a FORMATTING-ONLY batch structurally, with an explicitly empty diff', async () => {
        const documentId = nextDocId();
        const { batchUpdate } = makeGoogle(buildBody(TEXTS));
        trackRead(documentId, null, 'old', 'rev-read');

        const result = await getTool().execute({
            documentId,
            dryRun: true,
            operations: [
                { target: rangeOf(TEXTS, 0, 'Alpha'), style: { bold: true }, label: 'bolden' },
                { target: rangeOf(TEXTS, 1, 'Beta'), paragraphStyle: { namedStyleType: 'HEADING_2' } },
            ],
        }, { log: noopLog });

        expect(batchUpdate).not.toHaveBeenCalled();
        // The half that would be empty...
        expect(result).toContain('every operation in this batch is formatting-only');
        expect(result).not.toContain('--- DIFF');
        // ...is carried by the half that is not.
        expect(result).toContain('operation 1 ("bolden") — style at');
        expect(result).toContain('text style: bold=true');
        expect(result).toContain('paragraph style: namedStyleType="HEADING_2"');
        expect(result).toContain('Deletion summary: nothing is removed.');
    });

    it('reports the deletion summary for a delete-only operation', async () => {
        const documentId = nextDocId();
        makeGoogle(buildBody(TEXTS));
        trackRead(documentId, null, 'old', 'rev-read');

        const result = await getTool().execute({
            documentId,
            dryRun: true,
            operations: [{ target: rangeOf(TEXTS, 1, 'Beta two'), text: '' }],
        }, { log: noopLog });

        expect(result).toContain('delete at');
        expect(result).toContain('removes 8 char(s): "Beta two"');
        expect(result).toContain('inserts nothing (delete only)');
    });

    it('a real write returns the SAME summary and diff, labelled as applied', async () => {
        const documentId = nextDocId();
        const operations = [
            { target: rangeOf(TEXTS, 0, 'one'), text: 'ONE' },
            { target: rangeOf(TEXTS, 2, 'three'), text: 'THREE' },
        ];

        makeGoogle(buildBody(TEXTS));
        trackRead(documentId, null, 'old', 'rev-read');
        const preview = await getTool().execute({ documentId, dryRun: true, operations }, { log: noopLog });

        const documentId2 = nextDocId();
        makeGoogle(buildBody(TEXTS));
        trackRead(documentId2, null, 'old', 'rev-read');
        const applied = await getTool().execute({ documentId: documentId2, operations }, { log: noopLog });

        expect(applied).toContain('Applied 2 operation(s) in one atomic batchUpdate');
        expect(applied).toContain('--- APPLIED DIFF (before → after) ---');
        const opLines = (text) => text.split('\n').filter((line) => line.startsWith('operation ')).join('\n');
        expect(opLines(applied)).toBe(opLines(preview));
        expect(applied).toContain('+Alpha ONE');
    });
});

describe('batchModifyText — pure helpers', () => {
    it('findOverlap treats two insertions at the same index as ambiguous', () => {
        const ops = [
            { position: 1, startIndex: 5, endIndex: undefined, source: { target: { insertionIndex: 5 } } },
            { position: 2, startIndex: 5, endIndex: undefined, source: { target: { insertionIndex: 5 } } },
        ];
        expect(findOverlap(ops)?.reason).toMatch(/same index/);
    });

    it('findOverlap allows two insertions at different indices', () => {
        const ops = [
            { position: 1, startIndex: 5, endIndex: undefined, source: { target: { insertionIndex: 5 } } },
            { position: 2, startIndex: 9, endIndex: undefined, source: { target: { insertionIndex: 9 } } },
        ];
        expect(findOverlap(ops)).toBeNull();
    });

    it('findOverlap rejects an insertion point exactly at a range\'s startIndex (#fix8)', () => {
        const ops = [
            { position: 1, startIndex: 10, endIndex: 20, source: { target: { startIndex: 10, endIndex: 20 } } },
            { position: 2, startIndex: 10, endIndex: undefined, source: { target: { insertionIndex: 10 } } },
        ];
        expect(findOverlap(ops)?.reason).toMatch(/inserts text inside the range/);
    });

    it('findOverlap still allows an insertion point exactly at a range\'s endIndex', () => {
        const ops = [
            { position: 1, startIndex: 10, endIndex: 20, source: { target: { startIndex: 10, endIndex: 20 } } },
            { position: 2, startIndex: 20, endIndex: undefined, source: { target: { insertionIndex: 20 } } },
        ];
        expect(findOverlap(ops)).toBeNull();
    });

    it('applyTextOperations in descending order leaves lower indices untouched', () => {
        const image = buildTextImage([{ start: 1, text: 'abcdefghij' }]);
        const ops = [
            { startIndex: 7, endIndex: 9, text: 'XY' },
            { startIndex: 2, endIndex: 4, text: 'Z' },
        ];
        const out = applyTextOperations(image, ops).map((e) => e.ch).join('');
        expect(out).toBe('aZdefXYij');
    });
});
