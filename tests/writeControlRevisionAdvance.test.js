// Regression coverage for PR #42 round-2 adversarial review: the WriteControl
// guard's tracked revisionId was never advanced past the caller's original
// read. Two consecutive writes to the same document with no re-read in
// between (a routine agentic pattern — e.g. insertPageBreak then insertTable)
// hit one of two silent failure modes depending on the tool:
//
//   (a) Tools that called trackMutation(fileId) after a write cleared the
//       tracked revisionId to null, so the SECOND write went out with no
//       writeControl at all — the guard was silently disabled, and a real
//       concurrent edit landing between the two calls would be clobbered.
//   (b) Tools with no trackMutation call at all (the 7 tools swept in
//       bb8b4ef) kept re-sending the ORIGINAL read's revisionId forever. The
//       first write correctly advances the document's real revision, so the
//       second write's requiredRevisionId is now stale relative to the
//       server — Google rejects it with FAILED_PRECONDITION even though
//       nothing external changed. A spurious "changed since you last read
//       it" error on a tool's own second call.
//
// The fix: batchUpdate's response always echoes the resulting revision as
// `writeControl` ("the updated write control after applying the request" —
// Docs API v1 reference). trackMutation now accepts that revision and
// re-arms the tracker with it instead of nulling it (mode a) or leaving the
// stale original value in place (mode b, since those tools never called
// trackMutation to begin with).
//
// Each test below drives two consecutive real tool executions against a
// mocked Docs client that behaves like the real API: it accepts a write only
// when requiredRevisionId matches its current revision, and advances its
// revision on every successful write. This catches both failure modes
// directly — revert the trackMutation(...) call-site edit in any one tool
// below and its test fails.
import { describe, it, expect, jest } from '@jest/globals';

let fakeDocs;
let fakeDrive;
let fakeScript;
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => fakeDocs,
    getDriveClient: async () => fakeDrive,
    getSheetsClient: async () => { throw new Error('not used'); },
    getCalendarClient: async () => { throw new Error('not used'); },
    getScriptClient: async () => fakeScript ?? (() => { throw new Error('not used'); })(),
}));

const { trackRead, getLastReadRevisionId } = await import('../dist/readTracker.js');
const { register: registerModifyText } = await import('../dist/tools/docs/modifyText.js');
const { register: registerAppendText } = await import('../dist/tools/docs/appendToGoogleDoc.js');
const { register: registerDeleteRange } = await import('../dist/tools/docs/deleteRange.js');
const { register: registerFindAndReplace } = await import('../dist/tools/docs/findAndReplace.js');
const { register: registerInsertPageBreak } = await import('../dist/tools/docs/insertPageBreak.js');
const { register: registerInsertTable } = await import('../dist/tools/docs/insertTable.js');
const { register: registerInsertTableWithData } = await import('../dist/tools/docs/insertTableWithData.js');
const { register: registerApplyParagraphStyle } = await import('../dist/tools/docs/formatting/applyParagraphStyle.js');
const { register: registerAddTab } = await import('../dist/tools/docs/addTab.js');
const { register: registerRenameTab } = await import('../dist/tools/docs/renameTab.js');
const { register: registerAppendMarkdown } = await import('../dist/tools/utils/appendMarkdownToGoogleDoc.js');
const { register: registerReplaceMarkdown } = await import('../dist/tools/utils/replaceDocumentWithMarkdown.js');
const { register: registerInsertImage } = await import('../dist/tools/docs/insertImage.js');

function createMockServer() {
    const tools = new Map();
    return { addTool(def) { tools.set(def.name, def); }, getTool(name) { return tools.get(name); } };
}
const noopLog = { info() {}, error() {}, warn() {}, debug() {} };

function conflictError() {
    return Object.assign(new Error('Precondition check failed.'), {
        code: 400,
        response: { data: { error: { status: 'FAILED_PRECONDITION', message: 'Precondition check failed.' } } },
    });
}

/** A minimal fake Docs server that enforces requiredRevisionId like the real API:
 * a write is rejected unless it matches the server's current revision, and the
 * server's revision advances by one on every accepted write. `getResponder` lets
 * each test customize what documents.get returns (some tools need specific shapes). */
function makeRevisionEnforcingDocs(startRevision, getResponder) {
    let serverRevision = startRevision;
    let counter = 0;
    const batchUpdate = jest.fn(async ({ requestBody }) => {
        const wc = requestBody.writeControl;
        if (wc && wc.requiredRevisionId !== serverRevision) {
            throw conflictError();
        }
        serverRevision = `${startRevision}-w${++counter}`;
        return {
            data: {
                writeControl: { requiredRevisionId: serverRevision },
                replies: [{ addDocumentTab: { tabProperties: { tabId: 'new-tab', title: 'Untitled' } } }],
            },
        };
    });
    const get = jest.fn(getResponder ?? (async () => ({ data: {} })));
    return { documents: { get, batchUpdate }, _getCurrentRevision: () => serverRevision };
}

