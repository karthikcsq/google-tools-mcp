import http from 'node:http';
import * as fs from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { createInstrumentedFactory, cleanupResources } from './instrumented-server.mjs';
import { appendJsonl, codeIdentity, compactToolSearch, publicManifest, readPrivateJson, redact, resultIsError, writePrivateJson } from './common.mjs';
import { StdioRpcClient } from './stdio-client.mjs';

function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
}

async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
}

function authOk(req, token) {
    return req.headers.authorization === `Bearer ${token}`;
}

function responseEnvelope(text) {
    try { return JSON.parse(text); } catch { return { error: { code: 'TRANSPORT_INVALID_RESPONSE', message: 'MCP response was not JSON.' } }; }
}

function createInProcessStdioClient(factory, timeoutMs) {
    return (async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        const { startV2Stdio } = await import('../../dist/mcpServer.js');
        const runtime = startV2Stdio(factory, { input, output });
        const client = new StdioRpcClient({ stdin: input, stdout: output, once() {} }, { timeoutMs });
        client.close = async () => { input.end(); await runtime.close(); };
        return client;
    })();
}

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
}

async function ownedFetch(url, init, timeoutMs = 60_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetch(url, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timer); }
}

function snapshot({ config, recorder, finalOutcome = null }) {
    const state = recorder.state;
    const transportCalls = state.calls.filter((call) => call.source !== 'server-execute' && call.tool);
    const meaningfulCalls = transportCalls.length;
    const successfulCalls = transportCalls.filter((call) => call.outcome === 'ok').length;
    return redact({
        runId: config.runId, backend: config.backend, transport: config.transport, goal: config.goal,
        startedAt: state.startedAt, finishedAt: state.closed ? new Date().toISOString() : null,
        finalOutcome, folderId: config.folderId, workspaceDir: config.workspaceDir, limitations: config.limitations || [],
        totals: {
            meaningfulCalls, successfulCalls, unexpectedFailures: state.unexpectedFailures, blockedCalls: state.blockedCalls,
            offlineUnsupported: state.offlineUnsupported, frictions: state.frictions.length,
            notes: state.notes.length, untrackedCreations: state.untrackedCreations.length,
            cleanupRemaining: state.cleanup.remaining.length, protocolFailures: state.protocolFailures.length,
            unresolvedExecutions: state.unresolvedExecutions,
            stdoutLeaks: state.stdoutLeaks.length,
        },
        notes: state.notes, frictions: state.frictions, cleanup: state.cleanup,
        untrackedCreations: state.untrackedCreations, calls: state.calls, codeIdentity: config.codeIdentity,
        journalFile: config.journalFile,
    });
}

function strictVerdict(report, outcome) {
    const totals = report.totals;
    const reasons = [];
    if (outcome !== 'pass') reasons.push(`tester outcome is ${outcome}`);
    if (!totals.meaningfulCalls) reasons.push('no meaningful tool calls');
    if (!totals.successfulCalls) reasons.push('no successful tool calls');
    if (totals.unexpectedFailures) reasons.push(`${totals.unexpectedFailures} unexpected failure(s)`);
    if (totals.frictions) reasons.push(`${totals.frictions} recorded friction item(s)`);
    if (totals.blockedCalls) reasons.push(`${totals.blockedCalls} blocked call(s)`);
    if (totals.offlineUnsupported) reasons.push(`${totals.offlineUnsupported} offline-unsupported call(s)`);
    if (totals.cleanupRemaining) reasons.push(`${totals.cleanupRemaining} cleanup item(s) remaining`);
    if (totals.untrackedCreations) reasons.push(`${totals.untrackedCreations} untracked creation(s)`);
    if (totals.protocolFailures) reasons.push(`${totals.protocolFailures} protocol failure(s)`);
    if (totals.stdoutLeaks) reasons.push(`${totals.stdoutLeaks} stdout leak(s)`);
    return { strictPass: reasons.length === 0, reasons };
}

