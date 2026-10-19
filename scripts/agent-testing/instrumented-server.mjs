// Runtime construction for agent-test. This is deliberately outside dist/: it
// composes the shipped MCP factory and transports without changing application
// behavior, while placing safety, call accounting, and cleanup ownership in
// the server process that actually executes tools.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { classifyCreation } from '../live-smoke/createdResource.mjs';
import { appendJsonl, isInside, redact, resultErrorText, resultIsError, writePrivateJson } from './common.mjs';

const BLOCKED_TOOL_NAMES = new Map([
    ['sendMessage', 'agent-test never sends email.'],
    ['sendDraft', 'agent-test never sends email.'],
    ['replyMessage', 'agent-test never sends email.'],
    ['forwardMessage', 'agent-test never sends email.'],
    ['logout', 'agent-test must not change shared authentication.'],
    ['feedback', 'agent-test must not open or prepare a public GitHub issue.'],
    ['troubleshoot', 'agent-test must not refresh credentials or run browser-connected diagnostics.'],
]);

const INVALID_GRANT = /invalid_grant/i;
const REAUTH_HARDENED = new WeakSet();
const LIVE_LIMITATIONS = Object.freeze([
    'All Drive mutations are confined to a dedicated child folder created for this session under the configured test folder.',
    'Maps, local file transfers, image imports, permission changes, email sends, browser/authentication, feedback, and other uncontained side effects are blocked.',
    'A passing verdict requires successful tool work, clean transport accounting, and verified cleanup of every tracked resource.',
]);

function toolText(result) {
    if (typeof result === 'string') return result;
    if (result && Array.isArray(result.content)) return result.content.map((part) => part?.text ?? '').join('\n');
    return JSON.stringify(result ?? null);
}

function toolIsBlocked(definition) {
    const name = definition.canonicalName || definition.name;
    definition = { ...definition, name };
    if (BLOCKED_TOOL_NAMES.has(definition.name)) return BLOCKED_TOOL_NAMES.get(definition.name);
    if (definition.name.startsWith('maps')) return 'agent-test blocks Maps because its client performs independent network fetches outside the Drive-folder guard.';
    if (['uploadFile', 'downloadFile'].includes(definition.name)) return 'agent-test blocks local file transfer tools until their localPath boundary has a dedicated no-symlink implementation.';
    if (definition.name === 'insertImage') return 'agent-test blocks insertImage because localImagePath can read outside the session workspace and upload a secondary Drive asset.';
    if (['addPermission', 'updatePermission', 'removePermission'].includes(definition.name)) return 'agent-test blocks permission changes because sharing can notify or affect people outside this test session.';
    // These actions bypass Google API client methods. The Drive-folder guard
    // cannot meaningfully contain a browser launch or an authentication flow.
    if (/\b(?:open.*browser|authenticate|authentication|oauth)\b/i.test(definition.description || '')) {
        return 'agent-test blocks browser and authentication side effects.';
    }
    return null;
}

function offlineUnsupported(statusBefore, statusAfter, error) {
    if (error?.code === 'OFFLINE_UNSUPPORTED') return true;
    const before = Number(statusBefore?.counters?.unsupported ?? 0);
    const after = Number(statusAfter?.counters?.unsupported ?? 0);
    return after > before;
}