describe('WriteControl guard revision advances across consecutive writes (no re-read)', () => {
    it('modifyText: second call requires the revision the first call produced, not the original read', async () => {
        const documentId = `modify-${Date.now()}`;
        fakeDocs = makeRevisionEnforcingDocs('R0');
        trackRead(documentId, null, null, 'R0');

        const server = createMockServer();
        registerModifyText(server);
        const tool = server.getTool('modifyText');

        await tool.execute({ documentId, target: { insertionIndex: 1 }, text: 'first' }, { log: noopLog });
        const revAfterFirst = fakeDocs._getCurrentRevision();
        expect(getLastReadRevisionId(documentId)).toBe(revAfterFirst);

        // Second call, no re-read: must not fail, and must use the advanced revision.
        await tool.execute({ documentId, target: { insertionIndex: 1 }, text: 'second' }, { log: noopLog });
        expect(fakeDocs.documents.batchUpdate).toHaveBeenCalledTimes(2);
        const secondCallWC = fakeDocs.documents.batchUpdate.mock.calls[1][0].requestBody.writeControl;
        expect(secondCallWC.requiredRevisionId).not.toBe('R0');
        expect(secondCallWC.requiredRevisionId).toBe(revAfterFirst);
    });

    it('appendText: second call carries the advanced revision instead of null or the stale original', async () => {
        const documentId = `append-${Date.now()}`;
        fakeDocs = makeRevisionEnforcingDocs('R0', async () => ({ data: { body: { content: [{ endIndex: 10 }] } } }));
        fakeDrive = { files: { get: async () => ({ data: { modifiedTime: null } }) } };
        trackRead(documentId, null, null, 'R0');

        const server = createMockServer();
        registerAppendText(server);
        const tool = server.getTool('appendText');

        await tool.execute({ documentId, text: 'first' }, { log: noopLog });
        const revAfterFirst = fakeDocs._getCurrentRevision();
        await tool.execute({ documentId, text: 'second' }, { log: noopLog });

        const secondCallWC = fakeDocs.documents.batchUpdate.mock.calls[1][0].requestBody.writeControl;
        expect(secondCallWC).toBeDefined();
        expect(secondCallWC.requiredRevisionId).toBe(revAfterFirst);
    });

    it('deleteRange: second call carries the advanced revision', async () => {
        const documentId = `delete-${Date.now()}`;
        fakeDocs = makeRevisionEnforcingDocs('R0');
        fakeDrive = { files: { get: async () => ({ data: { modifiedTime: null } }) } };
        trackRead(documentId, null, null, 'R0');

        const server = createMockServer();
        registerDeleteRange(server);
        const tool = server.getTool('deleteRange');

        await tool.execute({ documentId, startIndex: 1, endIndex: 3 }, { log: noopLog });
        const revAfterFirst = fakeDocs._getCurrentRevision();
        await tool.execute({ documentId, startIndex: 1, endIndex: 3 }, { log: noopLog });

        const secondCallWC = fakeDocs.documents.batchUpdate.mock.calls[1][0].requestBody.writeControl;
        expect(secondCallWC.requiredRevisionId).toBe(revAfterFirst);
    });

    it('findAndReplace: second call carries the advanced revision', async () => {
        const documentId = `far-${Date.now()}`;
        fakeDocs = makeRevisionEnforcingDocs('R0');
        fakeDrive = { files: { get: async () => ({ data: { modifiedTime: null } }) } };
        trackRead(documentId, null, null, 'R0');

        const server = createMockServer();
        registerFindAndReplace(server);
        const tool = server.getTool('findAndReplace');

        await tool.execute({ documentId, findText: 'a', replaceText: 'b' }, { log: noopLog });
        const revAfterFirst = fakeDocs._getCurrentRevision();
        await tool.execute({ documentId, findText: 'a', replaceText: 'b' }, { log: noopLog });

        const secondCallWC = fakeDocs.documents.batchUpdate.mock.calls[1][0].requestBody.writeControl;
        expect(secondCallWC.requiredRevisionId).toBe(revAfterFirst);
    });

    it('insertPageBreak: second call does NOT spuriously fail against our own first write', async () => {
        const documentId = `pagebreak-${Date.now()}`;
        fakeDocs = makeRevisionEnforcingDocs('R0');
        trackRead(documentId, null, null, 'R0');

        const server = createMockServer();
        registerInsertPageBreak(server);
        const tool = server.getTool('insertPageBreak');

        await tool.execute({ documentId, index: 5 }, { log: noopLog });
        const revAfterFirst = fakeDocs._getCurrentRevision();
        // Before the fix, this second call reused the stale 'R0' and the mock
        // (behaving like the real API) would reject it as a conflict.
        await expect(tool.execute({ documentId, index: 5 }, { log: noopLog })).resolves.toMatch(/Successfully/);

        const secondCallWC = fakeDocs.documents.batchUpdate.mock.calls[1][0].requestBody.writeControl;
        expect(secondCallWC.requiredRevisionId).toBe(revAfterFirst);
    });

    it('insertTable: second call does NOT spuriously fail', async () => {
        const documentId = `table-${Date.now()}`;
        fakeDocs = makeRevisionEnforcingDocs('R0');
        trackRead(documentId, null, null, 'R0');

        const server = createMockServer();
        registerInsertTable(server);
        const tool = server.getTool('insertTable');

        await tool.execute({ documentId, rows: 2, columns: 2, index: 1 }, { log: noopLog });
        await expect(
            tool.execute({ documentId, rows: 2, columns: 2, index: 1 }, { log: noopLog })
        ).resolves.toMatch(/Successfully/);
    });

    it('insertTableWithData: second call does NOT spuriously fail', async () => {
        const documentId = `tablewithdata-${Date.now()}`;
        fakeDocs = makeRevisionEnforcingDocs('R0');
        trackRead(documentId, null, null, 'R0');

        const server = createMockServer();
        registerInsertTableWithData(server);
        const tool = server.getTool('insertTableWithData');

        const args = { documentId, data: [['a', 'b'], ['c', 'd']], index: 1 };
        await tool.execute(args, { log: noopLog });
        await expect(tool.execute(args, { log: noopLog })).resolves.toMatch(/Successfully/);
    });

    it('applyParagraphStyle: second call does NOT spuriously fail', async () => {
        const documentId = `parastyle-${Date.now()}`;
        fakeDocs = makeRevisionEnforcingDocs('R0');
        trackRead(documentId, null, null, 'R0');

        const server = createMockServer();
        registerApplyParagraphStyle(server);
        const tool = server.getTool('applyParagraphStyle');

        const args = { documentId, target: { startIndex: 1, endIndex: 10 }, style: { alignment: 'CENTER' } };
        await tool.execute(args, { log: noopLog });
        await expect(tool.execute(args, { log: noopLog })).resolves.toMatch(/Successfully/);
    });

    it('addTab: second call does NOT spuriously fail', async () => {
        const documentId = `addtab-${Date.now()}`;
        fakeDocs = makeRevisionEnforcingDocs('R0');
        trackRead(documentId, null, null, 'R0');

        const server = createMockServer();
        registerAddTab(server);
        const tool = server.getTool('addTab');

        await tool.execute({ documentId }, { log: noopLog });
        const secondResult = await tool.execute({ documentId }, { log: noopLog });
        expect(secondResult).toMatch(/Successfully added new tab/);
    });

    it('renameTab: second call does NOT spuriously fail', async () => {
        const documentId = `renametab-${Date.now()}`;
        fakeDocs = makeRevisionEnforcingDocs('R0', async () => ({
            data: { tabs: [{ tabProperties: { tabId: 'tab-1', title: 'Old Title' } }] },
        }));
        trackRead(documentId, null, null, 'R0');

        const server = createMockServer();
        registerRenameTab(server);
        const tool = server.getTool('renameTab');

        await tool.execute({ documentId, tabId: 'tab-1', newTitle: 'Title A' }, { log: noopLog });
        await expect(
            tool.execute({ documentId, tabId: 'tab-1', newTitle: 'Title B' }, { log: noopLog })
        ).resolves.toMatch(/Successfully renamed/);
    });

    it('insertImage (URL path): second call carries the advanced revision', async () => {
        const documentId = `image-url-${Date.now()}`;
        fakeDocs = makeRevisionEnforcingDocs('R0');
        trackRead(documentId, null, null, 'R0');

        const server = createMockServer();
        registerInsertImage(server);
        const tool = server.getTool('insertImage');

        const args = { documentId, imageUrl: 'https://example.com/pic.png', index: 1 };
        await tool.execute(args, { log: noopLog });
        const revAfterFirst = fakeDocs._getCurrentRevision();
        await expect(tool.execute(args, { log: noopLog })).resolves.toMatch(/Successfully inserted image/);

        const secondCallWC = fakeDocs.documents.batchUpdate.mock.calls[1][0].requestBody.writeControl;
        expect(secondCallWC.requiredRevisionId).toBe(revAfterFirst);
    });

    it('appendMarkdown: second call carries the TRUE post-insert revision, not just the post-spacing one', async () => {
        const documentId = `appendmd-${Date.now()}`;
        fakeDrive = { files: { get: async () => ({ data: { modifiedTime: null } }) } };
        fakeDocs = makeRevisionEnforcingDocs('R0', async ({ fields } = {}) => {
            if (fields === 'namedStyles')
                return { data: { namedStyles: { styles: [] } } };
            return { data: { body: { content: [{ endIndex: 20 }] } } };
        });
        trackRead(documentId, null, null, 'R0');

        const server = createMockServer();
        registerAppendMarkdown(server);
        const tool = server.getTool('appendMarkdown');

        await tool.execute({ documentId, markdown: 'Some **bold** text.' }, { log: noopLog });
        // Multiple internal batches ran (spacing + insert); the tracked revision
        // must reflect the LAST one, not an intermediate one.
        expect(getLastReadRevisionId(documentId)).toBe(fakeDocs._getCurrentRevision());

        await expect(
            tool.execute({ documentId, markdown: 'More text.' }, { log: noopLog })
        ).resolves.toMatch(/Successfully appended/);
    });

    it('replaceDocumentWithMarkdown: second call carries the TRUE post-insert revision', async () => {
        const documentId = `replacemd-${Date.now()}`;
        fakeDrive = { files: { get: async () => ({ data: { modifiedTime: null } }) } };
        fakeDocs = makeRevisionEnforcingDocs('R0', async ({ fields } = {}) => {
            if (fields === 'namedStyles')
                return { data: { namedStyles: { styles: [] } } };
            return { data: { body: { content: [{ startIndex: 1, endIndex: 10 }] } } };
        });
        trackRead(documentId, null, null, 'R0');

        const server = createMockServer();
        registerReplaceMarkdown(server);
        const tool = server.getTool('replaceDocumentWithMarkdown');

        await tool.execute({ documentId, markdown: '# Title\n\nBody text.' }, { log: noopLog });
        expect(getLastReadRevisionId(documentId)).toBe(fakeDocs._getCurrentRevision());

        await expect(
            tool.execute({ documentId, markdown: '# New Title\n\nOther text.' }, { log: noopLog })
        ).resolves.toMatch(/Successfully replaced/);
    });
});

