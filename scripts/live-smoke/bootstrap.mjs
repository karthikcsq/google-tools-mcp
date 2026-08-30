// Shared startup for both live-smoke entry points (the scenario runner and the
// one-shot `live-call`).
//
// The point of this harness is that an agent working in ANY worktree can drive
// that worktree's own dist/ against the real Google APIs without restarting its
// MCP client. So everything here resolves relative to THIS FILE, never to a
// globally installed copy, and the resolved path is printed at startup so it is
// obvious which build is being exercised.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { createGuard, SafetyViolation } from './guard.mjs';
import { createJournal } from './journal.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const DIST_DIR = path.join(REPO_ROOT, 'dist');
export const RESULTS_DIR = path.join(REPO_ROOT, 'live-smoke-results');

export const ENV_VAR = 'GOOGLE_MCP_TEST_FOLDER_ID';

class StartupRefusal extends Error {
    constructor(message) {
        super(message);
        this.name = 'StartupRefusal';
        this.refusal = true;
    }
}

/**
 * Boundary 1: refuse to start without an explicit test folder. There is
 * deliberately no default and no fallback -- an unset variable must never
 * degrade into "write somewhere in My Drive".
 */
export function requireTestFolderId(env = process.env) {
    const raw = env[ENV_VAR];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
        throw new StartupRefusal(
            `Refusing to start: ${ENV_VAR} is not set.\n\n` +
            'Live smoke runs against a real Google account, so it will only write inside one\n' +
            'explicitly named Drive folder. Copy .env.live-smoke.example to .env.live-smoke and\n' +
            `export ${ENV_VAR}, or pass it inline:\n\n` +
            `  ${ENV_VAR}=<folder-id> npm run live-smoke\n`
        );
    }
    if (!/^[A-Za-z0-9_-]{10,}$/.test(value)) {
        throw new StartupRefusal(`Refusing to start: ${ENV_VAR}="${value}" is not a plausible Drive folder id.`);
    }
    return value;
}

/** Load .env.live-smoke (never committed) if present, without clobbering real env. */
export function loadDotEnv(file = path.join(REPO_ROOT, '.env.live-smoke')) {
    if (!fs.existsSync(file)) return {};
    const loaded = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        loaded[key] = value;
        if (process.env[key] === undefined) process.env[key] = value;
    }
    return loaded;
}

/** A run id that is unique per run, so two concurrent runs never collide on a name. */
export function makeRunId(now = new Date()) {
    const stamp = now.toISOString().replace(/[:.]/g, '-').replace('Z', '');
    return `${stamp}-${randomBytes(2).toString('hex')}`;
}

export async function loadTools() {
    const { registerAllTools } = await import('../../dist/tools/index.js');
    const tools = new Map();
    await registerAllTools({
        addTool(def) {
            if (tools.has(def.name)) throw new Error(`Duplicate tool registered: ${def.name}`);
            tools.set(def.name, def);
        },
    });
    return tools;
}

/**
 * Bring up everything a live-smoke entry point needs, in the order that fails
 * cheapest first: env, then dist, then auth, then folder verification.
 */
export async function bootstrap({ label }) {
    loadDotEnv();
    const folderId = requireTestFolderId();

    if (!fs.existsSync(path.join(DIST_DIR, 'tools', 'index.js'))) {
        throw new StartupRefusal(
            `Refusing to start: no build found at ${DIST_DIR}. This harness only ever runs the dist/ of ` +
            'the worktree it lives in.'
        );
    }

    const runId = makeRunId();

    // Keep the local markdown mirror out of the real per-user working-copy
    // directory. readDocument writes a mirror for every markdown read; pointing
    // it at a run-scoped sandbox means a smoke run can never overwrite a working
    // copy a human (or another agent) has pending edits in. Boundary 4 covers
    // local files too, not just Drive.
    const workspaceDir = path.join(RESULTS_DIR, 'workspace', runId);
    fs.mkdirSync(workspaceDir, { recursive: true });
    process.env.GOOGLE_MCP_WORKSPACE_DIR = workspaceDir;

    const journal = createJournal({ dir: RESULTS_DIR, timestamp: runId });
    journal.write({ kind: 'run-start', label, runId, repoRoot: REPO_ROOT, distDir: DIST_DIR, folderId, workspaceDir, node: process.version });

    journal.progress(`live-smoke ${label}`);
    journal.progress(`  build      ${DIST_DIR}`);
    journal.progress(`  folder     ${folderId}`);
    journal.progress(`  run id     ${runId}`);
    journal.progress(`  journal    ${journal.file}`);
    journal.progress(`  workspace  ${workspaceDir}`);

    const tools = await loadTools();
    const guard = createGuard({ folderId });
    await guard.ensureInstrumented();

    // Verify the sandbox before anything writes to it: it must exist, be a
    // folder, not be trashed, and be writable by us.
    const originals = await guard.rawDrive();
    const filesGet = originals?.['files.get'];
    if (!filesGet) throw new StartupRefusal('Internal error: Drive client was not instrumented.');
    let folder;
    try {
        const res = await filesGet({ fileId: folderId, fields: 'id,name,mimeType,trashed,capabilities(canAddChildren)', supportsAllDrives: true });
        folder = res.data;
    } catch (error) {
        throw new StartupRefusal(`Refusing to start: test folder ${folderId} could not be read (${error?.message || error}).`);
    }
    if (folder.mimeType !== 'application/vnd.google-apps.folder') {
        throw new StartupRefusal(`Refusing to start: ${folderId} is not a folder (mimeType ${folder.mimeType}).`);
    }
    if (folder.trashed) {
        throw new StartupRefusal(`Refusing to start: test folder ${folderId} is in the trash.`);
    }
    if (folder.capabilities && folder.capabilities.canAddChildren === false) {
        throw new StartupRefusal(`Refusing to start: no permission to create files in test folder ${folderId}.`);
    }
    journal.progress(`  sandbox    "${folder.name}"`);
    journal.write({ kind: 'folder-verified', folderId, name: folder.name });

    let self = null;
    try {
        const profile = tools.get('getProfile');
        if (profile) {
            const raw = await profile.execute({}, { log: { debug() {}, info() {}, warn() {}, error() {} } });
            self = JSON.parse(raw).emailAddress ?? null;
        }
    } catch {
        // Not fatal: only the Gmail scenarios need it, and they check.
    }
    if (self) journal.progress(`  account    ${self}`);

    return { folderId, folderName: folder.name, runId, tools, guard, journal, self, workspaceDir };
}

export { StartupRefusal, SafetyViolation };
