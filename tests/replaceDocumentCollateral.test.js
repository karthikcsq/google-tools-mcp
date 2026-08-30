// Collateral, dryRun, heading-map and applied-diff coverage for
// replaceDocumentWithMarkdown (issue #88, canonical for #89, #93, #95).
//
// dist/clients.js is the only mock. The markdown importer, the structural
// walker, the collateral scanner, readTracker and the guard all run for real,
// so a batchUpdate reaching the fake Google client means the tool really did
// try to write.
//
// The dryRun assertions are deliberately one-per-step rather than a single
// "nothing was written": the acceptance criterion "dryRun previews" could
// otherwise pass while the destructive whole-body path still deleted the body.
import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), 'gtm-collateral-'));
process.env.GOOGLE_MCP_WORKSPACE_DIR = SANDBOX;

let fakeDocs;
let fakeDrive;
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => fakeDocs,
    getDriveClient: async () => fakeDrive,
    getSheetsClient: async () => { throw new Error('not used'); },
    getCalendarClient: async () => { throw new Error('not used'); },
}));

const { trackRead } = await import('../dist/readTracker.js');
const { register } = await import('../dist/tools/utils/replaceDocumentWithMarkdown.js');

const noopLog = { info() {}, error() {}, warn() {}, debug() {} };

afterAll(async () => {
    await fs.rm(SANDBOX, { recursive: true, force: true });
});

function getTool() {
    const tools = new Map();
    register({ addTool(def) { tools.set(def.name, def); } });
    return tools.get('replaceDocumentWithMarkdown');
}

// --- fixtures ---------------------------------------------------------------

/**
 * Paragraph spec -> body. `link` makes the whole run an in-document heading
 * link; `cellLink` wraps it in a one-cell table so the recursive scan is
 * exercised.
 */
function buildBody(specs) {
    const content = [];
    let index = 1;
    for (const spec of specs) {
        const text = spec.text ?? '';
        const start = index;
        const end = start + text.length + 1;
        const run = {
            startIndex: start,
            endIndex: end,
            textRun: {
                content: `${text}\n`,
                ...(spec.link ? { textStyle: { link: { headingId: spec.link } } } : {}),
            },
        };
        if (spec.cellLink) {
            content.push({
                startIndex: start,
                endIndex: end,
                table: {
                    rows: 1,
                    columns: 1,
                    tableRows: [{
                        tableCells: [{
                            startIndex: start,
                            endIndex: end,
                            content: [{
                                startIndex: start,
                                endIndex: end,
                                paragraph: {
                                    elements: [{
                                        startIndex: start,
                                        endIndex: end,
                                        textRun: { content: `${text}\n`, textStyle: { link: { headingId: spec.cellLink } } },
                                    }],
                                },
                            }],
                        }],
                    }],
                },
            });
            index = end;
            continue;
        }
        const paragraph = { elements: [run] };
        if (spec.style || spec.headingId) {
            paragraph.paragraphStyle = {
                ...(spec.style ? { namedStyleType: spec.style } : {}),
                ...(spec.headingId ? { headingId: spec.headingId } : {}),
            };
        }
        content.push({ startIndex: start, endIndex: end, paragraph });
        index = end;
    }
    return { content };
}

/**
 * Google fake, dispatching `documents.get` on the field mask each call site
 * uses so every read the tool performs is individually observable.
 *
 * `postWriteBody` is what the heading-map read (the only read AFTER the write)
 * sees; everything before it sees `body`.
 */
function makeGoogle(body, {
    comments = [],
    postWriteBody = null,
    tabId = null,
    revisionId = 'rev-read',
    driveHasComments = true,
} = {}) {
    const calls = { structure: 0, link: 0, full: 0, headingMap: 0 };
    const batches = [];
    let wroteAnything = false;

    const scope = (payload) => (tabId
        ? { revisionId, tabs: [{ tabProperties: { tabId }, documentTab: { body: payload } }] }
        : { revisionId, body: payload });

    const documentsGet = jest.fn(async ({ fields }) => {
        if (fields === 'namedStyles') return { data: { namedStyles: { styles: [] } } };
        if (fields === undefined) { calls.full += 1; return { data: scope(body) }; }
        if (fields.includes('headingId')) {
            calls.headingMap += 1;
            return { data: scope(wroteAnything && postWriteBody ? postWriteBody : body) };
        }
        if (fields.includes('textStyle(link)')) { calls.link += 1; return { data: scope(body) }; }
        calls.structure += 1;
        return { data: scope(body) };
    });

    const batchUpdate = jest.fn(async ({ requestBody }) => {
        wroteAnything = true;
        batches.push(requestBody.requests);
        return { data: { writeControl: { requiredRevisionId: `rev-${batches.length}` } } };
    });

    const commentPages = Array.isArray(comments[0]) ? comments : [comments];
    const commentsList = jest.fn(async ({ pageToken }) => {
        const page = pageToken ? Number(pageToken) : 0;
        return {
            data: {
                comments: commentPages[page] ?? [],
                nextPageToken: page + 1 < commentPages.length ? String(page + 1) : undefined,
            },
        };
    });

    fakeDocs = { documents: { get: documentsGet, batchUpdate } };
    fakeDrive = {
        files: { get: async () => ({ data: { modifiedTime: null } }) },
        ...(driveHasComments ? { comments: { list: commentsList } } : {}),
    };
    return { calls, batches, documentsGet, batchUpdate, commentsList };
}