describe('insertImage Apps Script path: revision cannot be known after the script mutates the doc', () => {
    it('clears the tracked revision instead of propagating a now-stale one', async () => {
        const fs = await import('fs/promises');
        const os = await import('os');
        const path = await import('path');
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-img-'));
        const tmpFile = path.join(tmpDir, 'pic.png');
        await fs.writeFile(tmpFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

        const documentId = `image-appsscript-${Date.now()}`;
        process.env.APPS_SCRIPT_DEPLOYMENT_ID = 'deploy-1';
        fakeDrive = {
            files: {
                get: async () => ({ data: { parents: ['folder-1'] } }),
                create: jest.fn((params) => {
                    const media = params.media?.body;
                    if (media && typeof media.on === 'function') {
                        media.on('data', () => {});
                        media.on('end', () => {});
                        media.resume?.();
                    }
                    return Promise.resolve({ data: { id: 'drive-file-1' } });
                }),
                permissions: { create: async () => ({ data: {} }) },
            },
        };
        fakeDocs = {
            documents: {
                get: jest.fn(async () => ({ data: {} })),
                // The marker insert succeeds and (like the real API) returns the
                // resulting revision. If insertImage's Apps Script path naively
                // captured this as the tracked revision, it would be stale — the
                // subsequent Apps Script call mutates the doc again outside our view.
                batchUpdate: jest.fn(async () => ({ data: { writeControl: { requiredRevisionId: 'rev-after-marker-only' } } })),
            },
        };
        fakeScript = {
            scripts: {
                run: jest.fn(async () => ({ data: { response: { result: { success: true } } } })),
            },
        };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerInsertImage(server);
        const tool = server.getTool('insertImage');

        const result = await tool.execute({ documentId, localImagePath: tmpFile, index: 1 }, { log: noopLog });
        expect(result).toMatch(/Successfully inserted local image/);

        // The Apps Script call replaced the marker with the actual image — a real
        // mutation we have no batchUpdate response for. The tracked revision must
        // be cleared (disabling the guard until the next real read), not left at
        // the marker-only revision, which would make the NEXT write's stale-check
        // pass against a document state that no longer exists.
        expect(getLastReadRevisionId(documentId)).toBeNull();

        await fs.rm(tmpDir, { recursive: true, force: true });
        delete process.env.APPS_SCRIPT_DEPLOYMENT_ID;
    });
});
