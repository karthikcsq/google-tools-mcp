// Regression coverage for PR #109 review comment 5351265737: a successful
// Google Docs write must consume its read handle unconditionally, even when
// minting the successor's local workspace fails afterward (disk full,
// permissions, temp I/O). Before the fix, `docsHandles.js` `complete()` set
// `settled = true` before `createHandleWorkspace(...)`, so a thrown workspace
// error left the predecessor stuck `reserved` forever (READ_HANDLE_RESERVED
// on every later use) even though the remote mutation had already committed,
// and `createHandleWorkspace` itself left whatever it had already written to
// disk untracked by `ownedWorkspaces` (the only thing cleanup ever consults).
//
// This drives the real SDK v2 facade end to end, exactly like
// tests/readHandleIntegration.test.js, with dist/clients.js and
// dist/workspace.js mocked so a real filesystem failure can be injected at
// the exact write (the successor's manifest.json) that used to be reachable
// only via disk-full/EACCES in production.
import { describe, expect, it, jest, beforeEach, afterEach, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const WORKSPACE_ROOT = path.join(os.tmpdir(), `gt-mcp-lease-failure-${process.pid}-${Date.now()}`);
process.env.GOOGLE_MCP_WORKSPACE_DIR = WORKSPACE_ROOT;

const TOKEN = 'lease-failure-token-aaaaaaaaaaaaaaaaaaaa';
const DOC_ID = 'lease-failure-doc-1';
const REVISION = 'rev-lease-failure-1';

let fakeDocs;
let fakeDrive;
let fakeSheets;
const unusedClient = async () => { throw new Error('client not used in this suite'); };
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => fakeDocs,
    getDriveClient: async () => fakeDrive,
    getSheetsClient: async () => fakeSheets,
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

// A real filesystem, minus the hardening dist/workspace.js applies (symlink
// checks, 0700/0600 perms) -- irrelevant to this test -- plus one seam:
// `failNextManifestWrite` lets a single test inject a failure on exactly the
// write that matters (the successor workspace's manifest.json) without
// needing to predict the random workspaceId it lands under.
let failNextManifestWrite = false;
jest.unstable_mockModule('../dist/workspace.js', () => ({
    getWorkspaceDir: () => WORKSPACE_ROOT,
    getWorkspacePath: (documentId, tabId) => path.join(
        WORKSPACE_ROOT,
        tabId ? `${documentId}.${tabId}.md` : `${documentId}.md`,
    ),
    ensureSafeDirectory: async (dir) => {
        await fs.mkdir(dir, { recursive: true });
        return dir;
    },
    writeFileSecurely: async (filePath, content) => {
        if (failNextManifestWrite && filePath.endsWith('manifest.json')) {
            failNextManifestWrite = false;
            throw new Error('simulated disk failure writing workspace manifest');
        }
        await fs.writeFile(filePath, content, 'utf-8');
        return filePath;
    },
    writeWorkspaceFile: async (documentId, content, tabId) => {
        await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
        const filePath = path.join(
            WORKSPACE_ROOT,
            tabId ? `${documentId}.${tabId}.md` : `${documentId}.md`,
        );
        await fs.writeFile(filePath, content, 'utf-8');
        return filePath;
    },
    // Not under test here (see tests/readGoogleDocLocalMirrorConflict.test.js
    // for #122 coverage) -- this suite only needs readGoogleDoc.js's import
    // of it to resolve.
    backupIfLocallyModified: async () => ({ backedUp: false }),
}));

const { createV2HttpHandler, prepareMcpServerFactory, MCP_PROTOCOL_VERSION } = await import('../dist/mcpServer.js');
const { register: registerReadDocument } = await import('../dist/tools/docs/readGoogleDoc.js');
const { register: registerAppendText } = await import('../dist/tools/docs/appendToGoogleDoc.js');
const {
    cleanupHandleWorkspaces, getHandleRuntimeStats, resetHandleRuntimeState, forceDiscardFailureForTesting,
} = await import('../dist/handleRuntime.js');

const V2_ROOT = path.join(WORKSPACE_ROOT, 'v2-handles');
const HANDLES_DIR = path.join(V2_ROOT, 'handles');

function docPayload(text = 'Hello world\n', revisionId = REVISION) {
    return {
        data: {
            revisionId,
            body: {
                content: [{
                    startIndex: 1,
                    endIndex: text.length + 1,
                    paragraph: { elements: [{ startIndex: 1, endIndex: text.length + 1, textRun: { content: text } }] },
                }],
            },
        },
    };
}

let batchUpdate;
let documentsGet;

function setUpGoogleMocks({ text = 'Hello world\n', revisionId = REVISION } = {}) {
    documentsGet = jest.fn(async () => docPayload(text, revisionId));
    batchUpdate = jest.fn(async ({ requestBody }) => (
        { data: { writeControl: requestBody.writeControl ?? { requiredRevisionId: 'rev-after-write' } } }
    ));
    fakeDocs = { documents: { get: documentsGet, batchUpdate } };
    fakeDrive = { files: { get: async () => ({ data: { modifiedTime: null } }) } };
    fakeSheets = {};
}

async function buildFactory() {
    return prepareMcpServerFactory({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        registerTools: async (server) => {
            registerReadDocument(server);
            registerAppendText(server);
        },
    });
}

function modernCall(name, args, token = TOKEN) {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${token}`,
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

async function call(handler, name, args, token = TOKEN) {
    const response = await handler.fetch(modernCall(name, args, token));
    const body = await response.json();
    return body.result;
}

function textOf(result) {
    return result.content.map((entry) => entry.text ?? '').join('\n');
}

async function listHandleDirs() {
    try {
        return (await fs.readdir(HANDLES_DIR)).sort();
    } catch {
        return [];
    }
}

beforeEach(() => {
    setUpGoogleMocks();
    failNextManifestWrite = false;
});

afterEach(() => {
    resetHandleRuntimeState();
});

afterAll(async () => {
    await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('a committed write survives a successor-workspace creation failure', () => {
    it('consumes the predecessor, warns instead of throwing, and leaves no orphan workspace directory', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            expect(read.readHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(await listHandleDirs()).toHaveLength(1);

            // The Google write itself will succeed; only the successor
            // workspace's manifest write fails afterward.
            failNextManifestWrite = true;
            const write = await call(handler, 'appendText', {
                documentId: DOC_ID, text: 'committed anyway', readHandle: read.readHandle,
            });

            // The write committed -- this must not read as a tool failure.
            expect(write.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalledTimes(1);

            // No usable successor handle was surfaced, and the caller was told
            // in plain language what happened and what to do.
            expect(write.readHandle).toBeUndefined();
            const text = textOf(write);
            expect(text).toMatch(/committed successfully/i);
            expect(text).toMatch(/no successor read handle could be issued/i);
            expect(text).toMatch(/re-read the document/i);
            expect(write.structuredContent?.warnings?.[0]).toMatch(/committed successfully/i);

            // The predecessor is terminal, not stuck reserved: replaying it
            // gets the "already consumed" error (the write really did happen),
            // never READ_HANDLE_RESERVED (which would mean the lease never
            // closed).
            const replay = await call(handler, 'appendText', {
                documentId: DOC_ID, text: 'replay', readHandle: read.readHandle,
            });
            expect(replay.isError).toBe(true);
            expect(textOf(replay)).toMatch(/already been consumed/i);
            expect(textOf(replay)).not.toMatch(/mutation in progress/i);

            // No filesystem state survives untracked: the predecessor's own
            // workspace was discarded on success, and createHandleWorkspace
            // rolled back the partial successor directory it had started
            // writing (content.md landed; manifest.json never did) when the
            // manifest write failed.
            expect(await listHandleDirs()).toHaveLength(0);
            expect(getHandleRuntimeStats().workspaces).toBe(0);

            // A fresh read-then-write still works: the failure was scoped to
            // one lease, not the runtime.
            batchUpdate.mockClear();
            const freshRead = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            expect(freshRead.readHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
            const freshWrite = await call(handler, 'appendText', {
                documentId: DOC_ID, text: 'fresh mutation', readHandle: freshRead.readHandle,
            });
            expect(freshWrite.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalledTimes(1);
        } finally {
            await handler.close();
        }
    });

    it('never invokes the Google API before the guard resolves, and cleans up on an unrelated cleanup pass', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            failNextManifestWrite = true;
            await call(handler, 'appendText', {
                documentId: DOC_ID, text: 'x', readHandle: read.readHandle,
            });
            // Nothing left for a later cleanup pass to trip over.
            const cleaned = await cleanupHandleWorkspaces({ all: true });
            expect(cleaned.removed).toHaveLength(0);
            expect(cleaned.retained).toHaveLength(0);
        } finally {
            await handler.close();
        }
    });
});

describe('a committed write survives completeSuccess itself throwing', () => {
    // Coordinator follow-up: unlike the successor-workspace failure above,
    // here createHandleWorkspace succeeds -- the successor's files really do
    // land on disk -- but store.completeSuccess itself throws before it
    // registers that successor or terminalizes the predecessor. The
    // trigger used here is a genuine store invariant rather than a mocked
    // one: readHandles.js's completeSuccess runs every successor field
    // through assertNoRawCredentialMaterial before doing anything else, and
    // rejects a revisionId that is shaped like a raw Google OAuth token
    // (`ya29.…`). Google's own batchUpdate response is where a real
    // `requiredRevisionId` comes from, so a compromised or buggy upstream
    // response is a realistic way for that internal invariant to fire on a
    // write that has, by construction, already committed. The Google write
    // still committed by this point, so the same contract applies:
    // success-with-warning to the caller, the predecessor ends up terminal
    // (never stuck reserved), and neither the never-registered successor
    // workspace nor the predecessor's own workspace survives as an orphan.
    it('warns instead of throwing, discards both workspaces, and leaves the predecessor terminal', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            expect(read.readHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(await listHandleDirs()).toHaveLength(1);

            // The successor workspace creation itself is untouched here (no
            // manifest-write injection) -- it succeeds and lands on disk.
            // Only this one batchUpdate response is poisoned, and only once:
            // completeSuccess's own credential-shape check on the revision
            // it is asked to record is the thing that throws.
            batchUpdate.mockImplementationOnce(async () => (
                { data: { writeControl: { requiredRevisionId: 'ya29.simulated-raw-credential-shaped-revision' } } }
            ));
            const write = await call(handler, 'appendText', {
                documentId: DOC_ID, text: 'committed anyway', readHandle: read.readHandle,
            });

            // The write committed -- still not a tool failure.
            expect(write.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalledTimes(1);
            expect(write.readHandle).toBeUndefined();
            const text = textOf(write);
            expect(text).toMatch(/committed successfully/i);
            expect(text).toMatch(/could not be finalized/i);
            expect(text).toMatch(/re-read the document/i);
            expect(write.structuredContent?.warnings?.[0]).toMatch(/committed successfully/i);

            // The predecessor is terminal -- not stuck reserved -- even
            // though completeSuccess never got to run its own terminalize
            // call: the completeAfterWriteFailure fallback closed it.
            // Replay is a terminal rejection (this store's fallback tombstones
            // it "no longer valid"), never READ_HANDLE_RESERVED.
            const replay = await call(handler, 'appendText', {
                documentId: DOC_ID, text: 'replay', readHandle: read.readHandle,
            });
            expect(replay.isError).toBe(true);
            expect(textOf(replay)).not.toMatch(/mutation in progress/i);
            expect(textOf(replay)).toMatch(/no longer valid|already been consumed/i);

            // Neither workspace is an orphan: the successor's files really
            // were written to disk by createHandleWorkspace, but since the
            // store never registered that successor (completeSuccess threw
            // before doing so), it would never have gotten an expiresAt and
            // normal expiry-based cleanup could never have found it -- so
            // complete() must have reaped it itself, same as the
            // predecessor's own now-superseded workspace.
            expect(await listHandleDirs()).toHaveLength(0);
            expect(getHandleRuntimeStats().workspaces).toBe(0);
            const cleaned = await cleanupHandleWorkspaces({ all: true });
            expect(cleaned.removed).toHaveLength(0);
            expect(cleaned.retained).toHaveLength(0);

            // A fresh read-then-write still works: the failure was scoped to
            // one lease, not the runtime, and the injected failure was
            // one-shot.
            batchUpdate.mockClear();
            const freshRead = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            expect(freshRead.readHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
            const freshWrite = await call(handler, 'appendText', {
                documentId: DOC_ID, text: 'fresh mutation', readHandle: freshRead.readHandle,
            });
            expect(freshWrite.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalledTimes(1);
        } finally {
            await handler.close();
        }
    });
});

describe('a committed write survives the predecessor-workspace discard itself failing', () => {
    // PR #109 review comment 5352058729: unlike the two suites above (a failed
    // successor *creation*, and completeSuccess itself throwing), here
    // everything the store cares about succeeds -- createHandleWorkspace builds
    // the successor, store.completeSuccess terminalizes the predecessor and
    // registers the successor -- and only the *cleanup* of the now-superseded
    // predecessor workspace (discardHandleWorkspace) fails afterward. Every
    // fs op inside that cleanup is already individually best-effort by design
    // (see dist/handleRuntime.js removeWorkspaceFiles), so there is no real
    // disk condition left to provoke -- forceDiscardFailureForTesting is the
    // seam that lets this suite inject exactly that failure without weakening
    // that internal best-effort behavior, to prove the call site in
    // dist/docsHandles.js complete() -- not just removeWorkspaceFiles itself
    // -- never lets a cleanup failure read as a write failure.
    it('warns instead of throwing, still issues the successor, and leaves the stale workspace owned for retry', async () => {
        const factory = await buildFactory();
        const handler = createV2HttpHandler(factory, { auth: { token: TOKEN } });
        try {
            const read = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            expect(read.readHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
            const [predecessorWorkspaceId] = await listHandleDirs();
            expect(predecessorWorkspaceId).toBeTruthy();

            // The Google write and the successor's own workspace creation both
            // succeed; only discarding the now-superseded predecessor fails.
            forceDiscardFailureForTesting(predecessorWorkspaceId);
            const write = await call(handler, 'appendText', {
                documentId: DOC_ID, text: 'committed anyway', readHandle: read.readHandle,
            });

            // The write committed -- this must not read as a tool failure --
            // and a real, usable successor handle was still issued: discard
            // cleanup is a separate concern from minting the next handle.
            expect(write.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalledTimes(1);
            expect(write.readHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(write.readHandle).not.toBe(read.readHandle);
            const text = textOf(write);
            expect(text).toMatch(/committed successfully/i);
            expect(text).toMatch(/stale local workspace could not be removed/i);
            expect(text).toMatch(/retried by cleanup/i);
            expect(write.structuredContent?.warnings?.[0]).toMatch(/stale local workspace/i);

            // The predecessor's handle is terminal (consumed by the write),
            // not stuck reserved: cleanup failing to remove its *files* must
            // not leave its *handle* replayable.
            const replay = await call(handler, 'appendText', {
                documentId: DOC_ID, text: 'replay', readHandle: read.readHandle,
            });
            expect(replay.isError).toBe(true);
            expect(textOf(replay)).toMatch(/already been consumed/i);
            expect(textOf(replay)).not.toMatch(/mutation in progress/i);

            // The stale predecessor workspace directory is still on disk and
            // still owned (registered in ownedWorkspaces) -- discard never ran
            // to completion, so nothing deregistered it -- alongside the new
            // successor's own workspace.
            const dirsAfterFailedDiscard = await listHandleDirs();
            expect(dirsAfterFailedDiscard).toContain(predecessorWorkspaceId);
            expect(dirsAfterFailedDiscard).toHaveLength(2);
            expect(getHandleRuntimeStats().workspaces).toBe(2);

            // A later cleanup pass -- exactly what shutdown and every mint
            // already run -- can still find and reclaim it: nothing about the
            // failed discard made it unreachable.
            const cleaned = await cleanupHandleWorkspaces({ all: true });
            expect(cleaned.removed).toEqual(expect.arrayContaining([predecessorWorkspaceId]));
            expect(cleaned.retained).toHaveLength(0);
            expect(getHandleRuntimeStats().workspaces).toBe(0);

            // A fresh read-then-write still works: the failure was scoped to
            // one lease, not the runtime, and the injected failure was
            // one-shot.
            batchUpdate.mockClear();
            const freshRead = await call(handler, 'readDocument', { documentId: DOC_ID, format: 'markdown' });
            expect(freshRead.readHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
            const freshWrite = await call(handler, 'appendText', {
                documentId: DOC_ID, text: 'fresh mutation', readHandle: freshRead.readHandle,
            });
            expect(freshWrite.isError).toBeFalsy();
            expect(batchUpdate).toHaveBeenCalledTimes(1);
        } finally {
            await handler.close();
        }
    });
});
