// Issue #108 end-to-end: the conflict guard is range-precise and explains
// itself. Driven through the REAL SDK v2 facade over real wire requests with
// only dist/clients.js mocked, exactly like
// tests/batchModifyTextHandleIntegration.test.js.
//
// The scenario every case shares: a caller reads the document (minting a read
// handle bound to revision A), a collaborator then changes the document
// (revision B), and the caller's write arrives afterwards. Before #108 the
// answer was always "conflict". These cases pin what the answer is now, per
// target kind and per kind of change.
import { describe, expect, it, jest, beforeEach, afterEach, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const WORKSPACE_ROOT = path.join(os.tmpdir(), `gt-mcp-108-${process.pid}-${Date.now()}`);
process.env.GOOGLE_MCP_WORKSPACE_DIR = WORKSPACE_ROOT;

const TOKEN = 'conflict-precision-token-cccccccccccc';
const DOC_ID = 'precision-doc';

let fakeDocs;
let fakeDrive;
const unusedClient = async () => { throw new Error('client not used in this suite'); };
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => fakeDocs,
    getDriveClient: async () => fakeDrive,
    getSheetsClient: unusedClient,
    getAuthClient: unusedClient,
    getAuthClientIfReady: () => null,
    getCalendarClient: unusedClient,
    getFormsClient: unusedClient,
    getGmailClient: unusedClient,
    getScriptClient: unusedClient,
    getSlidesClient: unusedClient,
    getTasksClient: unusedClient,
    resetClients: () => {},
    withAuthRetry: (fn) => fn(),
}));

const { createV2HttpHandler, prepareMcpServerFactory, MCP_PROTOCOL_VERSION } = await import('../dist/mcpServer.js');
const { register: registerReadDocument } = await import('../dist/tools/docs/readGoogleDoc.js');
const { register: registerModifyText } = await import('../dist/tools/docs/modifyText.js');
const { register: registerBatchModifyText } = await import('../dist/tools/docs/batchModifyText.js');
const { register: registerDeleteRange } = await import('../dist/tools/docs/deleteRange.js');
const { register: registerFindAndReplace } = await import('../dist/tools/docs/findAndReplace.js');
const { resetHandleRuntimeState } = await import('../dist/handleRuntime.js');

// --- the mutable document ---------------------------------------------------

const INITIAL = ['Alpha one\n', 'Beta two\n', 'Gamma three\n'];
// Indices in the document as READ: "Beta two" is the second paragraph.
const READ_BETA_START = 1 + INITIAL[0].length;
const READ_TWO = { startIndex: READ_BETA_START + 'Beta '.length, endIndex: READ_BETA_START + 'Beta two'.length };
const READ_ONE = { startIndex: 1 + 'Alpha '.length, endIndex: 1 + 'Alpha one'.length };

let paragraphs;
let extraElements;
let revision;
let batchUpdate;

function bodyContent() {
    const content = [];
    let index = 1;
    for (const text of paragraphs) {
        content.push({
            startIndex: index,
            endIndex: index + text.length,
            paragraph: { elements: [{ startIndex: index, endIndex: index + text.length, textRun: { content: text } }] },
        });
        index += text.length;
    }
    for (const make of extraElements) {
        content.push(make(index));
        index += 20;
    }
    return content;
}

