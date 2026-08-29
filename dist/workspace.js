// Secure local workspace for the Google Docs local-file editing workflow.
//
// readDocument saves a markdown working copy here and replaceDocumentWithMarkdown
// mirrors inline pushes into it. Because these files hold document contents, the
// storage has to be hardened against the classic shared-/tmp attacks:
//
//   * Per-user base directory (`google-tools-mcp-<user>`), created 0700, so a
//     different local user cannot read another user's working copies and cannot
//     win a collision by pre-creating the directory.
//   * The base dir is lstat-checked every write: if it exists but is a symlink
//     (or anything other than a directory we own) we refuse to write, defeating
//     a planted-symlink redirect on the directory itself.
//   * Files are opened with O_NOFOLLOW (where supported) plus O_CREAT|O_TRUNC and
//     mode 0600, so an attacker who pre-creates the target path as a symlink
//     causes the write to fail rather than clobber the victim's file.
//   * Filenames are scoped by documentId AND tabId, so reading two tabs of one
//     document keeps two separate working copies instead of silently overwriting.
import * as fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import * as os from 'os';
import * as path from 'path';

// Restrict an id to characters that are always safe in a filename. documentId
// and tabId are Google-issued opaque ids, but sanitizing is cheap defense in
// depth against path traversal if a caller ever passes something unexpected.
function sanitizeComponent(value) {
    return String(value).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

// Per-user private base directory under the OS temp dir. Including the username
// scopes working copies per user; on POSIX the directory is additionally locked
// to 0700 and ownership-verified in ensureSafeBaseDir().
//
// GOOGLE_MCP_WORKSPACE_DIR overrides the computed path entirely when set.
// This exists so tests (and any caller that wants an isolated workspace) can
// point at a throwaway sandbox instead of the real per-user production
// directory, without needing a second code path in production. Unset (the
// normal production case), behavior is unchanged.
export function getWorkspaceDir() {
    if (process.env.GOOGLE_MCP_WORKSPACE_DIR) {
        return process.env.GOOGLE_MCP_WORKSPACE_DIR;
    }
    let userPart;
    try {
        userPart = sanitizeComponent(os.userInfo().username);
    }
    catch {
        // userInfo can throw if there is no passwd entry (some sandboxes); fall
        // back to the numeric uid, or a constant on platforms without getuid.
        const uid = typeof process.getuid === 'function' ? process.getuid() : 'nouid';
        userPart = `uid${uid}`;
    }
    if (!userPart) {
        userPart = 'default';
    }
    return path.join(os.tmpdir(), `google-tools-mcp-${userPart}`);
}

// Absolute path of the working copy for a document (and optional tab). tabId is
// part of the identity so distinct tabs never share a file.
export function getWorkspacePath(documentId, tabId = null) {
    const base = sanitizeComponent(documentId);
    const name = tabId ? `${base}.${sanitizeComponent(tabId)}.md` : `${base}.md`;
    return path.join(getWorkspaceDir(), name);
}

// Create `dir` (recursively) with private perms and verify it is a real
// directory we own — not a symlink an attacker planted to redirect our writes.
// Throws if the directory exists but is unsafe. Exported so the per-handle v2
// workspace layer (dist/handleRuntime.js) reuses exactly these hardening rules
// for its own subdirectories instead of re-deriving them.
export async function ensureSafeDirectory(dir) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir(recursive) does not reset mode/ownership on a pre-existing entry, so
    // inspect it directly. lstat (not stat) so a symlinked directory is reported
    // as a symlink rather than followed.
    const st = await fs.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`Refusing to use workspace directory "${dir}": not a regular directory (possible symlink attack).`);
    }
    if (process.platform !== 'win32') {
        if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
            throw new Error(`Refusing to use workspace directory "${dir}": owned by another user.`);
        }
        // Re-assert 0700 in case the directory pre-existed with looser perms.
        try {
            await fs.chmod(dir, 0o700);
        }
        catch {
            // Non-fatal: best effort tightening.
        }
    }
    return dir;
}

// The shared base dir every workspace file (legacy shared copies and v2
// per-handle copies alike) lives under.
async function ensureSafeBaseDir() {
    return ensureSafeDirectory(getWorkspaceDir());
}