async function hardenLiveClientsAgainstReauth() {
    const { publicError } = await import('../../dist/errors.js');
    const clients = await import('../../dist/clients.js');
    const getters = [
        clients.getDriveClient, clients.getDocsClient, clients.getSheetsClient, clients.getSlidesClient,
        clients.getGmailClient, clients.getCalendarClient, clients.getTasksClient, clients.getFormsClient,
        clients.getScriptClient,
    ];
    const visit = (node, seen = new Set()) => {
        if (!node || typeof node !== 'object' || seen.has(node)) return;
        seen.add(node);
        for (const key of Object.keys(node)) {
            let value;
            try { value = node[key]; } catch { continue; }
            if (typeof value === 'function') {
                // Offline's unsupported API roots are callable Proxies. They
                // deliberately return another callable proxy for arbitrary
                // property reads, including `.bind`; treating one as a leaf
                // method would invoke it while merely installing a guard.
                if (typeof value.name !== 'string') continue;
                if (REAUTH_HARDENED.has(value)) continue;
                const original = value;
                const wrapped = async (...args) => {
                    try { return await Reflect.apply(original, node, args); }
                    catch (error) {
                        // withAuthRetry only retries this exact failure. Turn it
                        // into a public refusal at the guarded client boundary,
                        // before it can rebuild fresh uninstrumented clients.
                        const failureDetails = [
                            error?.message,
                            error?.code,
                            error?.response?.data?.error,
                            error?.response?.data?.error_description,
                        ];
                        if (failureDetails.some((detail) => INVALID_GRANT.test(String(detail || '')))) {
                            throw publicError('agent-test refused automatic credential renewal because a replacement client would require fresh safety instrumentation. Start a new session after repairing authentication.');
                        }
                        throw error;
                    }
                };
                try { node[key] = wrapped; REAUTH_HARDENED.add(wrapped); } catch {}
            } else if (value && typeof value === 'object') visit(value, seen);
        }
    };
    for (const getter of getters) {
        try { visit(await getter()); } catch {}
    }
}

async function prepareBackend(config) {
    if (config.backend === 'offline') {
        // Contract: no bootstrap/guard or dist import is allowed before this.
        const { installOfflineBackend } = await import('./offline.mjs');
        const metadata = await installOfflineBackend({ folderId: config.folderId || 'agent_test_root', workspaceDir: config.workspaceDir });
        const { getOfflineBackendStatus } = await import('./offline-clients.mjs');
        return { backend: metadata, getStatus: getOfflineBackendStatus, guard: null, folderId: metadata.folderId };
    }
    const { loadDotEnv, requireTestFolderId } = await import('../live-smoke/bootstrap.mjs');
    const { createGuard } = await import('../live-smoke/guard.mjs');
    loadDotEnv();
    const rootFolderId = config.folderId || requireTestFolderId();
    process.env.GOOGLE_MCP_WORKSPACE_DIR = config.workspaceDir;
    // Do the root preflight with the uninstrumented client. Creating a root
    // guard first would capture the same singleton client in guard.mjs's
    // module-global WeakMap and leave a later child-folder guard bound to the
    // broad root rules. The child guard below is the first and only guard.
    const { getDriveClient } = await import('../../dist/clients.js');
    const drive = await getDriveClient();
    const checked = await drive.files.get({
        fileId: rootFolderId, fields: 'id,mimeType,trashed,capabilities(canAddChildren)', supportsAllDrives: true,
    });
    const folder = checked?.data;
    if (!folder || folder.mimeType !== 'application/vnd.google-apps.folder' || folder.trashed || folder.capabilities?.canAddChildren === false) {
        throw new Error('Refusing live agent-test: configured test folder is missing, not writable, trashed, or not a Drive folder.');
    }
    let folderId = null;
    let ownership = null;
    try {
        const child = await drive.files.create({
            requestBody: {
                name: `[agent-test] ${config.runId}`,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [rootFolderId],
            }, fields: 'id,mimeType,parents', supportsAllDrives: true,
        });
        folderId = child?.data?.id;
        if (!folderId || child.data.mimeType !== 'application/vnd.google-apps.folder') {
            throw new Error('Refusing live agent-test: could not create its dedicated child test folder.');
        }
        ownership = {
            runId: config.runId,
            backend: 'live',
            rootFolderId,
            folderId,
            createdAt: new Date().toISOString(),
            state: 'created',
        };
        if (config.startupOwnershipFault === 'after-child-created') {
            throw new Error('Injected startup ownership persistence failure after child creation.');
        }
        // This must be durable before imports, tool registration, or transport
        // startup can fail. It gives a controller enough information to audit
        // and recover a child folder even if this process is forcibly lost.
        if (config.startupOwnershipFile) await writePrivateJson(config.startupOwnershipFile, ownership);
        await appendJsonl(config.journalFile, { kind: 'startup-owned-resource', ...ownership });
        const guard = createGuard({ folderId });
        await guard.ensureInstrumented();
        const { getGmailClient } = await import('../../dist/clients.js');
        const profile = await (await getGmailClient()).users.getProfile({ userId: 'me' });
        const accountFingerprint = profile?.data?.emailAddress
            ? (await import('node:crypto')).createHash('sha256').update(profile.data.emailAddress).digest('hex')
            : null;
        await hardenLiveClientsAgainstReauth();
        return {
            backend: { backend: 'live', limitations: [...LIVE_LIMITATIONS], accountVerified: Boolean(accountFingerprint), accountFingerprint },
            getStatus: () => null, guard, folderId, rootFolderId, sessionRootResource: { id: folderId, kind: 'drive', tool: 'agent-test-session-folder' },
        };
    } catch (caught) {
        const error = new Error(String(caught?.message || caught), { cause: caught });
        if (folderId) {
            const cleanup = { attempted: 1, cleaned: [], remaining: [], errors: [] };
            try {
                if (config.startupCleanupFault === 'child-trash') {
                    throw new Error('Injected child-folder cleanup failure.');
                }
                await drive.files.update({ fileId: folderId, requestBody: { trashed: true }, supportsAllDrives: true });
                try {
                    const after = await drive.files.get({ fileId: folderId, fields: 'id,trashed', supportsAllDrives: true });
                    if (!after?.data?.trashed) throw new Error('Drive did not confirm startup child cleanup.');
                } catch (failure) { if (!isNotFound(failure)) throw failure; }
                cleanup.cleaned.push(folderId);
            } catch (cleanupFailure) {
                cleanup.remaining.push(folderId);
                cleanup.errors.push({ id: folderId, error: String(cleanupFailure?.message || cleanupFailure) });
            }
            // If the durable ownership files were the operation that failed,
            // this thrown detail is the broker's final path to record exactly
            // which child exists and whether cleanup proved it is gone.
            error.agentTestStartupOwnership = {
                runId: config.runId,
                backend: 'live',
                rootFolderId,
                folderId,
                state: cleanup.remaining.length ? 'cleanup-incomplete' : 'cleaned',
                cleanup,
                ...(ownership?.createdAt ? { createdAt: ownership.createdAt } : {}),
            };
        }
        throw error;
    }
}

