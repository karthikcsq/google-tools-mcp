// Process-scoped wiring that turns the (previously unwired) readHandles store
// into the real read/mutate capability used by the SDK v2 runtime.
//
// Three concerns live here, deliberately together, because they share one
// lifetime (the process) and one invalidation epoch:
//
//   1. The single `createReadHandleStore()` instance plus its binding/epoch
//      bookkeeping (see `syncRuntimeBinding`).
//   2. The filesystem side of plan §3 "workspace ownership": a content-addressed
//      immutable baseline per (profile, fileId, tabId, revisionId, structural
//      fingerprint, content) and a unique editable copy per handle, with an
//      ownership manifest recording exact paths for cleanup.
//   3. A request-scoped annotation slot so a tool can surface `readHandle` as a
//      top-level field of its result without every tool changing its return
//      type. `dist/mcpServer.js` is the only consumer.
//
// Everything here is inert without a transport in play: with no ambient
// request context (`dist/requestContext.js`), `isHandleRuntimeActive()` is false
// and no store, directory, or annotation is ever created.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createReadHandleStore } from './readHandles.js';
import { getRequestContext } from './requestContext.js';
import { NODE_KINDS, walkDocument } from './docsStructure.js';
import { ensureSafeDirectory, getWorkspaceDir, writeFileSecurely } from './workspace.js';
import { logger as defaultLogger } from './logger.js';

const V2_SUBDIR = 'v2-handles';
const BASELINES_SUBDIR = 'baselines';
const HANDLES_SUBDIR = 'handles';
const MANIFEST_FILE = 'manifest.json';
const EDITABLE_FILE = 'content.md';

const resultAnnotationStorage = new AsyncLocalStorage();

let store = null;
let configuredBinding = null;
// workspaceId -> ownership manifest record. This is the only source cleanup
// consults; it never globs a directory (plan §3).
const ownedWorkspaces = new Map();
// baselineId -> Set<workspaceId> currently initialized from that baseline.
const baselineReferences = new Map();
// workspaceId -> the text/structure projection the read captured (issue #108).
//
// In memory rather than on disk, deliberately: it is derived data whose only
// consumer is the conflict classifier inside the same process, its lifetime is
// exactly the handle's, and writing document text to a second file would widen
// the on-disk footprint of a read for no recovery value. It is reaped with the
// workspace it belongs to, on exactly the same paths.
const workspaceProjections = new Map();

function v2Root() {
    return path.join(getWorkspaceDir(), V2_SUBDIR);
}

/** True when a tool is executing under the SDK v2 runtime's request context. */
export function isHandleRuntimeActive() {
    return Boolean(getRequestContext());
}

/** Lazily create the one process-local handle store. */
export function getReadHandleStore() {
    if (!store) {
        store = createReadHandleStore();
        configuredBinding = null;
    }
    return store;
}

/**
 * Reconcile the store's configured binding with the binding this request
 * actually carries.
 *
 * There is no runtime token-rotation or profile-reload path in this release:
 * `dist/index.js` reads `GOOGLE_MCP_HTTP_TOKEN`/`GOOGLE_MCP_PROFILE` once at
 * start and `dist/clients.js` never swaps the configured profile afterwards, so
 * rotation means restarting the process (each start mints a fresh epoch — see
 * `nextRuntimeEpoch` in dist/mcpServer.js). This function is still the wiring
 * the plan asks for: if the effective principal fingerprint, profile, or epoch
 * ever does change under a live store, every outstanding handle bound to the old
 * triple is invalidated *before* the new request can validate one.
 *
 * Only requests that already passed bearer/Origin authentication reach here, so
 * an unauthenticated caller cannot use this as an invalidation lever.
 */
export function syncRuntimeBinding(context) {
    const active = getReadHandleStore();
    const next = {
        principalFingerprint: context.principalFingerprint,
        profile: context.profile,
        epoch: context.epoch,
    };
    if (configuredBinding &&
        configuredBinding.principalFingerprint === next.principalFingerprint &&
        configuredBinding.profile === next.profile &&
        Object.is(configuredBinding.epoch, next.epoch)) {
        return 0;
    }
    const invalidated = configuredBinding ? active.invalidateForBindingChange(next) : 0;
    configuredBinding = next;
    return invalidated;
}

// --- structural fingerprint -------------------------------------------------

