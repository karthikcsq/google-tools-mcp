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
export function getWorkspaceDir() {
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

// Create the base dir with private perms and verify it is a real directory we
// own — not a symlink an attacker planted to redirect our writes. Throws if the
// directory exists but is unsafe.
async function ensureSafeBaseDir() {
    const dir = getWorkspaceDir();
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

// Write content to the workspace file for documentId/tabId without following a
// symlink at the final path component and with 0600 perms. Returns the absolute
// path written. Throws on any failure (callers decide whether that is fatal).
export async function writeWorkspaceFile(documentId, content, tabId = null) {
    await ensureSafeBaseDir();
    const filePath = getWorkspacePath(documentId, tabId);
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