const comment = (id, quote, { resolved = false, author = 'Ada' } = {}) => ({
    id,
    resolved,
    content: `note on ${id}`,
    author: { displayName: author },
    quotedFileContent: { value: quote },
});

const DOC = [
    { text: 'Design Doc', style: 'TITLE', headingId: 'h.title' },
    { text: 'Background section text', style: 'NORMAL_TEXT' },
    { text: 'See the roadmap', link: 'h.roadmap' },
    { text: 'Roadmap', style: 'HEADING_1', headingId: 'h.roadmap' },
    { text: 'Ship it by June', style: 'NORMAL_TEXT' },
];

const requestsOf = (batches, kind) => batches.flat().filter((r) => kind in r);

let counter = 0;
const nextDocId = () => `collateral-doc-${Date.now()}-${counter += 1}`;

// --- dryRun -----------------------------------------------------------------

describe('replaceDocumentWithMarkdown dryRun writes nothing at all', () => {
    it('performs no delete, no survivor cleanup, no insert, no workspace write and no post-write heading fetch', async () => {
        const documentId = nextDocId();
        const { calls, batchUpdate } = makeGoogle(buildBody(DOC), { comments: [comment('c1', 'Ship it by June')] });
        trackRead(documentId, null, 'old', 'rev-read');

        const result = await getTool().execute(
            { documentId, markdown: '# Design Doc\n\nBrand new body.\n', dryRun: true },
            { log: noopLog },
        );

        // Asserted per destructive step, not as one aggregate.
        expect(batchUpdate).not.toHaveBeenCalled();          // no delete, no cleanup, no insert
        expect(calls.headingMap).toBe(0);                     // the heading map is a POST-write read
        await expect(fs.readdir(SANDBOX)).resolves.not.toContain(`${documentId}.md`);
        expect(result).toContain('DRY RUN — nothing was written.');
        expect(result).toContain('No delete, no cleanup, no insert, no local working copy.');
    });

    it('returns a proposed-vs-current unified diff and an explicit deletion summary', async () => {
        const documentId = nextDocId();
        makeGoogle(buildBody(DOC), { comments: [] });
        trackRead(documentId, null, 'old', 'rev-read');

        const result = await getTool().execute(
            { documentId, markdown: '# Design Doc\n\nBrand new body.\n', dryRun: true },
            { log: noopLog },
        );

        expect(result).toContain('--- DIFF (current → proposed) ---');
        expect(result).toContain('+Brand new body.');
        expect(result).toContain('-Ship it by June');
        expect(result).toMatch(/Deletion summary: \d+ character\(s\) of the document body are deleted \(range 1-\d+\)/);
        expect(result).toContain('the entire body');
        expect(result).toContain('characters of markdown.');
    });
});

// --- comment anchors (#93) ---------------------------------------------------