async function ensureSessionFilePath(args, workspaceDir, publicError) {
    if (!args?.filePath) return;
    let value;
    let workspace;
    try {
        value = await fs.realpath(path.resolve(String(args.filePath)));
        workspace = await fs.realpath(workspaceDir);
    } catch {
        throw publicError('agent-test filePath must name an existing file inside this session workspace.');
    }
    if (!isInside(value, workspace)) {
        throw publicError('agent-test accepts filePath only inside this session workspace. Use a file returned by this session or pass inline content.');
    }
}

export function makeRecorder(config, backendState) {
    const state = {
        startedAt: new Date().toISOString(),
        calls: [], notes: [], frictions: [], resources: [], unexpectedFailures: 0,
        blockedCalls: 0, offlineUnsupported: 0, cleanup: { attempted: 0, cleaned: [], remaining: [], errors: [] },
        protocolFailures: [], closed: false,
        pendingUnsupported: [],
        untrackedCreations: [],
        activeExecutions: 0,
        unresolvedExecutions: 0,
        stdoutLeaks: [],
    };
    let resolveIdle = null;
    if (backendState.sessionRootResource) state.resources.push(backendState.sessionRootResource);
    let chain = Promise.resolve();
    const serialize = (work) => {
        const queued = chain.then(work, work);
        chain = queued.catch(() => {});
        return queued;
    };
    const record = async (entry) => {
        const safe = redact(entry);
        state.calls.push(safe);
        await appendJsonl(config.journalFile, { kind: 'call', ...safe });
        return safe;
    };
    return {
        state,
        serialize,
        async execute(definition, args, context) {
            return serialize(async () => {
                state.activeExecutions += 1;
                const started = Date.now();
                const blocked = toolIsBlocked(definition);
                const before = backendState.getStatus?.();
                let guardDenialsBefore = 0;
                try {
                    if (blocked) {
                        const { publicError } = await import('../../dist/errors.js');
                        throw publicError(`${definition.name} is blocked by agent-test: ${blocked}`);
                    }
                    const { publicError } = await import('../../dist/errors.js');
                    await ensureSessionFilePath(args, config.workspaceDir, publicError);
                    if (backendState.guard) {
                        await backendState.guard.ensureInstrumented();
                        await hardenLiveClientsAgainstReauth();
                        guardDenialsBefore = backendState.guard.denialCount;
                    }
                    const realStdoutWrite = process.stdout.write.bind(process.stdout);
                    const captureStdout = (chunk, encoding, callback) => {
                        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
                        state.stdoutLeaks.push(text.slice(0, 600));
                        void appendJsonl(config.journalFile, { kind: 'stdout-leak', tool: definition.name, text: redact(text) });
                        if (typeof encoding === 'function') encoding();
                        else if (typeof callback === 'function') callback();
                        return true;
                    };
                    process.stdout.write = captureStdout;
                    let result;
                    try { result = await definition.execute(args, context); }
                    finally {
                        if (process.stdout.write === captureStdout) process.stdout.write = realStdoutWrite;
                    }
                    if (backendState.guard && backendState.guard.denialCount > guardDenialsBefore) {
                        throw publicError(backendState.guard.lastDenial?.reason || 'agent-test guard refused this operation.');
                    }
                    const creation = classifyCreation(definition.canonicalName || definition.name, toolText(result));
                    const after = backendState.getStatus?.();
                    if (creation && !creation.id) {
                        state.untrackedCreations.push({ tool: definition.name });
                        throw publicError(`${definition.name} created a resource without an extractable id, so agent-test cannot prove cleanup.`);
                    }
                    if (creation?.id && !state.resources.some((item) => item.id === creation.id)) {
                        state.resources.push({ ...creation, tool: definition.name });
                    }
                    // A tool may return an owned file even when optional initialization
                    // hit an unsupported API. Retain ownership before rejecting its verdict.
                    if (config.backend === 'offline' && offlineUnsupported(before, after)) {
                        throw publicError('This operation is unavailable in the offline agent-test backend. It is blocked/inconclusive rather than a successful test result.');
                    }
                    await record({ source: 'server-execute', tool: definition.name, args, outcome: 'ok', durationMs: Date.now() - started });
                    return result;
                } catch (error) {
                    const after = backendState.getStatus?.();
                    const unsupported = config.backend === 'offline' && offlineUnsupported(before, after, error);
                    const guardDenied = Boolean(backendState.guard && backendState.guard.denialCount > guardDenialsBefore);
                    const isBlocked = Boolean(blocked) || guardDenied || Boolean(error?.safety) || /agent-test (?:blocks|refused)|blocked by agent-test/i.test(String(error?.message || ''));
                    if (unsupported) {
                        state.offlineUnsupported += 1;
                        state.pendingUnsupported.push({ tool: definition.name });
                    } else if (isBlocked) state.blockedCalls += 1;
                    await record({
                        source: 'server-execute', tool: definition.name, args,
                        outcome: unsupported ? 'offline-unsupported' : isBlocked ? 'blocked' : 'error',
                        durationMs: Date.now() - started, error: String(error?.message || error),
                    });
                    if (unsupported) {
                        const { publicError } = await import('../../dist/errors.js');
                        throw publicError('This operation is unavailable in the offline agent-test backend. It is blocked/inconclusive rather than a successful test result.');
                    }
                    if (guardDenied && !/agent-test guard|live-smoke guard/i.test(String(error?.message || ''))) {
                        const { publicError } = await import('../../dist/errors.js');
                        throw publicError(backendState.guard.lastDenial?.reason || 'agent-test guard refused this operation.');
                    }
                    throw error;
                } finally {
                    state.activeExecutions -= 1;
                    if (state.activeExecutions === 0 && resolveIdle) { resolveIdle(); resolveIdle = null; }
                }
            });
        },
        async recordTransport(envelope, { source, expectedNegative = null, tool = null, args = null } = {}) {
            const failed = resultIsError(envelope);
            const unsupportedIndex = failed && config.backend === 'offline'
                ? state.pendingUnsupported.findIndex((entry) => entry.tool === tool) : -1;
            const unsupported = unsupportedIndex >= 0;
            if (unsupported) state.pendingUnsupported.splice(unsupportedIndex, 1);
            const allowed = failed && typeof expectedNegative === 'string' && expectedNegative.trim();
            const unexpectedSuccess = !failed && typeof expectedNegative === 'string' && expectedNegative.trim();
            if ((failed && !allowed && !unsupported) || unexpectedSuccess) state.unexpectedFailures += 1;
            await record({
                source, tool, args, outcome: failed ? (unsupported ? 'offline-unsupported' : allowed ? 'expected-negative' : 'error') : unexpectedSuccess ? 'unexpected-success' : 'ok',
                expectedNegative: allowed || null, error: failed ? resultErrorText(envelope) : null,
                envelope,
            });
        },
        async note(kind, text, tool) {
            const item = { ts: new Date().toISOString(), text: String(text), ...(tool ? { tool } : {}) };
            state[kind].push(item);
            await appendJsonl(config.journalFile, { kind, ...redact(item) });
        },
        async protocolFailure(error) {
            state.protocolFailures.push(String(error?.message || error));
            await appendJsonl(config.journalFile, { kind: 'protocol-failure', error: String(error?.message || error) });
        },
        drain() { return state.activeExecutions === 0 ? Promise.resolve() : new Promise((resolve) => { resolveIdle = resolve; }); },
    };
}