function setUpGoogleMocks() {
    paragraphs = [...INITIAL];
    extraElements = [];
    revision = 'rev-A';
    fakeDocs = {
        documents: {
            get: jest.fn(async ({ fields }) => {
                if (fields === 'namedStyles') return { data: { namedStyles: { styles: [] } } };
                if (fields === 'revisionId') return { data: { revisionId: revision } };
                // A format='text' read really does fetch a mask with no
                // startIndex/endIndex anywhere, and the guard's ability to
                // classify later depends on that difference, so the fake honors
                // it instead of always returning the full shape.
                if (typeof fields === 'string' && fields.includes('textRun(content)') && !fields.includes('startIndex')) {
                    return {
                        data: {
                            revisionId: revision,
                            body: { content: bodyContent().map((element) => (element.paragraph
                                ? { paragraph: { elements: element.paragraph.elements.map((pe) => ({ textRun: pe.textRun })) } }
                                : element)) },
                        },
                    };
                }
                return { data: { revisionId: revision, body: { content: bodyContent() }, lists: {} } };
            }),
            batchUpdate: jest.fn(async () => ({ data: { writeControl: { requiredRevisionId: 'rev-after-write' } } })),
        },
    };
    batchUpdate = fakeDocs.documents.batchUpdate;
    fakeDrive = { files: { get: async () => ({ data: { modifiedTime: null } }) } };
}

/** What a collaborator did between the caller's read and the caller's write. */
const collaborator = {
    insertsParagraphAbove() { paragraphs = ['Zero inserted\n', ...paragraphs]; revision = 'rev-B'; },
    appendsParagraphBelow() { paragraphs = [...paragraphs, 'Delta four\n']; revision = 'rev-B'; },
    rewritesTargetLine() { paragraphs[1] = 'Beta two plus more\n'; revision = 'rev-B'; },
    rewritesFirstLine() { paragraphs[0] = 'Alpha one edited\n'; revision = 'rev-B'; },
    addsTable() {
        extraElements = [(start) => ({
            startIndex: start,
            endIndex: start + 20,
            table: {
                rows: 1,
                columns: 1,
                tableRows: [{
                    tableCells: [{
                        startIndex: start + 1,
                        endIndex: start + 19,
                        content: [{
                            startIndex: start + 2,
                            endIndex: start + 8,
                            paragraph: { elements: [{ startIndex: start + 2, endIndex: start + 8, textRun: { content: 'cell\n' } }] },
                        }],
                    }],
                }],
            },
        })];
        revision = 'rev-B';
    },
    changesSomethingInvisible() { revision = 'rev-B'; },
};

// --- transport --------------------------------------------------------------

async function buildFactory() {
    return prepareMcpServerFactory({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        registerTools: async (server) => {
            registerReadDocument(server);
            registerModifyText(server);
            registerBatchModifyText(server);
            registerDeleteRange(server);
            registerFindAndReplace(server);
        },
    });
}

function modernCall(name, args) {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            'mcp-protocol-version': MCP_PROTOCOL_VERSION,
            'mcp-method': 'tools/call',
            'mcp-name': name,
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name,
                arguments: args,
                _meta: {
                    'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
                    'io.modelcontextprotocol/clientCapabilities': {},
                },
            },
        }),
    });
}

async function call(handler, name, args) {
    const response = await handler.fetch(modernCall(name, args));
    return (await response.json()).result;
}

const textOf = (result) => result.content.map((entry) => entry.text ?? '').join('');
const writeControlOf = (index = 0) => batchUpdate.mock.calls[index][0].requestBody.writeControl;
const requestsOf = (index = 0) => batchUpdate.mock.calls[index][0].requestBody.requests;

/** Read the document, run `change`, and return the handle the read minted. */
async function readThen(handler, change) {
    const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'index' });
    expect(read.readHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (change) change();
    batchUpdate.mockClear();
    return read.readHandle;
}

async function withHandler(run) {
    const handler = createV2HttpHandler(await buildFactory(), { auth: { token: TOKEN } });
    try { await run(handler); } finally { await handler.close(); }
}

beforeEach(() => { setUpGoogleMocks(); });
afterEach(() => { resetHandleRuntimeState(); });
afterAll(async () => { await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true }).catch(() => {}); });

// --- the permitted paths ----------------------------------------------------