/**
 * Stable structural fingerprint of a Docs document (or a `{ body }` fragment),
 * computed with the internal walker from dist/docsStructure.js.
 *
 * The digest covers, in document order, every walked node's kind, start/end
 * index, nesting depth, table row/column position, non-textRun element type, and
 * — for text runs only — the *length* of its text. Text content itself is
 * deliberately excluded: the fingerprint answers "is this the same structure I
 * read?", and hashing the prose would make it a second (weaker) content hash
 * while pulling document text into a value that gets stored and compared.
 * Length is included so an edit that preserves the element tree but changes how
 * much text a run holds still moves the fingerprint.
 *
 * `document` (and therefore how `tabId` gets used) takes one of two shapes,
 * matching dist/tools/docs/readGoogleDoc.js's `contentSource`:
 *   - A full tabbed `Document` (`document.tabs` is a non-empty array): walked
 *     WITH the `tabId` filter, so only that tab's nodes are hashed (or every
 *     tab's, when `tabId` is null).
 *   - A body-only fragment — a single `DocumentTab`'s own `{ body, lists }`,
 *     with no `tabs` array at all (this is exactly what a tab-scoped read
 *     fetches; see readGoogleDoc.js's `contentSource = { body: targetTab
 *     .documentTab.body, lists: ... }`). This fragment IS already the tab's
 *     content, so it must be walked WITHOUT a `tabId` filter: `walkDocument`
 *     treats "tabId filter set + no `tabs` array" as "this can never match"
 *     and returns zero nodes (a body-only document has no tab to match
 *     against), which would otherwise make every tab-scoped fingerprint the
 *     same degenerate `sha256-0-...` constant no matter the fragment's actual
 *     structure.
 */
export function computeStructuralFingerprint(document, { tabId = null } = {}) {
    const hash = createHash('sha256');
    let nodes = 0;
    const isTabbedDocument = Array.isArray(document?.tabs) && document.tabs.length > 0;
    const walkOptions = {
        tabId: isTabbedDocument ? (tabId ?? undefined) : undefined,
        includeTabNodes: true,
    };
    for (const entry of walkDocument(document, walkOptions)) {
        nodes += 1;
        const textLength = entry.kind === NODE_KINDS.TEXT_RUN && typeof entry.node?.content === 'string'
            ? entry.node.content.length
            : -1;
        hash.update(`${entry.kind}|${entry.startIndex ?? ''}|${entry.endIndex ?? ''}|${entry.depth}` +
            `|${entry.rowIndex ?? ''}|${entry.columnIndex ?? ''}|${entry.elementType ?? ''}|${textLength}\n`);
    }
    return `sha256-${nodes}-${hash.digest('hex')}`;
}

// --- workspace filesystem layer --------------------------------------------

function sha256Hex(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Content-addressed baseline identity.
 *
 * Plan §3 keys the immutable baseline on
 * `(profile, fileId, tabId, revisionId, fingerprint)`. The content hash is
 * appended because a single (document, revision) can legitimately produce
 * different baseline bytes depending on the read format (markdown / text /
 * json), and a baseline file that is shared must be addressed by what is
 * actually in it. Two reads that agree on the whole tuple *and* the bytes share
 * one file; anything else gets its own.
 */
function baselineIdFor({ profile, fileId, tabId, revisionId, fingerprint, content }) {
    return sha256Hex([
        profile ?? '',
        fileId ?? '',
        tabId ?? '',
        revisionId ?? '',
        fingerprint ?? '',
        sha256Hex(content),
    ].join('\x00'));
}

function baselinePathFor(baselineId) {
    return path.join(v2Root(), BASELINES_SUBDIR, `${baselineId}.baseline`);
}

function workspaceDirFor(workspaceId) {
    return path.join(v2Root(), HANDLES_SUBDIR, workspaceId);
}

function newInternalId() {
    // base64url uses only [A-Za-z0-9_-], which is exactly the character class
    // readHandles.js accepts for workspaceId / ownershipManifest.
    return randomBytes(16).toString('base64url');
}

function addBaselineReference(baselineId, workspaceId) {
    let refs = baselineReferences.get(baselineId);
    if (!refs) {
        refs = new Set();
        baselineReferences.set(baselineId, refs);
    }
    refs.add(workspaceId);
}

async function releaseBaselineReference(baselineId, workspaceId) {
    const refs = baselineReferences.get(baselineId);
    if (!refs) return;
    refs.delete(workspaceId);
    if (refs.size > 0) return;
    baselineReferences.delete(baselineId);
    // Reclaim a clean, unreferenced baseline by its exact path.
    await fs.rm(baselinePathFor(baselineId), { force: true }).catch(() => {});
}

/**
 * Create a unique editable workspace for one handle, initialized from a shared
 * immutable baseline. Returns the `workspace` object readHandles.js stores plus
 * the absolute editable path.
 */
export async function createHandleWorkspace({
    profile, fileId, tabId = null, revisionId = null, fingerprint = null, content, expiresAt = null,
}) {
    const baselineId = baselineIdFor({ profile, fileId, tabId, revisionId, fingerprint, content });
    const baselinePath = baselinePathFor(baselineId);
    await ensureSafeDirectory(path.dirname(baselinePath));
    // The baseline is immutable: write it only the first time this identity is
    // seen. A second read of identical content reuses the same file.
    let baselineShared = true;
    try {
        await fs.access(baselinePath);
    } catch {
        baselineShared = false;
    }

    const workspaceId = newInternalId();
    const ownershipManifest = newInternalId();
    const dir = workspaceDirFor(workspaceId);
    const editablePath = path.join(dir, EDITABLE_FILE);
    const manifestPath = path.join(dir, MANIFEST_FILE);
    let baselineCreatedHere = false;

    // Every write below is fallible (disk full, permissions, temp I/O), and
    // `ownedWorkspaces.set` — the ONLY thing cleanup ever consults (plan §3,
    // "never a glob") — is deliberately the very last step. If anything in
    // between throws, this call has already put bytes on disk that no owner
    // will ever be told to reap, so the catch below removes exactly what this
    // call created (and only what this call created: a shared pre-existing
    // baseline is never touched) before propagating the original error.
    try {
        if (!baselineShared) {
            await writeFileSecurely(baselinePath, content);
            baselineCreatedHere = true;
        }
        // Copy, never link or share: handle A's edits must never appear in B's file.
        await ensureSafeDirectory(dir);
        await writeFileSecurely(editablePath, content);

        const manifest = {
            workspaceId,
            ownershipManifest,
            editablePath,
            manifestPath,
            directory: dir,
            baselineId,
            baselinePath,
            baselineHash: sha256Hex(content),
            createdAt: Date.now(),
            expiresAt,
        };
        await writeFileSecurely(manifestPath, JSON.stringify(manifest, null, 2));
        ownedWorkspaces.set(workspaceId, manifest);
        addBaselineReference(baselineId, workspaceId);
    } catch (error) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        if (baselineCreatedHere) {
            await fs.rm(baselinePath, { force: true }).catch(() => {});
        }
        throw error;
    }

    return {
        baselineShared,
        editablePath,
        workspace: {
            workspaceId,
            ownershipManifest,
            editablePath,
            baselineId,
            dirty: false,
        },
    };
}

