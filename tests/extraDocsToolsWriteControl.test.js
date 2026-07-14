// Extends WriteControl coverage (PR #42 review) to the remaining Docs tools that
// call executeBatchUpdate / executeBatchUpdateWithSplitting / documents.batchUpdate
// but weren't in the originally-named list of 6 (modifyText, appendMarkdown,
// replaceDocumentWithMarkdown, appendText, deleteRange, findAndReplace). None of
// these tools ever had a guardMutation check, so there's no existing guard to
// preserve — this only proves the additive, opt-in WriteControl wiring is correct:
// when a caller's prior read is tracked, the revision is attached to every write.
import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

let fakeDocs;
let fakeDrive;
let fakeScript;
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => fakeDocs,
    getDriveClient: async () => fakeDrive,
    getSheetsClient: async () => { throw new Error('not used'); },
    getCalendarClient: async () => { throw new Error('not used'); },
    getScriptClient: async () => fakeScript,
}));

const { trackRead } = await import('../dist/readTracker.js');
const { register: registerInsertPageBreak } = await import('../dist/tools/docs/insertPageBreak.js');
const { register: registerApplyParagraphStyle } = await import('../dist/tools/docs/formatting/applyParagraphStyle.js');
const { register: registerInsertTableWithData } = await import('../dist/tools/docs/insertTableWithData.js');
const { register: registerInsertTable } = await import('../dist/tools/docs/insertTable.js');
const { register: registerAddTab } = await import('../dist/tools/docs/addTab.js');
const { register: registerRenameTab } = await import('../dist/tools/docs/renameTab.js');
const { register: registerInsertImage } = await import('../dist/tools/docs/insertImage.js');

function createMockServer() {
    const tools = new Map();
    return {
        addTool(def) { tools.set(def.name, def); },
        getTool(name) { return tools.get(name); },
    };
}

const noopLog = { info() {}, error() {}, warn() {}, debug() {} };

function staleRevisionError() {
    return Object.assign(new Error('Precondition check failed.'), {
        code: 400,
        response: { data: { error: { status: 'FAILED_PRECONDITION', message: 'Precondition check failed.' } } },
    });
}