export async function createInstrumentedFactory(config) {
    const backendState = await prepareBackend(config);
    const recorder = makeRecorder(config, backendState);
    try {
        if (config.startupFactoryFault) throw new Error('Injected factory initialization failure.');
        const { prepareMcpServerFactory } = await import('../../dist/mcpServer.js');
        const { registerAllTools } = await import('../../dist/tools/index.js');
        const { PURE_RENAMES, CONSOLIDATED_ALIASES } = await import('../../dist/tools/legacyAliases.js');
        const factory = await prepareMcpServerFactory({
            registerTools: async (server) => registerAllTools({
                addTool(definition) {
                    const canonicalName = PURE_RENAMES[definition.name] || CONSOLIDATED_ALIASES[definition.name]?.target || definition.name;
                    const instrumented = { ...definition, canonicalName };
                    server.addTool({ ...definition, execute: (args, context) => recorder.execute(instrumented, args, context) });
                },
            }),
        });
        return { factory, backendState, recorder };
    } catch (caught) {
        const error = new Error(String(caught?.message || caught), { cause: caught });
        let cleanup = null;
        let cleanupError = null;
        try { cleanup = await cleanupResources({ backendState, recorder }); }
        catch (failure) { cleanupError = String(failure?.message || failure); }
        if (backendState.sessionRootResource) {
            error.agentTestStartupOwnership = {
                folderId: backendState.folderId, rootFolderId: backendState.rootFolderId, cleanup, cleanupError,
            };
        }
        if (config.startupOwnershipFile && backendState.sessionRootResource) {
            await writePrivateJson(config.startupOwnershipFile, {
                runId: config.runId, backend: config.backend, rootFolderId: backendState.rootFolderId,
                folderId: backendState.folderId, state: 'factory-failed', cleanup, cleanupError,
                updatedAt: new Date().toISOString(),
            }).catch(() => {});
        }
        throw error;
    }
}

