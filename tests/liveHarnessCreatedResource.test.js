// The live harness registers what it creates so it can trash it afterwards.
// Both callers -- scripts/live-mission.mjs and scripts/live-smoke/call.mjs --
// used to read `JSON.parse(result).id` and nothing else, which silently dropped
// two of the eight tools they claimed to cover:
//
//   createPresentation          returns JSON keyed `presentationId`
//   createDocumentFromTemplate  returns prose, so JSON.parse throws
//
// The consequence is not a missing log line. The registry is what cleanup
// iterates, so an unregistered file is never trashed, and the run still prints
// "cleanup N/N" because N only counts what it noticed. The harness reported a
// clean sandbox while leaving real files in a real Drive.
//
// The literals below are copied from the production return statements. The
// last describe block then runs every creating tool for real against fake
// Google clients and feeds the actual return value to the extractor, so a
// change to any tool's result shape fails here rather than in someone's Drive.
import { describe, expect, it, jest, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CREATING_TOOLS, extractCreatedId, classifyCreation } from '../scripts/live-smoke/createdResource.mjs';

const DOC_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const PRES_ID = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210';

// One fake per Google client, every "create something" call answering with
// CREATED_ID. Only dist/clients.js is mocked; the tools, the read tracker and
// the handle runtime are the real modules.
const CREATED_ID = '1CrEaTeDbYtHeFaKeCliEnT0000000000001';
const DRAFT_ID = 'r-4242424242424242424';
const docPayload = (documentId) => ({
    data: {
        documentId,
        revisionId: 'rev-1',
        body: { content: [{ startIndex: 1, endIndex: 6, paragraph: { elements: [{ startIndex: 1, endIndex: 6, textRun: { content: 'body\n' } }] } }] },
    },
});
const created = (extra = {}) => ({ data: { id: CREATED_ID, name: 'probe', webViewLink: `https://docs.google.com/document/d/${CREATED_ID}/edit`, ...extra } });
const fakeDrive = {
    files: {
        create: jest.fn(async ({ media } = {}) => {
            // uploadFile hands over a lazy ReadStream; drain it here the way
            // the real transport would, or it opens after the temp file is gone.
            if (media?.body && typeof media.body[Symbol.asyncIterator] === 'function') {
                for await (const _chunk of media.body) { /* drain */ }
            }
            return created({ mimeType: 'text/plain', size: '4' });
        }),
        copy: jest.fn(async () => created({ mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-01-01T00:00:00.000Z' })),
        get: jest.fn(async () => ({ data: { name: 'source', parents: ['parent-1'], modifiedTime: '2026-01-01T00:00:00.000Z' } })),
        update: jest.fn(async () => ({ data: {} })),
    },
};
const fakeDocs = {
    documents: {
        get: jest.fn(async ({ documentId }) => docPayload(documentId)),
        batchUpdate: jest.fn(async () => ({ data: {} })),
    },
};
const fakeSheets = { spreadsheets: { values: { update: jest.fn(async () => ({ data: {} })) } } };
const fakeSlides = {
    presentations: {
        create: jest.fn(async () => ({ data: { presentationId: CREATED_ID } })),
        batchUpdate: jest.fn(async () => ({ data: {} })),
        pages: { get: jest.fn(async () => ({ data: { pageElements: [] } })) },
    },
};
const fakeGmail = {
    users: {
        drafts: { create: jest.fn(async () => ({ data: { id: DRAFT_ID, message: { id: 'm-1', threadId: 't-1' } } })) },
    },
};
const unused = async () => { throw new Error('client not used in this suite'); };
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDriveClient: async () => fakeDrive,
    getDocsClient: async () => fakeDocs,
    getSheetsClient: async () => fakeSheets,
    getSlidesClient: async () => fakeSlides,
    getGmailClient: async () => fakeGmail,
    getAuthClient: unused,
    getAuthClientIfReady: () => null,
    getCalendarClient: unused,
    getFormsClient: unused,
    getScriptClient: unused,
    getTasksClient: unused,
    resetClients: () => {},
    withAuthRetry: (fn) => fn(),
}));