/**
 * Write `content` to an absolute path without following a symlink at the final
 * component and with 0600 perms. The caller owns creating/validating the parent
 * directory (see ensureSafeDirectory). Exported for the v2 per-handle workspace
 * layer; `writeWorkspaceFile` below is the legacy shared-copy wrapper.
 */
export async function writeFileSecurely(filePath, content) {
    // O_NOFOLLOW is a no-op / undefined on some platforms (notably Windows);
    // fall back to 0 there. O_CREAT|O_TRUNC gives create-or-overwrite semantics.
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow;
    const handle = await fs.open(filePath, flags, 0o600);
    try {
        await handle.writeFile(content, 'utf-8');
    }
    finally {
        await handle.close();
    }
    if (process.platform !== 'win32') {
        // Tighten perms even if the file pre-existed with a looser mode.
        try {
            await fs.chmod(filePath, 0o600);
        }
        catch {
            // Non-fatal.
        }
    }
    return filePath;
}

// absolute mirror path -> ms epoch of the last time THIS process wrote it via
// writeWorkspaceFile. In-memory and per-process, like every other read/write
// tracking state in this codebase (dist/readTracker.js, dist/handleRuntime.js):
// it cannot protect a file across a process restart, so backupIfLocallyModified
// treats "no record" the same as "modified" — see there for why that is the
// safe default rather than a gap.
const mirrorWriteTimes = new Map();

// Filesystem mtime resolution/clock jitter between "we finished writing" and
// "we read Date.now() to record it" is usually sub-millisecond but is not
// guaranteed to be zero on every OS/filesystem combination; a small tolerance
// avoids a false "locally modified" verdict on the write that just happened.
const MTIME_CLOCK_TOLERANCE_MS = 500;

// Write content to the shared workspace file for documentId/tabId. Returns the
// absolute path written. Throws on any failure (callers decide whether that is
// fatal). This is the legacy (session-era) shared copy; the SDK v2 runtime uses
// a per-handle editable copy instead — see dist/handleRuntime.js.
export async function writeWorkspaceFile(documentId, content, tabId = null) {
    await ensureSafeBaseDir();
    const filePath = getWorkspacePath(documentId, tabId);
    const written = await writeFileSecurely(filePath, content);
    // Recorded AFTER the write actually lands, so backupIfLocallyModified can
    // tell "the file on disk is exactly what THIS write just put there" apart
    // from "something else touched it since" (issue #122). Any writer of this
    // file counts as legitimate here — readDocument seeding/refreshing the
    // mirror, and replaceDocumentWithMarkdown echoing a push back into it —
    // both are the tool's own hand, not a conflict to protect against.
    mirrorWriteTimes.set(written, Date.now());
    return written;
}

/**
 * Before overwriting the local mirror at `filePath`, check whether something
 * OTHER than this process's own last write has touched it since — i.e. a
 * human editing the working copy readDocument told them to edit — and if so,
 * copy the current on-disk content to `${filePath}.bak` first so the next
 * write does not silently destroy it (issue #122: a later readDocument call
 * used to overwrite an in-progress local edit with no warning and no backup).
 *
 * "No record of ever writing this exact path" (first read of this
 * document+tab in this process, or the process restarted since) is treated
 * the SAME as "modified more recently than we wrote it": there is no way to
 * prove the file is safe to clobber, so this errs toward one extra,
 * essentially free backup file over the alternative of silently repeating
 * the bug being fixed. A backup is best-effort — a failure here must never
 * block the read that triggered it; the caller decides what to do with a
 * failed attempt.
 *
 * @param {string} filePath absolute path of the mirror file about to be overwritten.
 * @returns {Promise<{backedUp: boolean, backupPath?: string, backupError?: string}>}
 */
export async function backupIfLocallyModified(filePath) {
    let stat;
    try {
        stat = await fs.stat(filePath);
    }
    catch {
        return { backedUp: false }; // nothing on disk yet — nothing to protect
    }
    const recordedWriteMs = mirrorWriteTimes.get(filePath);
    const locallyModified = recordedWriteMs === undefined
        || stat.mtimeMs > recordedWriteMs + MTIME_CLOCK_TOLERANCE_MS;
    if (!locallyModified) {
        return { backedUp: false };
    }
    const backupPath = `${filePath}.bak`;
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        await writeFileSecurely(backupPath, content);
        return { backedUp: true, backupPath };
    }
    catch (error) {
        return { backedUp: false, backupError: error.message };
    }
}