export async function cleanupResources({ backendState, recorder }) {
    const { state } = recorder;
    if (backendState.backend.backend === 'offline') {
        const { getDriveClient } = await import('../../dist/clients.js');
        const drive = await getDriveClient();
        for (const resource of [...state.resources].reverse()) {
            state.cleanup.attempted += 1;
            try {
                await drive.files.update({ fileId: resource.id, requestBody: { trashed: true }, supportsAllDrives: true });
                state.cleanup.cleaned.push(resource.id);
            } catch (error) {
                state.cleanup.remaining.push(resource.id);
                state.cleanup.errors.push({ id: resource.id, error: String(error?.message || error) });
            }
        }
        const after = backendState.getStatus?.();
        if (Number(after?.resourceCount ?? 0) !== 0) {
            state.cleanup.remaining.push(...(after.activeFileIds?.filter((id) => id !== backendState.folderId) || ['offline-resource-count-mismatch']));
            state.cleanup.errors.push({ error: 'Offline backend still reports resources after cleanup.' });
        }
        return state.cleanup;
    }
    // The final tool call may have refreshed the OAuth client. Rebind the
    // guard first so rawDrive contains originals for that fresh client.
    await backendState.guard.ensureInstrumented();
    const rawDrive = await backendState.guard.rawDrive();
    const filesGet = rawDrive?.['files.get'];
    const filesUpdate = rawDrive?.['files.update'];
    if (typeof filesGet !== 'function' || typeof filesUpdate !== 'function') {
        for (const resource of state.resources) {
            if (resource.kind !== 'drive') continue;
            state.cleanup.remaining.push(resource.id);
            state.cleanup.errors.push({ id: resource.id, error: 'Live cleanup could not obtain uninstrumented Drive read/write methods.' });
        }
        return state.cleanup;
    }
    for (const resource of [...state.resources].reverse()) {
        state.cleanup.attempted += 1;
        try {
            if (resource.kind === 'drive') {
                // A tool can delete or trash its own resource before session
                // cleanup. Confirm that state before containment, because an
                // unreadable deleted item cannot prove its parent chain.
                let before;
                try {
                    before = (await filesGet({ fileId: resource.id, fields: 'id,trashed', supportsAllDrives: true })).data;
                } catch (error) {
                    if (isNotFound(error)) {
                        state.cleanup.cleaned.push(resource.id);
                        continue;
                    }
                    throw error;
                }
                if (before?.trashed) {
                    state.cleanup.cleaned.push(resource.id);
                    continue;
                }
                if (!(await backendState.guard.isInsideTestFolder(resource.id))) throw new Error('containment could not be re-verified');
                await filesUpdate({ fileId: resource.id, requestBody: { trashed: true }, supportsAllDrives: true });
                // Do not let an accepted update response stand in for cleanup:
                // Drive can return success while a later state fetch reveals
                // that the item still survives. A 404 also proves it is gone.
                try {
                    const after = (await filesGet({ fileId: resource.id, fields: 'id,trashed', supportsAllDrives: true })).data;
                    if (!after?.trashed) throw new Error('Drive did not report the resource as trashed after cleanup update.');
                } catch (error) {
                    if (!isNotFound(error)) throw error;
                }
            } else if (resource.kind === 'draft') {
                const { getGmailClient } = await import('../../dist/clients.js');
                try {
                    await (await getGmailClient()).users.drafts.delete({ userId: 'me', id: resource.id });
                } catch (error) {
                    if (!isNotFound(error)) throw error;
                }
            }
            state.cleanup.cleaned.push(resource.id);
        } catch (error) {
            state.cleanup.remaining.push(resource.id);
            state.cleanup.errors.push({ id: resource.id, error: String(error?.message || error) });
        }
    }
    return state.cleanup;
}

function isNotFound(error) {
    return error?.code === 404 || error?.status === 404 || error?.response?.status === 404;
}