/**
 * Attach the projection a read captured to the workspace that read minted, so
 * the conflict classifier can compare it against the document later (#108).
 */
export function setWorkspaceProjection(workspaceId, projection) {
    if (!workspaceId || !projection) return false;
    workspaceProjections.set(workspaceId, projection);
    return true;
}

/** The projection captured for a workspace, or null when none was stored. */
export function getWorkspaceProjection(workspaceId) {
    if (!workspaceId) return null;
    return workspaceProjections.get(workspaceId) ?? null;
}

/** Record the handle expiry the store assigned, so FS-side expiry can act on it. */
export function noteWorkspaceExpiry(workspaceId, expiresAt) {
    const manifest = ownedWorkspaces.get(workspaceId);
    if (manifest) manifest.expiresAt = expiresAt;
}

/**
 * Filesystem-side dirty check: a workspace is dirty when its editable file no
 * longer matches the baseline it was initialized from. A missing file is treated
 * as clean (nothing to preserve).
 */
export async function isWorkspaceDirtyOnDisk(workspaceId) {
    const manifest = ownedWorkspaces.get(workspaceId);
    if (!manifest) return false;
    try {
        const current = await fs.readFile(manifest.editablePath, 'utf-8');
        return sha256Hex(current) !== manifest.baselineHash;
    } catch {
        return false;
    }
}

async function removeWorkspaceFiles(manifest) {
    // Exact paths from the manifest only — never a glob (plan §3).
    await fs.rm(manifest.editablePath, { force: true }).catch(() => {});
    await fs.rm(manifest.manifestPath, { force: true }).catch(() => {});
    await fs.rmdir(manifest.directory).catch(() => {});
    ownedWorkspaces.delete(manifest.workspaceId);
    workspaceProjections.delete(manifest.workspaceId);
    await releaseBaselineReference(manifest.baselineId, manifest.workspaceId);
}

/** Drop a workspace whose handle was consumed by a successful write. */
export async function discardHandleWorkspace(workspaceId) {
    const manifest = ownedWorkspaces.get(workspaceId);
    if (!manifest) return false;
    await removeWorkspaceFiles(manifest);
    return true;
}

/**
 * Reclaim expired handle workspaces on disk.
 *
 * A dirty editable file is never deleted: it is left in place and reported so an
 * operator can recover it (plan §3). Baselines are removed only once their last
 * referencing workspace is gone. There is intentionally no background timer —
 * this runs on mint and on shutdown, so the runtime holds no interval that would
 * keep the process (or a Jest worker) alive.
 *
 * @param {object} [options]
 * @param {boolean} [options.all=false] Treat every owned workspace as expired.
 */