describe('live harness created-resource extraction', () => {
    it('finds the id in the plain JSON shape most creating tools return', () => {
        const result = JSON.stringify({ id: DOC_ID, name: 'probe', url: 'https://docs.google.com/…' }, null, 2);
        expect(extractCreatedId(result)).toBe(DOC_ID);
    });

    it('finds createPresentation\'s id, which is keyed presentationId and not id', () => {
        // Verbatim shape from dist/tools/slides/createPresentation.js.
        const result = JSON.stringify({
            presentationId: PRES_ID,
            title: 'probe',
            link: `https://docs.google.com/presentation/d/${PRES_ID}`,
            slidesCreated: 2,
        }, null, 2);
        expect(extractCreatedId(result)).toBe(PRES_ID);
        expect(classifyCreation('createPresentation', result)).toEqual({ kind: 'drive', id: PRES_ID });
    });

    it('finds createDocumentFromTemplate\'s id in prose, where JSON.parse throws', () => {
        // Verbatim shape from dist/tools/drive/createFromTemplate.js.
        const result = `Successfully created document "Q3 report" from template (ID: ${DOC_ID})\n`
            + `View Link: https://docs.google.com/document/d/${DOC_ID}/edit\n\n`
            + 'Applied 3 text replacements to the document.';
        expect(extractCreatedId(result)).toBe(DOC_ID);
        expect(classifyCreation('createDocumentFromTemplate', result)).toEqual({ kind: 'drive', id: DOC_ID });
    });

    it('still finds the id from the View Link alone if the (ID: …) wording changes', () => {
        expect(extractCreatedId(`Created it.\nView Link: https://docs.google.com/document/d/${DOC_ID}/edit`)).toBe(DOC_ID);
        expect(extractCreatedId(`https://drive.google.com/file/d/${DOC_ID}/view`)).toBe(DOC_ID);
    });

    it('finds a Gmail draft id through its nesting', () => {
        expect(extractCreatedId(JSON.stringify({ id: 'r-123456789012345', message: { id: 'm-1', threadId: 't-1' } })))
            .toBe('r-123456789012345');
        expect(extractCreatedId(JSON.stringify({ draft: { id: 'r-987654321098765' } }))).toBe('r-987654321098765');
    });

    it('returns null rather than a wrong id when a result names none', () => {
        expect(extractCreatedId('Nothing was created.')).toBeNull();
        expect(extractCreatedId(JSON.stringify({ ok: true }))).toBeNull();
        expect(extractCreatedId(null)).toBeNull();
        expect(extractCreatedId(undefined)).toBeNull();
        // A short token must not be mistaken for a Drive id.
        expect(extractCreatedId('(ID: short)')).toBeNull();
    });

    it('ignores tools that create nothing this harness has to clean up', () => {
        expect(classifyCreation('readDocument', JSON.stringify({ id: DOC_ID }))).toBeNull();
        expect(classifyCreation('listMessages', '[]')).toBeNull();
    });

});

// The whole failure mode was a claim in a comment that the code did not keep.
// An earlier version of this pin grepped each tool's source for the bare word
// `id`, which 121 of the 146 tool modules contain, so it could not fail. This
// one runs the tool.
describe('every tool CREATING_TOOLS claims to track returns an id the extractor reads', () => {
    const sources = {
        createDocument: 'dist/tools/drive/createDocument.js',
        createFolder: 'dist/tools/drive/createFolder.js',
        createDocumentFromTemplate: 'dist/tools/drive/createFromTemplate.js',
        createSpreadsheet: 'dist/tools/sheets/createSpreadsheet.js',
        createPresentation: 'dist/tools/slides/createPresentation.js',
        copyFile: 'dist/tools/drive/copyFile.js',
        uploadFile: 'dist/tools/drive/uploadFile.js',
        createDraft: 'dist/tools/gmail/drafts.js',
    };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-mcp-created-resource-'));
    const localFile = path.join(tmpDir, 'upload.txt');
    fs.writeFileSync(localFile, 'body');
    afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const args = {
        createDocument: { title: 'probe', initialContent: 'hello' },
        createFolder: { name: 'probe' },
        createDocumentFromTemplate: { templateId: 'tmpl-1', newTitle: 'probe', replacements: { '{{X}}': 'y' } },
        createSpreadsheet: { title: 'probe' },
        createPresentation: { name: 'probe', slides: [{ title: 't', content: 'c' }] },
        copyFile: { fileId: 'src-1', name: 'probe copy' },
        uploadFile: { localPath: localFile },
        createDraft: { to: ['a@example.com'], subject: 'probe', body: 'hi' },
    };
    const log = { info() {}, warn() {}, error() {}, debug() {} };

    it('lists exactly the tools this suite executes, so a new creating tool cannot be added untested', () => {
        expect(Object.keys(sources).sort()).toEqual([...CREATING_TOOLS.keys()].sort());
        expect(Object.keys(args).sort()).toEqual([...CREATING_TOOLS.keys()].sort());
    });

    for (const [toolName, rel] of Object.entries(sources)) {
        it(`${toolName}: the real return value yields the created id`, async () => {
            const { register } = await import(path.join('..', rel).replace(/\\/g, '/'));
            const tools = new Map();
            await register({ addTool: (def) => tools.set(def.name, def) });
            const tool = tools.get(toolName);
            expect(tool).toBeDefined();

            const result = await tool.execute(tool.parameters.parse(args[toolName]), { log });
            const expected = toolName === 'createDraft' ? DRAFT_ID : CREATED_ID;
            expect(extractCreatedId(result)).toBe(expected);
            expect(classifyCreation(toolName, result)).toEqual({ kind: CREATING_TOOLS.get(toolName), id: expected });
        });
    }
});
