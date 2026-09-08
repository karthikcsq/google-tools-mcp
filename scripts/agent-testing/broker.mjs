import http from 'node:http';
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
    if (config.startupDeadlineAt && Date.now() > config.startupDeadlineAt) throw new Error('agent-test startup deadline elapsed before the broker initialized.');
    config.codeIdentity = await codeIdentity();
    const { factory, backendState, recorder } = await createInstrumentedFactory(config);
    if (config.startupDeadlineAt && Date.now() > config.startupDeadlineAt) {
        await cleanupResources({ backendState, recorder });
        throw new Error('agent-test startup deadline elapsed before the broker became ready. Owned resources were cleaned.');
    }
    config.folderId = backendState.folderId;
    config.limitations = backendState.backend.limitations || [];
    const expectedCalls = new Map();
    let mcpRuntime = null;
    let stdioClient = null;
    let nativeServer = null;
    let nativeUrl = null;
    if (config.transport === 'http') {
        const { startV2HttpServer } = await import('../../dist/mcpServer.js');
        mcpRuntime = await startV2HttpServer(factory, {
            host: '127.0.0.1', port: 0, auth: { token: config.nativeToken }, profile: 'agent-test',
        });
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
    } else {
        stdioClient = await createInProcessStdioClient(factory, config.callTimeoutMs);
        // Establish the actual MCP connection before the session becomes visible.
        await stdioClient.discover();
    }

    let closed = false;
    let control = null;
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
    const manifest = {
        version: 1, runId: config.runId, backend: config.backend, transport: config.transport, goal: config.goal,
        manifestPath: config.manifestFile, reportPath: config.reportFile, journalPath: config.journalFile,
        controlUrl: `http://127.0.0.1:${controlPort}/control`, controlToken: config.controlToken,
        folderId: backendState.folderId, workspaceDir: config.workspaceDir, limitations: backendState.backend.limitations,
        ...(nativeUrl ? { nativeMcp: { url: nativeUrl, token: config.nativeToken } } : {}),
        state: 'ready', startedAt: new Date().toISOString(), codeIdentity: config.codeIdentity,
    };
    await writePrivateJson(config.manifestFile, manifest);
    await appendJsonl(config.journalFile, { kind: 'session-ready', manifest: publicManifest(manifest), backend: backendState.backend });
    touch();
    const shutdown = async (signal) => {
        if (!recorder.state.closed) await finish('blocked', `Broker received ${signal}.`);
        control.close();
        process.exit(0);
    };
    process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.once('SIGINT', () => { void shutdown('SIGINT'); });
}

main().catch(async (error) => {
    const index = process.argv.indexOf('--config');
    if (index >= 0 && process.argv[index + 1]) {
        try {
            const config = await readPrivateJson(process.argv[index + 1]);
            await writePrivateJson(config.startupErrorFile, { error: redact(String(error?.message || error)), at: new Date().toISOString() });
        } catch {}
    }
    process.stderr.write(`agent-test broker failed: ${error?.stack || error}\n`);
    process.exitCode = 1;
});