describe('unresolved comment anchors are named before the body is deleted', () => {
    it('names the unresolved comments and excludes the resolved one', async () => {
        const documentId = nextDocId();
        makeGoogle(buildBody(DOC), {
            comments: [
                comment('c-unresolved-1', 'Background section text'),
                comment('c-unresolved-2', 'Ship it by June'),
                comment('c-resolved', 'Design Doc', { resolved: true }),
            ],
        });
        trackRead(documentId, null, 'old', 'rev-read');

        const result = await getTool().execute(
            { documentId, markdown: '# New\n\nbody\n', dryRun: true },
            { log: noopLog },
        );

        expect(result).toContain('2 unresolved comment anchor(s) will be removed');
        expect(result).toContain('comment c-unresolved-1 by Ada on "Background section text"');
        expect(result).toContain('comment c-unresolved-2 by Ada on "Ship it by June"');
        expect(result).not.toContain('c-resolved');
    });

    it("onCollateral:'block' refuses the write and lists what it would have damaged", async () => {
        const documentId = nextDocId();
        const { batchUpdate } = makeGoogle(buildBody(DOC), { comments: [comment('c1', 'Ship it by June')] });
        trackRead(documentId, null, 'old', 'rev-read');

        let thrown;
        try {
            await getTool().execute(
                { documentId, markdown: '# New\n\nbody\n', onCollateral: 'block' },
                { log: noopLog },
            );
        } catch (error) { thrown = error; }

        expect(thrown).toBeDefined();
        expect(thrown.message).toContain('refused because onCollateral is set to "block"');
        expect(thrown.message).toContain('comment c1');
        expect(thrown.message).toContain('batchModifyText');
        expect(batchUpdate).not.toHaveBeenCalled();
    });

    it('follows nextPageToken and reports EVERY unresolved comment, not just the first page', async () => {
        const documentId = nextDocId();
        // 120 comments across two pages. The hardcoded pageSize:100 of the
        // interactive listComments tool would have silently reported 100.
        const quotes = Array.from({ length: 120 }, (_, i) => `quote-${String(i).padStart(3, '0')}`);
        const body = buildBody([{ text: quotes.join(' ') }]);
        const pages = [
            quotes.slice(0, 100).map((q, i) => comment(`c${i}`, q)),
            quotes.slice(100).map((q, i) => comment(`c${100 + i}`, q)),
        ];
        const { commentsList } = makeGoogle(body, { comments: pages });
        trackRead(documentId, null, 'old', 'rev-read');

        const result = await getTool().execute(
            { documentId, markdown: 'replacement\n', dryRun: true },
            { log: noopLog },
        );

        expect(commentsList).toHaveBeenCalledTimes(2);
        expect(result).toContain('120 unresolved comment anchor(s) will be removed');
        expect(result).toContain('… and 95 more');
    });

    it('reports a quote occurring on BOTH sides of a preserveTitle split as only MAYBE affected', async () => {
        const documentId = nextDocId();
        // "shared phrase" appears in the preserved title paragraph AND below it,
        // and Drive exposes the quote rather than the live anchor range.
        const body = buildBody([
            { text: 'Title with shared phrase', style: 'TITLE' },
            { text: 'Body also has shared phrase in it' },
        ]);
        makeGoogle(body, { comments: [comment('c-ambiguous', 'shared phrase')] });
        trackRead(documentId, null, 'old', 'rev-read');

        const result = await getTool().execute(
            { documentId, markdown: 'new body\n', preserveTitle: true, dryRun: true },
            { log: noopLog },
        );

        expect(result).toContain('1 unresolved comment anchor(s) MAY be removed');
        expect(result).toContain('over-report by design');
        expect(result).toContain('c-ambiguous');
        expect(result).toContain('preserving the first paragraph as the title');
    });

    it('reports a comment whose quote no longer matches the document as unlocatable', async () => {
        const documentId = nextDocId();
        makeGoogle(buildBody(DOC), { comments: [comment('c-stale', 'text that is not in the document')] });
        trackRead(documentId, null, 'old', 'rev-read');

        const result = await getTool().execute({ documentId, markdown: 'x\n', dryRun: true }, { log: noopLog });
        expect(result).toContain('1 unresolved comment(s) could not be located');
        expect(result).toContain('c-stale');
    });

    it("degrades to a stated warning under 'warn' when comments cannot be listed, and refuses under 'block'", async () => {
        const documentId = nextDocId();
        makeGoogle(buildBody(DOC), { driveHasComments: false });
        trackRead(documentId, null, 'old', 'rev-read');

        const warned = await getTool().execute({ documentId, markdown: 'x\n', dryRun: true }, { log: noopLog });
        expect(warned).toContain('Comment-anchor check UNAVAILABLE');

        const documentId2 = nextDocId();
        makeGoogle(buildBody(DOC), { driveHasComments: false });
        trackRead(documentId2, null, 'old', 'rev-read');
        await expect(getTool().execute(
            { documentId: documentId2, markdown: 'x\n', onCollateral: 'block' },
            { log: noopLog },
        )).rejects.toThrow(/UNAVAILABLE/);
    });

    it('says so plainly when there is no collateral at all', async () => {
        const documentId = nextDocId();
        makeGoogle(buildBody([{ text: 'plain text only' }]), { comments: [] });
        trackRead(documentId, null, 'old', 'rev-read');

        const result = await getTool().execute({ documentId, markdown: 'x\n', dryRun: true }, { log: noopLog });
        expect(result).toContain('no unresolved comment anchors and no in-document heading links are affected');
    });
});