describe('a change that cannot have affected the target', () => {
    it('permits a re-resolved textToFind write after an insertion shifted its indices', async () => {
        await withHandler(async (handler) => {
            const readHandle = await readThen(handler, () => collaborator.insertsParagraphAbove());

            const write = await call(handler, 'modifyText', {
                documentId: DOC_ID, target: { textToFind: 'two' }, text: 'TWO', readHandle,
            });

            expect(write.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalledTimes(1);
            // The write landed at the CORRECTED position: "two" moved down by
            // the length of the paragraph the collaborator inserted above it.
            const shift = 'Zero inserted\n'.length;
            const requests = requestsOf();
            expect(requests[0].deleteContentRange.range).toEqual({
                startIndex: READ_TWO.startIndex + shift,
                endIndex: READ_TWO.endIndex + shift,
            });
            expect(requests[1].insertText.location.index).toBe(READ_TWO.startIndex + shift);
            // ...and the guard re-armed onto the revision it classified, never
            // the stale revision the handle was issued for.
            expect(writeControlOf()).toEqual({ requiredRevisionId: 'rev-B' });
            // The successor handle is minted as part of the same completion.
            expect(write.readHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(write.readHandle).not.toBe(readHandle);
        });
    });

    it('permits an explicit range when the change landed strictly after it', async () => {
        await withHandler(async (handler) => {
            const readHandle = await readThen(handler, () => collaborator.appendsParagraphBelow());

            const write = await call(handler, 'modifyText', {
                documentId: DOC_ID, target: READ_ONE, text: 'ONE', readHandle,
            });

            expect(write.isError).toBeFalsy();
            expect(requestsOf()[0].deleteContentRange.range).toEqual(READ_ONE);
            expect(writeControlOf()).toEqual({ requiredRevisionId: 'rev-B' });
            expect(write.readHandle).not.toBe(readHandle);
        });
    });

    it('sends the handle revision, not a re-armed one, when nothing changed at all', async () => {
        await withHandler(async (handler) => {
            const readHandle = await readThen(handler, null);
            const write = await call(handler, 'modifyText', {
                documentId: DOC_ID, target: READ_ONE, text: 'ONE', readHandle,
            });
            expect(write.isError).toBeFalsy();
            expect(writeControlOf()).toEqual({ requiredRevisionId: 'rev-A' });
        });
    });
});

// --- the refused paths ------------------------------------------------------

describe('a change that could have affected the target', () => {
    it('refuses an explicit range when the change landed before it, however far away', async () => {
        await withHandler(async (handler) => {
            const readHandle = await readThen(handler, () => collaborator.insertsParagraphAbove());

            const write = await call(handler, 'modifyText', {
                documentId: DOC_ID, target: READ_TWO, text: 'TWO', readHandle,
            });

            expect(write.isError).toBe(true);
            const message = textOf(write);
            expect(message).toMatch(/changed BEFORE the indices you asked to edit/);
            expect(message).toMatch(/"Zero inserted" was inserted/);
            expect(message).toMatch(/rev-A/);
            expect(message).toMatch(/rev-B/);
            expect(message).toMatch(/no anchor to re-resolve/);
            expect(message).toMatch(/format='index'/);
            expect(batchUpdate).not.toHaveBeenCalled();
        });
    });

    it('refuses a semantic target whose own text the change rewrote', async () => {
        await withHandler(async (handler) => {
            const readHandle = await readThen(handler, () => collaborator.rewritesTargetLine());

            const write = await call(handler, 'modifyText', {
                documentId: DOC_ID, target: { textToFind: 'Beta two' }, text: 'REPLACED', readHandle,
            });

            expect(write.isError).toBe(true);
            const message = textOf(write);
            expect(message).toMatch(/changed inside the range you asked to edit/);
            expect(message).toMatch(/silently overwrite/);
            expect(message).toMatch(/END DIFF/);
            expect(batchUpdate).not.toHaveBeenCalled();
        });
    });

    it('refuses when a semantic anchor no longer resolves', async () => {
        await withHandler(async (handler) => {
            const readHandle = await readThen(handler, () => { paragraphs[1] = 'Beta gone\n'; revision = 'rev-B'; });

            const write = await call(handler, 'modifyText', {
                documentId: DOC_ID, target: { textToFind: 'Beta two' }, text: 'REPLACED', readHandle,
            });

            expect(write.isError).toBe(true);
            // modifyText's own resolution fails first here, which is the same
            // outcome by a shorter route; either way nothing is written.
            expect(textOf(write)).toMatch(/Could not find|can no longer be located/i);
            expect(batchUpdate).not.toHaveBeenCalled();
        });
    });

    it('refuses every target when the structure changed', async () => {
        await withHandler(async (handler) => {
            const readHandle = await readThen(handler, () => collaborator.addsTable());

            const write = await call(handler, 'modifyText', {
                documentId: DOC_ID, target: { textToFind: 'two' }, text: 'TWO', readHandle,
            });

            expect(write.isError).toBe(true);
            const message = textOf(write);
            expect(message).toMatch(/structure changed/);
            expect(message).toMatch(/number of table elements changed \(0 → 1\)/);
            expect(batchUpdate).not.toHaveBeenCalled();
        });
    });

    it('refuses when the revision moved but the change is invisible to the guard', async () => {
        await withHandler(async (handler) => {
            const readHandle = await readThen(handler, () => collaborator.changesSomethingInvisible());

            const write = await call(handler, 'modifyText', {
                documentId: DOC_ID, target: { textToFind: 'two' }, text: 'TWO', readHandle,
            });

            expect(write.isError).toBe(true);
            const message = textOf(write);
            expect(message).toMatch(/cannot classify/);
            expect(message).toMatch(/formatting, styles, comments or suggestions/);
            expect(batchUpdate).not.toHaveBeenCalled();
        });
    });

    it('leaves the read handle usable after a refusal, so the corrected retry works', async () => {
        await withHandler(async (handler) => {
            const readHandle = await readThen(handler, () => collaborator.insertsParagraphAbove());

            const refused = await call(handler, 'modifyText', {
                documentId: DOC_ID, target: READ_TWO, text: 'TWO', readHandle,
            });
            expect(refused.isError).toBe(true);

            // Same handle, semantic target: the guard can prove this one safe.
            const retry = await call(handler, 'modifyText', {
                documentId: DOC_ID, target: { textToFind: 'two' }, text: 'TWO', readHandle,
            });
            expect(retry.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalledTimes(1);
        });
    });
});

// --- the other consumers ----------------------------------------------------

describe('the interface reaches every range-scoped Docs writer', () => {
    it('batchModifyText re-resolves its whole batch against one snapshot and re-arms once', async () => {
        await withHandler(async (handler) => {
            const readHandle = await readThen(handler, () => collaborator.insertsParagraphAbove());

            const write = await call(handler, 'batchModifyText', {
                documentId: DOC_ID,
                operations: [
                    { target: { textToFind: 'one' }, text: 'ONE', label: 'first' },
                    { target: { textToFind: 'three' }, text: 'THREE', label: 'second' },
                ],
                readHandle,
            });

            expect(write.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalledTimes(1);
            expect(writeControlOf()).toEqual({ requiredRevisionId: 'rev-B' });
            const shift = 'Zero inserted\n'.length;
            const deletes = requestsOf().filter((request) => request.deleteContentRange);
            expect(deletes.map((request) => request.deleteContentRange.range.startIndex).sort((a, b) => a - b))
                .toEqual([READ_ONE.startIndex + shift, 1 + shift + INITIAL[0].length + INITIAL[1].length + 'Gamma '.length]);
        });
    });

    it('batchModifyText refuses the whole batch when ONE operation cannot be cleared', async () => {
        await withHandler(async (handler) => {
            const readHandle = await readThen(handler, () => collaborator.rewritesFirstLine());

            const write = await call(handler, 'batchModifyText', {
                documentId: DOC_ID,
                operations: [
                    // Safe on its own: a semantic target far from the change.
                    { target: { textToFind: 'three' }, text: 'THREE', label: 'safe' },
                    // Explicit indices in the line the collaborator rewrote.
                    { target: READ_ONE, text: 'ONE', label: 'unsafe' },
                ],
                readHandle,
            });

            expect(write.isError).toBe(true);
            expect(textOf(write)).toMatch(/operation 2 \("unsafe"\)/);
            expect(batchUpdate).not.toHaveBeenCalled();
        });
    });

    it('deleteRange permits a change strictly after its range and refuses one before it', async () => {
        await withHandler(async (handler) => {
            const after = await readThen(handler, () => collaborator.appendsParagraphBelow());
            const permitted = await call(handler, 'deleteRange', {
                documentId: DOC_ID, startIndex: READ_ONE.startIndex, endIndex: READ_ONE.endIndex, readHandle: after,
            });
            expect(permitted.isError).toBeFalsy();
            expect(writeControlOf()).toEqual({ requiredRevisionId: 'rev-B' });
        });

        setUpGoogleMocks();
        resetHandleRuntimeState();

        await withHandler(async (handler) => {
            const before = await readThen(handler, () => collaborator.insertsParagraphAbove());
            const refused = await call(handler, 'deleteRange', {
                documentId: DOC_ID, startIndex: READ_TWO.startIndex, endIndex: READ_TWO.endIndex, readHandle: before,
            });
            expect(refused.isError).toBe(true);
            expect(textOf(refused)).toMatch(/changed BEFORE the indices/);
            expect(textOf(refused)).toMatch(/deleteRange/);
            expect(batchUpdate).not.toHaveBeenCalled();
        });
    });

    it('leaves findAndReplace document-scoped: no classification, no re-arm', async () => {
        // A document-wide replace can affect any number of ranges, so there is
        // no single target to be precise about. It keeps the pre-#108 contract:
        // the write goes out pinned to the revision the READ saw, and Google
        // rejects it if the document moved.
        await withHandler(async (handler) => {
            const readHandle = await readThen(handler, () => collaborator.insertsParagraphAbove());
            const write = await call(handler, 'findAndReplace', {
                documentId: DOC_ID, findText: 'two', replaceText: 'TWO', readHandle,
            });
            expect(write.isError).toBeFalsy();
            expect(writeControlOf()).toEqual({ requiredRevisionId: 'rev-A' });
        });
    });

    it('refuses when the read that minted the handle captured no indexed text', async () => {
        // A format='text' read fetches a field mask with no indices, so there
        // is nothing to compare the current document against. Conservative
        // default: refuse, and name the read that would work.
        await withHandler(async (handler) => {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'text' });
            collaborator.appendsParagraphBelow();
            batchUpdate.mockClear();

            const write = await call(handler, 'modifyText', {
                documentId: DOC_ID, target: READ_ONE, text: 'ONE', readHandle: read.readHandle,
            });

            expect(write.isError).toBe(true);
            const message = textOf(write);
            expect(message).toMatch(/cannot classify/);
            expect(message).toMatch(/did not capture indexed document text/);
            expect(message).toMatch(/format='index'/);
            expect(batchUpdate).not.toHaveBeenCalled();
        });
    });

    it('deleteRange spends only a revision probe when the document did not move', async () => {
        await withHandler(async (handler) => {
            const readHandle = await readThen(handler, null);
            fakeDocs.documents.get.mockClear();
            const write = await call(handler, 'deleteRange', {
                documentId: DOC_ID, startIndex: READ_ONE.startIndex, endIndex: READ_ONE.endIndex, readHandle,
            });
            expect(write.isError).toBeFalsy();
            // One cheap `fields: 'revisionId'` probe, and no full document fetch.
            const masks = fakeDocs.documents.get.mock.calls.map(([params]) => params.fields);
            expect(masks).toEqual(['revisionId']);
            expect(writeControlOf()).toEqual({ requiredRevisionId: 'rev-A' });
        });
    });
});