async function main() {
    const configArg = process.argv.indexOf('--config');
    if (configArg < 0 || !process.argv[configArg + 1]) throw new Error('broker requires --config <private-session-config>.');
    const config = await readPrivateJson(process.argv[configArg + 1]);
    if (config.backend === 'live') {
        const { installReadOnlyAuth } = await import('./live-auth-install.mjs');
        installReadOnlyAuth();
    }
    let factory = null;
    let backendState = null;
    let recorder = null;
    let mcpRuntime = null;
    let stdioClient = null;
    let nativeServer = null;
    let nativeUrl = null;
    let control = null;
    let startupPhase = 'configuration';
    let startupCancellation = null;
    let startupPauseResolve = null;
    let startupDeadlineTimer = null;
    let ready = false;
    let readyShutdown = null;

    const requestStartupCancellation = (reason) => {
        if (ready || startupCancellation) return;
        startupCancellation = String(reason);
        if (startupPauseResolve) startupPauseResolve();
    };
    const onMessage = (message) => {
        if (message?.type === 'cancel-startup') requestStartupCancellation('controller requested cooperative startup cancellation');
    };
    const onSignal = (signal) => {
        if (!ready) requestStartupCancellation(`broker received ${signal} during startup`);
        else if (readyShutdown) void readyShutdown(signal);
    };
    process.on('message', onMessage);
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    process.once('SIGINT', () => onSignal('SIGINT'));
    if (config.startupDeadlineAt) {
        const delay = Math.max(0, config.startupDeadlineAt - Date.now());
        startupDeadlineTimer = setTimeout(() => requestStartupCancellation('agent-test startup deadline elapsed before the broker became ready'), delay);
        startupDeadlineTimer.unref?.();
    }
    const checkpoint = async (phase) => {
        startupPhase = phase;
        if (startupCancellation) throw new Error(startupCancellation);
        if (config.startupDeadlineAt && Date.now() > config.startupDeadlineAt) {
            throw new Error('agent-test startup deadline elapsed before the broker became ready');
        }
        if (config.startupFault === phase) throw new Error(`Injected agent-test startup failure at ${phase}.`);
        if (config.startupPauseAt === phase) {
            if (config.startupPauseFile) {
                await writePrivateJson(config.startupPauseFile, { phase, at: new Date().toISOString() });
            }
            await new Promise((resolve) => { startupPauseResolve = resolve; });
            startupPauseResolve = null;
        }
        if (startupCancellation) throw new Error(startupCancellation);
    };
    const closeServer = async (server) => {
        if (!server?.listening) return;
        await new Promise((resolve) => server.close(() => resolve()));
    };
    const closeStartupSurfaces = async () => {
        const errors = [];
        for (const close of [
            () => closeServer(control),
            () => closeServer(nativeServer),
            () => stdioClient?.close(),
            () => mcpRuntime?.close(),
        ]) {
            try { await close(); } catch (error) { errors.push(String(error?.message || error)); }
        }
        return errors;
    };
    const recordStartupFailure = async (error) => {
        if (startupDeadlineTimer) clearTimeout(startupDeadlineTimer);
        // Make the broker unreachable before trashing resources. No transport
        // can begin work before manifest publication, but this order also
        // protects future startup stages from racing cleanup.
        const closeErrors = await closeStartupSurfaces();
        const inheritedOwnership = error?.agentTestStartupOwnership || null;
        let cleanup = inheritedOwnership?.cleanup || null;
        let cleanupError = inheritedOwnership?.cleanupError || null;
        if (backendState && recorder) {
            try { cleanup = await cleanupResources({ backendState, recorder }); }
            catch (failure) { cleanupError = String(failure?.message || failure); }
        }
        await fs.unlink(config.manifestFile).catch(() => {});
        const ownedResource = backendState?.sessionRootResource
            ? { id: backendState.sessionRootResource.id, kind: 'drive', rootFolderId: backendState.rootFolderId }
            : inheritedOwnership ? { id: inheritedOwnership.folderId, kind: 'drive', rootFolderId: inheritedOwnership.rootFolderId } : null;
        const evidence = {
            error: redact(String(error?.message || error)), at: new Date().toISOString(), phase: startupPhase,
            cancelled: startupCancellation, partialRuntimeClosed: closeErrors.length === 0,
            ...(closeErrors.length ? { closeErrors } : {}), ...(cleanup ? { cleanup } : {}), ...(cleanupError ? { cleanupError } : {}),
            ...(ownedResource ? { ownedResource } : {}),
        };
        if (config.startupOwnershipFile && ownedResource) {
            await writePrivateJson(config.startupOwnershipFile, {
                runId: config.runId, backend: config.backend, rootFolderId: ownedResource.rootFolderId,
                folderId: ownedResource.id,
                state: cleanup?.remaining?.length || cleanupError ? 'cleanup-incomplete' : 'cleaned',
                cleanup, cleanupError, updatedAt: new Date().toISOString(),
            }).catch(() => {});
        }
        await appendJsonl(config.journalFile, { kind: 'startup-failure', ...evidence }).catch(() => {});
        await writePrivateJson(config.startupErrorFile, evidence).catch(() => {});
        if (process.connected) process.disconnect();
        error.agentTestStartupRecorded = true;
    };

    try {
        await checkpoint('before-factory');
        config.codeIdentity = await codeIdentity();
        await checkpoint('factory');
        ({ factory, backendState, recorder } = await createInstrumentedFactory(config));
        await checkpoint('after-factory');
        config.folderId = backendState.folderId;
        config.limitations = backendState.backend.limitations || [];
        const expectedCalls = new Map();
        if (config.transport === 'http') {
            const { startV2HttpServer } = await import('../../dist/mcpServer.js');
            mcpRuntime = await startV2HttpServer(factory, {
                host: '127.0.0.1', port: 0, auth: { token: config.nativeToken }, profile: 'agent-test',
            });
            await checkpoint('after-transport');
            const internalUrl = `http://127.0.0.1:${mcpRuntime.server.address().port}/mcp`;
            nativeServer = http.createServer(async (req, res) => {
                if (req.url !== '/mcp') return json(res, 404, { error: 'Not found' });
                if (!authOk(req, config.nativeToken)) return json(res, 401, { error: 'Unauthorized' });
                if (closing) return json(res, 503, { error: 'Agent-test session is closing.' });
                activeRequests += 1;
                const chunks = [];
                try {
                    for await (const chunk of req) chunks.push(chunk);
                    const body = Buffer.concat(chunks);
                    let call = null;
                    try { call = JSON.parse(body.toString('utf8')); } catch {}
                    const headers = { ...req.headers };
                    delete headers.host; delete headers.connection; delete headers['content-length'];
                    const response = await ownedFetch(internalUrl, { method: req.method, headers, body: body.length ? body : undefined }, config.callTimeoutMs);
                    const text = await response.text();
                    if (call?.method === 'tools/call') {
                        const expectedNegative = req.headers['x-agent-test-call-id'] ? expectedCalls.get(String(req.headers['x-agent-test-call-id'])) : null;
                        if (req.headers['x-agent-test-call-id']) expectedCalls.delete(String(req.headers['x-agent-test-call-id']));
                        await recorder.recordTransport(responseEnvelope(text), {
                            source: 'native-http', tool: call.params?.name || null, args: call.params?.arguments || null, expectedNegative,
                        });
                    }
                    res.writeHead(response.status, Object.fromEntries(response.headers.entries())); res.end(text);
                } catch (error) {
                    const envelope = { error: { code: 'TRANSPORT_FAILURE', message: 'The agent-test HTTP gateway could not reach its owned MCP server.' } };
                    await recorder.recordTransport(envelope, { source: 'native-http' });
                    json(res, 502, envelope);
                } finally {
                    activeRequests -= 1;
                    if (activeRequests === 0 && resolveDrain) { resolveDrain(); resolveDrain = null; }
                }
            });
            nativeUrl = `http://127.0.0.1:${await listen(nativeServer)}/mcp`;
            await checkpoint('after-native-listen');
        } else {
            stdioClient = await createInProcessStdioClient(factory, config.callTimeoutMs);
            // Establish the actual MCP connection before the session becomes visible.
            await stdioClient.discover();
            await checkpoint('after-stdio-discover');
        }

        let closed = false;
        let closing = false;
        let finishPromise = null;
        let activeRequests = 0;
        let resolveDrain = null;
        const drain = () => activeRequests === 0 ? Promise.resolve() : new Promise((resolve) => { resolveDrain = resolve; });
        let deadlineTimer = null;
        const touch = () => {
            if (closing) return;
            if (deadlineTimer) clearTimeout(deadlineTimer);
            deadlineTimer = setTimeout(() => { void finish('blocked', 'Session expired before tester finished it.'); }, config.sessionTimeoutMs);
        };
        const closeRuntime = async () => {
            if (closed) return;
            closed = true;
            if (deadlineTimer) clearTimeout(deadlineTimer);
            if (nativeServer) await new Promise((resolve) => nativeServer.close(resolve));
            if (stdioClient) await stdioClient.close();
            if (mcpRuntime) await mcpRuntime.close();
        };
        const finish = (outcome, summary) => {
            if (finishPromise) return finishPromise;
            closing = true;
            if (deadlineTimer) clearTimeout(deadlineTimer);
            finishPromise = (async () => {
                const drained = await Promise.race([
                    Promise.all([drain(), recorder.drain()]).then(() => true),
                    new Promise((resolve) => setTimeout(() => resolve(false), config.callTimeoutMs)),
                ]);
                if (!drained) {
                    recorder.state.unresolvedExecutions += recorder.state.activeExecutions;
                    recorder.state.protocolFailures.push('A pending tool call exceeded the owned session timeout during shutdown.');
                    // A still-running tool could create or alter a resource after
                    // this point. Never race cleanup against that mutation or
                    // claim a clean report; retain the child folder for audit.
                    recorder.state.cleanup.remaining.push('cleanup-skipped-unresolved-execution');
                    recorder.state.cleanup.errors.push({ error: 'Cleanup was skipped because an active tool call did not drain before the session timeout.' });
                } else {
                    await cleanupResources({ backendState, recorder });
                }
                recorder.state.closed = true;
                const report = snapshot({ config, recorder, finalOutcome: outcome });
                report.summary = String(summary || '');
                report.verdict = strictVerdict(report, outcome);
                await writePrivateJson(config.reportFile, report);
                await appendJsonl(config.journalFile, { kind: 'finish', outcome, summary: report.summary, verdict: report.verdict });
                await closeRuntime();
                if (control) setTimeout(() => control.close(() => process.exit(0)), 100);
                return report;
            })();
            return finishPromise;
        };

        const runCommand = async (body) => {
            if (body.command === 'finish') {
                if (!['pass', 'fail', 'blocked'].includes(body.outcome)) throw new Error('finish requires outcome pass, fail, or blocked.');
                return finish(body.outcome, body.summary);
            }
            if (closing && body.command !== 'status') throw new Error('Agent-test session is closing; no new work is accepted.');
            activeRequests += 1;
            try {
            touch();
            const command = body.command;
            if (command === 'list') {
                const envelope = config.transport === 'http'
                    ? await (await ownedFetch(nativeUrl, { method: 'POST', headers: { authorization: `Bearer ${config.nativeToken}`, 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) }, config.callTimeoutMs)).json()
                    : await stdioClient.listTools();
                if (body.search !== undefined) {
                    if (typeof body.search !== 'string' || !body.search.trim()) throw new Error('list --search requires non-empty text.');
                    return compactToolSearch(envelope, body.search);
                }
                return envelope;
            }
            if (command === 'describe') {
                const list = await runCommand({ command: 'list' });
                const tool = list?.result?.tools?.find((item) => item.name === body.tool);
                if (!tool) throw new Error(`No tool named ${body.tool}.`);
                return { tool };
            }
            if (command === 'call') {
                if (typeof body.tool !== 'string' || !body.tool) throw new Error('call requires a tool name.');
                if (body.expectedNegative !== undefined && (typeof body.expectedNegative !== 'string' || !body.expectedNegative.trim())) {
                    throw new Error('expected-negative must be a non-empty reason declared before execution.');
                }
                await appendJsonl(config.journalFile, { kind: 'call-declared', tool: body.tool, args: redact(body.args || {}), expectedNegative: body.expectedNegative || null });
                let envelope;
                if (config.transport === 'http') {
                    const callId = `${Date.now()}-${Math.random()}`;
                    expectedCalls.set(callId, body.expectedNegative || null);
                    const response = await ownedFetch(nativeUrl, { method: 'POST', headers: { authorization: `Bearer ${config.nativeToken}`, 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': body.tool, 'x-agent-test-call-id': callId }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: body.tool, arguments: body.args || {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) }, config.callTimeoutMs);
                    envelope = responseEnvelope(await response.text());
                } else {
                    try {
                        envelope = await stdioClient.callTool(body.tool, body.args || {});
                        await recorder.recordTransport(envelope, { source: 'broker-stdio', tool: body.tool, args: body.args || {}, expectedNegative: body.expectedNegative || null });
                    } catch (error) {
                        const failures = stdioClient.protocolFailures.splice(0);
                        if (failures.length) {
                            for (const failure of failures) await recorder.protocolFailure(failure.error);
                        } else {
                            await recorder.protocolFailure(error);
                        }
                        throw error;
                    }
                    for (const failure of stdioClient.protocolFailures.splice(0)) await recorder.protocolFailure(failure.error);
                }
                return envelope;
            }
            if (command === 'note' || command === 'friction') {
                if (typeof body.text !== 'string' || !body.text.trim()) throw new Error(`${command} requires non-empty text.`);
                await recorder.note(command === 'note' ? 'notes' : 'frictions', body.text, body.tool);
                return { ok: true };
            }
            if (command === 'status') return snapshot({ config, recorder });
            throw new Error(`Unknown agent-test broker command: ${command}`);
            } finally {
                activeRequests -= 1;
                if (activeRequests === 0 && resolveDrain) { resolveDrain(); resolveDrain = null; }
            }
        };

        control = http.createServer(async (req, res) => {
            if (req.method !== 'POST' || req.url !== '/control') return json(res, 404, { error: 'Not found' });
            if (!authOk(req, config.controlToken)) return json(res, 401, { error: 'Unauthorized' });
            try { json(res, 200, await runCommand(await readJson(req))); }
            catch (error) { json(res, 400, { error: String(error?.message || error) }); }
        });
        const controlPort = await listen(control);
        await checkpoint('after-control-listen');
        const manifest = {
            version: 1, runId: config.runId, backend: config.backend, transport: config.transport, goal: config.goal,
            manifestPath: config.manifestFile, reportPath: config.reportFile, journalPath: config.journalFile,
            controlUrl: `http://127.0.0.1:${controlPort}/control`, controlToken: config.controlToken,
            folderId: backendState.folderId, workspaceDir: config.workspaceDir, limitations: backendState.backend.limitations,
            ...(nativeUrl ? { nativeMcp: { url: nativeUrl, token: config.nativeToken } } : {}),
            state: 'ready', startedAt: new Date().toISOString(), codeIdentity: config.codeIdentity,
        };
        await checkpoint('before-manifest');
        await appendJsonl(config.journalFile, { kind: 'session-ready', manifest: publicManifest(manifest), backend: backendState.backend });
        await checkpoint('after-session-ready-journal');
        const shutdown = async (signal) => {
            if (!recorder.state.closed) await finish('blocked', `Broker received ${signal}.`);
            control.close();
            process.exit(0);
        };
        readyShutdown = shutdown;
        // This is the final fallible startup action. All journal/checkpoint work
        // and the ready shutdown path exist before a controller can observe it.
        await writePrivateJson(config.manifestFile, manifest);
        // No awaited or fallible startup work follows this synchronous timer arm.
        touch();
        ready = true;
        if (startupDeadlineTimer) clearTimeout(startupDeadlineTimer);
        process.removeListener('message', onMessage);
        if (process.connected) process.disconnect();
    } catch (caught) {
        // Public errors are frozen; keep reporting state on an owned wrapper.
        const error = new Error(String(caught?.message || caught), { cause: caught });
        if (caught?.agentTestStartupOwnership) error.agentTestStartupOwnership = caught.agentTestStartupOwnership;
        await recordStartupFailure(error);
        throw error;
    }
}

main().catch(async (error) => {
    const index = process.argv.indexOf('--config');
    if (!error?.agentTestStartupRecorded && index >= 0 && process.argv[index + 1]) {
        try {
            const config = await readPrivateJson(process.argv[index + 1]);
            await writePrivateJson(config.startupErrorFile, { error: redact(String(error?.message || error)), at: new Date().toISOString() });
        } catch {}
    }
    process.stderr.write(`agent-test broker failed: ${error?.stack || error}\n`);
    process.exitCode = 1;
});