export async function cleanupHandleWorkspaces({ all = false, now = Date.now() } = {}) {
    const removed = [];
    const retained = [];
    for (const manifest of Array.from(ownedWorkspaces.values())) {
        const expired = all || (manifest.expiresAt !== null && now >= manifest.expiresAt);
        if (!expired) continue;
        if (await isWorkspaceDirtyOnDisk(manifest.workspaceId)) {
            retained.push({ workspaceId: manifest.workspaceId, editablePath: manifest.editablePath });
            continue;
        }
        await removeWorkspaceFiles(manifest);
        removed.push(manifest.workspaceId);
    }
    return { removed, retained };
}

// --- request-scoped result annotations --------------------------------------

/**
 * Run a tool execution inside a fresh annotation slot.
 *
 * AsyncLocalStorage rather than a WeakMap keyed by request context: an HTTP
 * context is per-request, but a stdio context is per-*connection* and shared by
 * every concurrent call on it, so a context-keyed bag could hand one call's
 * handle to another. This slot is per execution.
 */
export function runWithResultAnnotations(fn) {
    return resultAnnotationStorage.run({ readHandle: null, expiresAt: null, warnings: [] }, fn);
}

/** Ask the facade to surface `readHandle` as a top-level result field. */
export function setResultHandle(readHandle, expiresAt = null) {
    const slot = resultAnnotationStorage.getStore();
    if (!slot) return false;
    slot.readHandle = readHandle;
    slot.expiresAt = expiresAt;
    return true;
}

/**
 * Attach an operator-facing warning to the in-flight tool result, without the
 * tool itself needing to thread it through its own return value.
 *
 * The seam this exists for: a Docs write that has already committed to Google
 * but whose successor read-handle workspace could not be created (see
 * `docsHandles.js` `complete()`). That failure must not read as "the write
 * failed" — it already succeeded — so it is surfaced here instead of thrown,
 * and merged into the result the same way `setResultHandle` merges a minted
 * handle: every tool gets it for free via `applyResultAnnotations` below, with
 * zero changes to individual tool files.
 */
export function setResultWarning(message) {
    const slot = resultAnnotationStorage.getStore();
    if (!slot || typeof message !== 'string' || message.length === 0) return false;
    slot.warnings.push(message);
    return true;
}

/**
 * Merge any annotation into a normalized tool result. `readHandle` is a named
 * top-level field (plan §2) and is mirrored into `structuredContent` for clients
 * that only read structured output. `warnings` (if any were recorded) are both
 * appended as an additional text block, so a plain-text-only client still sees
 * them, and mirrored into `structuredContent.warnings`.
 */
export function applyResultAnnotations(result) {
    const slot = resultAnnotationStorage.getStore();
    const warnings = slot?.warnings ?? [];
    if (!slot?.readHandle && warnings.length === 0) return result;
    const content = warnings.length > 0
        ? [
            ...(Array.isArray(result.content) ? result.content : []),
            ...warnings.map((message) => ({ type: 'text', text: `Warning: ${message}` })),
        ]
        : result.content;
    return {
        ...result,
        ...(content !== result.content ? { content } : {}),
        ...(slot?.readHandle ? { readHandle: slot.readHandle } : {}),
        structuredContent: {
            ...(result.structuredContent ?? {}),
            ...(slot?.readHandle ? { readHandle: slot.readHandle } : {}),
            ...(slot?.readHandle && slot.expiresAt !== null ? { readHandleExpiresAt: slot.expiresAt } : {}),
            ...(warnings.length > 0 ? { warnings } : {}),
        },
    };
}

// --- lifecycle --------------------------------------------------------------

/**
 * Shut the runtime down: clean workspaces are removed, dirty ones are retained
 * and reported, and the store is dropped so the next start gets a fresh one.
 * Wired into both facade close paths in dist/mcpServer.js.
 */
export async function shutdownReadHandleRuntime({ logger = defaultLogger } = {}) {
    const retainedByStore = store ? store.shutdown().retainedDirty : [];
    const { removed, retained } = await cleanupHandleWorkspaces({ all: true });
    if (retained.length > 0) {
        logger?.warn?.(
            `Retained ${retained.length} dirty MCP workspace file(s) for recovery: ` +
            retained.map((entry) => entry.editablePath).join(', '),
        );
    }
    store = null;
    configuredBinding = null;
    return { removed, retained, retainedByStore };
}

/** Test seam: drop every process-scoped structure without touching disk. */
export function resetHandleRuntimeState() {
    store = null;
    configuredBinding = null;
    ownedWorkspaces.clear();
    baselineReferences.clear();
    workspaceProjections.clear();
}

/** Diagnostics for tests and status output. */
export function getHandleRuntimeStats() {
    return {
        workspaces: ownedWorkspaces.size,
        baselines: baselineReferences.size,
        store: store ? store.getStats() : null,
    };
}