// --- heading links (#95) -----------------------------------------------------

describe('in-document heading links are detected before the ids are regenerated', () => {
    it('warns with the link text and the old target', async () => {
        const documentId = nextDocId();
        makeGoogle(buildBody(DOC), { comments: [] });
        trackRead(documentId, null, 'old', 'rev-read');

        const result = await getTool().execute({ documentId, markdown: 'x\n', dryRun: true }, { log: noopLog });
        expect(result).toContain('1 in-document link(s) point at heading ids');
        expect(result).toContain('"See the roadmap" -> h.roadmap');
        expect(result).toContain('will all be regenerated by this replace');
    });

    it('finds a heading link inside a TABLE CELL', async () => {
        const documentId = nextDocId();
        const body = buildBody([
            { text: 'intro' },
            { text: 'link from a table', cellLink: 'h.buried' },
        ]);
        makeGoogle(body, { comments: [] });
        trackRead(documentId, null, 'old', 'rev-read');

        const result = await getTool().execute({ documentId, markdown: 'x\n', dryRun: true }, { log: noopLog });
        expect(result).toContain('"link from a table" -> h.buried (inside a table)');
    });

    it('draws collateral from the TAB body, not the default body', async () => {
        const documentId = nextDocId();
        const tabBody = buildBody([{ text: 'tab link here', link: 'h.tabonly' }]);
        makeGoogle(tabBody, { comments: [], tabId: 'tab-7' });
        trackRead(documentId, null, 'old', 'rev-read');

        const result = await getTool().execute(
            { documentId, tabId: 'tab-7', markdown: 'x\n', dryRun: true },
            { log: noopLog },
        );
        expect(result).toContain('"tab link here" -> h.tabonly');
        expect(result).toContain('tab "tab-7"');
    });
});

// --- post-write heading map and applied diff --------------------------------

describe('a real write reports what it did', () => {
    it('returns the post-write heading map from a narrow mask, with new ids', async () => {
        const documentId = nextDocId();
        const postWriteBody = buildBody([
            { text: 'Fresh Title', style: 'TITLE', headingId: 'h.new-title' },
            { text: 'Fresh Section', style: 'HEADING_1', headingId: 'h.new-section' },
            { text: 'Unanchored', style: 'HEADING_2' },
        ]);
        const { calls, documentsGet, batchUpdate } = makeGoogle(buildBody(DOC), { comments: [], postWriteBody });
        trackRead(documentId, null, 'old', 'rev-read');

        const result = await getTool().execute(
            { documentId, markdown: '# Fresh Title\n\n# Fresh Section\n\n## Unanchored\n' },
            { log: noopLog },
        );

        expect(batchUpdate).toHaveBeenCalled();
        expect(calls.headingMap).toBe(1);
        const mask = documentsGet.mock.calls.map((c) => c[0].fields).find((f) => f?.includes('headingId'));
        expect(mask).not.toBe('*');
        expect(mask).not.toContain('table');

        expect(result).toContain('Post-write heading map (3 heading(s))');
        expect(result).toContain('-> h.new-title');
        expect(result).toContain('-> h.new-section');
        expect(result).toContain('(no headingId yet');
    });

    it('returns the applied diff alongside the success message', async () => {
        const documentId = nextDocId();
        makeGoogle(buildBody(DOC), { comments: [] });
        trackRead(documentId, null, 'old', 'rev-read');

        const result = await getTool().execute(
            { documentId, markdown: '# Design Doc\n\nCompletely different body.\n' },
            { log: noopLog },
        );

        expect(result).toContain('Successfully replaced document content');
        expect(result).toContain('--- APPLIED DIFF (before → after) ---');
        expect(result).toContain('+Completely different body.');
        expect(result).toContain('-Ship it by June');
    });

    it('still deletes and inserts once collateral is only warned about', async () => {
        const documentId = nextDocId();
        const { batches } = makeGoogle(buildBody(DOC), { comments: [comment('c1', 'Ship it by June')] });
        trackRead(documentId, null, 'old', 'rev-read');

        const result = await getTool().execute(
            { documentId, markdown: '# New\n\nbody\n', onCollateral: 'warn' },
            { log: noopLog },
        );

        expect(requestsOf(batches, 'deleteContentRange')).not.toHaveLength(0);
        expect(requestsOf(batches, 'insertText')).not.toHaveLength(0);
        expect(result).toContain('1 unresolved comment anchor(s) will be removed');
        expect(result).toContain('Successfully replaced document content');
    });
});
