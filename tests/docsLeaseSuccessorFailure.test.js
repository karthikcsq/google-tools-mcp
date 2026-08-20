// A lease that fails to settle AFTER a successful write must not be reported
// as a failed write (issue #88 follow-up to the #107 review finding).
//
// `lease.complete()` does more than bookkeeping: on the v2 runtime it creates
// the successor handle's workspace on disk, and that can fail on its own (a
// full disk, a workspace directory that stopped being writable). The shared
// `lease.write()` helper folds the write and the settle into one try, so such a
// failure surfaces as though Google had rejected the batch. That distinction
// matters more than it looks: "the write failed" invites a retry, and retrying
// a batch that Google already applied edits the document twice.
//
// Both tools therefore call complete() outside the write's try and downgrade a
// throw to a warning with re-read guidance. dist/docsHandles.js is mocked here
// because there is no other way to make a successful write's settle fail.
import { describe, it, expect, jest } from '@jest/globals';
import { z } from 'zod';

let fakeDocs;
let fakeDrive;
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => fakeDocs,
    getDriveClient: async () => fakeDrive,
    getSheetsClient: async () => { throw new Error('not used'); },
    getCalendarClient: async () => { throw new Error('not used'); },
}));

const settled = { completeCalls: 0, failCalls: 0, abortCalls: 0 };
jest.unstable_mockModule('../dist/docsHandles.js', () => ({
    ReadHandleParameter: z.string().optional(),
    mintDocsReadHandle: async () => null,
    beginDocsMutation: async () => ({
        active: true,
        revisionId: 'rev-read',
        writeControlFor: () => ({ requiredRevisionId: 'rev-read' }),
        async complete() {
            settled.completeCalls += 1;
            throw new Error('successor workspace could not be created');
        },
        async fail() { settled.failCalls += 1; },
        async abort() { settled.abortCalls += 1; },
        async requireReread() {},
    }),
}));

const { register: registerBatch } = await import('../dist/tools/docs/batchModifyText.js');
const { register: registerReplace } = await import('../dist/tools/utils/replaceDocumentWithMarkdown.js');

const noopLog = { info() {}, error() {}, warn() {}, debug() {} };

function getTool(register, name) {
    const tools = new Map();
    register({ addTool(def) { tools.set(def.name, def); } });
    return tools.get(name);
}

function setUpGoogle() {
    const text = 'Alpha one\n';
    const body = {
        content: [{
            startIndex: 1,
            endIndex: 1 + text.length,
            paragraph: { elements: [{ startIndex: 1, endIndex: 1 + text.length, textRun: { content: text } }] },
        }],
    };
    const batchUpdate = jest.fn(async () => ({ data: { writeControl: { requiredRevisionId: 'rev-after' } } }));
    fakeDocs = {
        documents: {
            get: jest.fn(async ({ fields }) => {
                if (fields === 'namedStyles') return { data: { namedStyles: { styles: [] } } };
                return { data: { revisionId: 'rev-read', body } };
            }),
            batchUpdate,
        },
    };
    fakeDrive = {
        files: { get: async () => ({ data: { modifiedTime: null } }) },
        comments: { list: async () => ({ data: { comments: [] } }) },
    };
    return { batchUpdate };
}

describe('a successor-handle failure after a successful write', () => {
    it('batchModifyText reports it as a warning, not as a failed write', async () => {
        settled.completeCalls = 0;
        settled.failCalls = 0;
        const { batchUpdate } = setUpGoogle();

        const result = await getTool(registerBatch, 'batchModifyText').execute({
            documentId: 'lease-doc-1',
            operations: [{ target: { startIndex: 7, endIndex: 10 }, text: 'ONE' }],
        }, { log: noopLog });

        expect(batchUpdate).toHaveBeenCalledTimes(1);
        expect(settled.completeCalls).toBe(1);
        // Crucially NOT settled as a failed write: the document really did change.
        expect(settled.failCalls).toBe(0);
        expect(result).toContain('Applied 1 operation(s)');
        expect(result).toContain('WARNING:');
        expect(result).toContain('Do NOT retry this call');
        expect(result).toContain('readDocument');
        // The internal cause never reaches the caller.
        expect(result).not.toContain('successor workspace could not be created');
    });

    it('replaceDocumentWithMarkdown reports it as a warning, not as a failed write', async () => {
        settled.completeCalls = 0;
        settled.failCalls = 0;
        const { batchUpdate } = setUpGoogle();

        const result = await getTool(registerReplace, 'replaceDocumentWithMarkdown').execute({
            documentId: 'lease-doc-2',
            markdown: '# Fresh\n\nbody\n',
        }, { log: noopLog });

        expect(batchUpdate).toHaveBeenCalled();
        expect(settled.completeCalls).toBe(1);
        expect(settled.failCalls).toBe(0);
        expect(result).toContain('Successfully replaced document content');
        expect(result).toContain('WARNING:');
        expect(result).toContain('Do NOT retry this call');
        expect(result).not.toContain('successor workspace could not be created');
    });
});