describe('insertPageBreak — WriteControl guard', () => {
    it('attaches the tracked revision to its batchUpdate call', async () => {
        const documentId = `pagebreak-${Date.now()}`;
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
        fakeDocs = { documents: { get: jest.fn(), batchUpdate } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerInsertPageBreak(server);
        await server.getTool('insertPageBreak').execute({ documentId, index: 5 }, { log: noopLog });

        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-read' });
    });

    it('rejects a stale-revision write with a clear re-read error', async () => {
        const documentId = `pagebreak-stale-${Date.now()}`;
        fakeDocs = { documents: { get: jest.fn(), batchUpdate: jest.fn(async () => { throw staleRevisionError(); }) } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerInsertPageBreak(server);
        await expect(
            server.getTool('insertPageBreak').execute({ documentId, index: 5 }, { log: noopLog })
        ).rejects.toThrow(/changed since you last read/i);
    });
});

describe('applyParagraphStyle — WriteControl guard', () => {
    it('attaches the tracked revision to its batchUpdate call', async () => {
        const documentId = `parastyle-${Date.now()}`;
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
        fakeDocs = { documents: { get: jest.fn(), batchUpdate } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerApplyParagraphStyle(server);
        await server.getTool('applyParagraphStyle').execute({
            documentId,
            target: { startIndex: 1, endIndex: 10 },
            style: { alignment: 'CENTER' },
        }, { log: noopLog });

        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-read' });
    });

    it('rejects a stale-revision write with a clear re-read error', async () => {
        const documentId = `parastyle-stale-${Date.now()}`;
        fakeDocs = { documents: { get: jest.fn(), batchUpdate: jest.fn(async () => { throw staleRevisionError(); }) } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerApplyParagraphStyle(server);
        await expect(
            server.getTool('applyParagraphStyle').execute({
                documentId,
                target: { startIndex: 1, endIndex: 10 },
                style: { alignment: 'CENTER' },
            }, { log: noopLog })
        ).rejects.toThrow(/changed since you last read/i);
    });
});

describe('insertTableWithData — WriteControl guard', () => {
    it('attaches the tracked revision to every split batch', async () => {
        const documentId = `tablewithdata-${Date.now()}`;
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
        fakeDocs = { documents: { get: jest.fn(), batchUpdate } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerInsertTableWithData(server);
        await server.getTool('insertTableWithData').execute({
            documentId,
            data: [['a', 'b'], ['c', 'd']],
            index: 1,
        }, { log: noopLog });

        expect(batchUpdate).toHaveBeenCalled();
        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-read' });
    });

    it('rejects a stale-revision write with a clear re-read error', async () => {
        const documentId = `tablewithdata-stale-${Date.now()}`;
        fakeDocs = { documents: { get: jest.fn(), batchUpdate: jest.fn(async () => { throw staleRevisionError(); }) } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerInsertTableWithData(server);
        await expect(
            server.getTool('insertTableWithData').execute({
                documentId,
                data: [['a', 'b']],
                index: 1,
            }, { log: noopLog })
        ).rejects.toThrow(/changed since you last read/i);
    });
});

describe('insertTable — WriteControl guard', () => {
    it('attaches the tracked revision to its batchUpdate call', async () => {
        const documentId = `inserttable-${Date.now()}`;
        const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
        fakeDocs = { documents: { get: jest.fn(), batchUpdate } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerInsertTable(server);
        await server.getTool('insertTable').execute({ documentId, rows: 2, columns: 2, index: 1 }, { log: noopLog });

        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-read' });
    });

    it('rejects a stale-revision write with a clear re-read error', async () => {
        const documentId = `inserttable-stale-${Date.now()}`;
        fakeDocs = { documents: { get: jest.fn(), batchUpdate: jest.fn(async () => { throw staleRevisionError(); }) } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerInsertTable(server);
        await expect(
            server.getTool('insertTable').execute({ documentId, rows: 2, columns: 2, index: 1 }, { log: noopLog })
        ).rejects.toThrow(/changed since you last read/i);
    });
});

describe('insertImage — WriteControl guard', () => {
    describe('standard URL path (insertInlineImage)', () => {
        it('attaches the tracked revision to its batchUpdate call', async () => {
            const documentId = `insertimage-url-${Date.now()}`;
            const batchUpdate = jest.fn(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
            fakeDocs = { documents: { get: jest.fn(), batchUpdate } };
            trackRead(documentId, null, null, 'rev-read');

            const server = createMockServer();
            registerInsertImage(server);
            await server.getTool('insertImage').execute({
                documentId,
                imageUrl: 'https://example.com/pic.png',
                index: 1,
            }, { log: noopLog });

            expect(batchUpdate).toHaveBeenCalledTimes(1);
            expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-read' });
        });

        it('rejects a stale-revision write with a clear re-read error', async () => {
            const documentId = `insertimage-url-stale-${Date.now()}`;
            fakeDocs = { documents: { get: jest.fn(), batchUpdate: jest.fn(async () => { throw staleRevisionError(); }) } };
            trackRead(documentId, null, null, 'rev-read');

            const server = createMockServer();
            registerInsertImage(server);
            await expect(
                server.getTool('insertImage').execute({
                    documentId,
                    imageUrl: 'https://example.com/pic.png',
                    index: 1,
                }, { log: noopLog })
            ).rejects.toThrow(/changed since you last read/i);
        });

        it('omits writeControl when the document was never read (no-op behavior)', async () => {
            const documentId = `insertimage-url-untracked-${Date.now()}`;
            const batchUpdate = jest.fn(async () => ({ data: {} }));
            fakeDocs = { documents: { get: jest.fn(), batchUpdate } };
            // No trackRead call for this documentId.

            const server = createMockServer();
            registerInsertImage(server);
            await server.getTool('insertImage').execute({
                documentId,
                imageUrl: 'https://example.com/pic.png',
                index: 1,
            }, { log: noopLog });

            expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toBeUndefined();
        });
    });

    describe('local-file Apps Script path (insertImageViaAppsScript)', () => {
        const tmpImagePath = path.join(os.tmpdir(), `write-control-test-${process.pid}.png`);
        const originalDeploymentId = process.env.APPS_SCRIPT_DEPLOYMENT_ID;

        beforeAll(() => {
            // A 1x1 PNG's exact bytes don't matter — uploadImageToDrive only reads
            // the file as a stream and inspects the extension for mime-type mapping.
            fs.writeFileSync(tmpImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
            process.env.APPS_SCRIPT_DEPLOYMENT_ID = 'test-deployment-id';
        });

        afterAll(() => {
            fs.rmSync(tmpImagePath, { force: true });
            if (originalDeploymentId === undefined) {
                delete process.env.APPS_SCRIPT_DEPLOYMENT_ID;
            }
            else {
                process.env.APPS_SCRIPT_DEPLOYMENT_ID = originalDeploymentId;
            }
        });

        function setUpAppsScriptMocks(batchUpdateImpl) {
            const batchUpdate = jest.fn(batchUpdateImpl);
            fakeDocs = { documents: { get: jest.fn(), batchUpdate } };
            fakeDrive = {
                files: {
                    get: async () => ({ data: {} }),
                    // uploadImageToDrive passes a real fs.createReadStream as media.body.
                    // Drain it fully before resolving so the stream's lazy internal
                    // fs.open()/read() has already completed by the time this test's
                    // afterAll deletes the temp file — otherwise the open races the
                    // deletion and throws an unhandled ENOENT on the stream.
                    create: async ({ media } = {}) => {
                        if (media?.body) {
                            await new Promise((resolve, reject) => {
                                media.body.on('data', () => { });
                                media.body.on('end', resolve);
                                media.body.on('close', resolve);
                                media.body.on('error', reject);
                            });
                        }
                        return { data: { id: 'uploaded-file-id' } };
                    },
                },
            };
            fakeScript = { scripts: { run: jest.fn(async () => ({ data: { response: { result: { success: true } } } })) } };
            return { batchUpdate };
        }

        it('attaches the tracked revision to the marker-insertion batchUpdate call', async () => {
            const documentId = `insertimage-appsscript-${Date.now()}`;
            const { batchUpdate } = setUpAppsScriptMocks(async ({ requestBody }) => ({
                data: { writeControl: requestBody.writeControl },
            }));
            trackRead(documentId, null, null, 'rev-read');

            const server = createMockServer();
            registerInsertImage(server);
            await server.getTool('insertImage').execute({
                documentId,
                localImagePath: tmpImagePath,
                index: 1,
            }, { log: noopLog });

            expect(batchUpdate).toHaveBeenCalledTimes(1);
            expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-read' });
        });

        it('rejects a stale-revision write with a clear re-read error', async () => {
            const documentId = `insertimage-appsscript-stale-${Date.now()}`;
            setUpAppsScriptMocks(async () => { throw staleRevisionError(); });
            trackRead(documentId, null, null, 'rev-read');

            const server = createMockServer();
            registerInsertImage(server);
            await expect(
                server.getTool('insertImage').execute({
                    documentId,
                    localImagePath: tmpImagePath,
                    index: 1,
                }, { log: noopLog })
            ).rejects.toThrow(/changed since you last read/i);
        });
    });
});

describe('addTab — WriteControl guard', () => {
    it('attaches the tracked revision to its batchUpdate call', async () => {
        const documentId = `addtab-${Date.now()}`;
        const batchUpdate = jest.fn(async ({ requestBody }) => ({
            data: {
                writeControl: requestBody.writeControl,
                replies: [{ addDocumentTab: { tabProperties: { tabId: 'new-tab', title: 'Untitled' } } }],
            },
        }));
        fakeDocs = { documents: { get: jest.fn(), batchUpdate } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerAddTab(server);
        await server.getTool('addTab').execute({ documentId }, { log: noopLog });

        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-read' });
    });

    it('rejects a stale-revision write with a clear re-read error', async () => {
        const documentId = `addtab-stale-${Date.now()}`;
        fakeDocs = { documents: { get: jest.fn(), batchUpdate: jest.fn(async () => { throw staleRevisionError(); }) } };
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerAddTab(server);
        await expect(
            server.getTool('addTab').execute({ documentId }, { log: noopLog })
        ).rejects.toThrow(/changed since you last read/i);
    });
});

describe('renameTab — WriteControl guard', () => {
    function setUpDocsMock(batchUpdateImpl) {
        const documentsGet = jest.fn(async () => ({
            data: { tabs: [{ tabProperties: { tabId: 'tab-1', title: 'Old Title' } }] },
        }));
        const batchUpdate = jest.fn(batchUpdateImpl);
        fakeDocs = { documents: { get: documentsGet, batchUpdate } };
        return { documentsGet, batchUpdate };
    }

    it('attaches the tracked revision to its batchUpdate call', async () => {
        const documentId = `renametab-${Date.now()}`;
        const { batchUpdate } = setUpDocsMock(async ({ requestBody }) => ({ data: { writeControl: requestBody.writeControl } }));
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerRenameTab(server);
        await server.getTool('renameTab').execute({ documentId, tabId: 'tab-1', newTitle: 'New Title' }, { log: noopLog });

        expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'rev-read' });
    });

    it('rejects a stale-revision write with a clear re-read error', async () => {
        const documentId = `renametab-stale-${Date.now()}`;
        setUpDocsMock(async () => { throw staleRevisionError(); });
        trackRead(documentId, null, null, 'rev-read');

        const server = createMockServer();
        registerRenameTab(server);
        await expect(
            server.getTool('renameTab').execute({ documentId, tabId: 'tab-1', newTitle: 'New Title' }, { log: noopLog })
        ).rejects.toThrow(/changed since you last read/i);
    });
});
