import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME_TYPE = 'application/vnd.google-apps.shortcut';
const PARENT_CHUNK_SIZE = 50;
const RECURSIVE_PAGE_SIZE = 100;
const API_CALL_BUDGET = 50;

function escapeDriveQueryValue(value) {
    return value.replace(/'/g, "\\'");
}

function getStatus(error) {
    return Number.isInteger(error?.code) ? error.code : undefined;
}

// Drive's structured error payload carries a `reason` per sub-error that is
// far more specific than the bare HTTP status. googleapis clients attach it
// either directly on the thrown error (`error.errors`) or nested under the
// gaxios response shape (`error.response.data.error.errors`) depending on
// version/transport, so both are checked.
function getErrorReason(error) {
    const reason = error?.errors?.[0]?.reason ?? error?.response?.data?.error?.errors?.[0]?.reason;
    return typeof reason === 'string' ? reason : undefined;
}

// A 403 with one of these reasons is Drive asking the caller to back off, not
// telling it a folder is inaccessible — Google documents these as quota/rate
// conditions to retry with backoff, not permission failures to isolate:
// https://developers.google.com/workspace/drive/api/guides/limits
const RATE_LIMIT_REASONS = new Set([
    'rateLimitExceeded',
    'userRateLimitExceeded',
    'quotaExceeded',
    'dailyLimitExceeded',
    'sharingRateLimitExceeded',
]);

function isRateLimitStatus(error) {
    return getStatus(error) === 403 && RATE_LIMIT_REASONS.has(getErrorReason(error));
}

export function register(server) {
    server.addTool({
        name: 'listFolderContents',
        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns a single {folders, files, truncated, truncationReason?} page capped by maxResults; truncated reports when Drive has more pages. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the single depth-1 page. Use getFilePath for the inverse, upward path lookup.",
        parameters: z.object({
            folderId: z.string().describe('ID of the folder to list contents of. Use "root" for the root Drive folder.'),
            includeSubfolders: z.boolean().optional().default(true).describe('Whether to include subfolders in results.'),
            includeFiles: z.boolean().optional().default(true).describe('Whether to include files in results.'),
            maxResults: z.number().int().min(1).max(100).optional().default(50).describe('Maximum number of items to return at depth 1. Ignored for recursive traversal.'),
            depth: z.union([z.number().int().min(1).max(10), z.literal('all')]).optional().default(1).describe("How many levels to list: 1 (default) through 10, or 'all'."),
            maxItems: z.number().int().min(1).max(5000).optional().describe('Hard cap across a recursive traversal. Defaults to 500; only valid when depth is greater than 1.'),
        }).superRefine((args, context) => {
            if (!args.includeSubfolders && !args.includeFiles) context.addIssue({ code: 'custom', message: 'At least one of includeSubfolders or includeFiles must be true.' });
            if (args.maxItems !== undefined && args.depth === 1) context.addIssue({ code: 'custom', message: 'maxItems is only valid when depth is greater than 1.' });
            if (!args.includeSubfolders && args.depth !== 1) context.addIssue({ code: 'custom', message: 'includeSubfolders must be true when depth is greater than 1.' });
        }),
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Listing contents of folder: ${args.folderId}`);
            try {
                const depth = args.depth ?? 1;
                const includeSubfolders = args.includeSubfolders ?? true;
                const includeFiles = args.includeFiles ?? true;
                const maxResults = args.maxResults ?? 50;
                // Keep depth 1 to its established single Drive page. Its additive
                // truncation signal lets callers distinguish that page from a full listing.
                if (depth === 1) {
                    let queryString = `'${escapeDriveQueryValue(args.folderId)}' in parents and trashed=false`;
                    if (!includeSubfolders) queryString += ` and mimeType!='${FOLDER_MIME_TYPE}'`;
                    else if (!includeFiles) queryString += ` and mimeType='${FOLDER_MIME_TYPE}'`;
                    const response = await drive.files.list({
                        q: queryString, pageSize: maxResults, orderBy: 'folder,name',
                        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
                        supportsAllDrives: true, includeItemsFromAllDrives: true,
                    });
                    const items = response.data.files || [];
                    const folders = items.filter((f) => f.mimeType === FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
                    const files = items.filter((f) => f.mimeType !== FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime }));
                    const truncated = Boolean(response.data.nextPageToken);
                    const truncationReason = truncated
                        ? `maxResults (${maxResults}) single-page cap reached; raise maxResults (up to the maximum of 100) or use depth with maxItems for a bounded recursive traversal.`
                        : undefined;
                    return JSON.stringify({ folders, files, truncated, ...(truncationReason ? { truncationReason } : {}) }, null, 2);
                }

                const maxItems = args.maxItems ?? 500;
                let apiCalls = 0;
                const countApiCall = () => {
                    if (apiCalls >= API_CALL_BUDGET) throw new Error('API_CALL_BUDGET_EXHAUSTED');
                    apiCalls += 1;
                };
                let startFolder;
                try {
                    countApiCall();
                    const response = await drive.files.get({ fileId: args.folderId, fields: 'id,name,driveId', supportsAllDrives: true });
                    startFolder = response.data;
                }
                catch (error) {
                    if (error?.message === 'API_CALL_BUDGET_EXHAUSTED') throw error;
                    if (getStatus(error) === 404) throw publicError('Folder not found. Check the folder ID.');
                    if (isRateLimitStatus(error)) throw publicError('Google Drive rate limit or quota exceeded while accessing this folder. Wait and retry with backoff (see https://developers.google.com/workspace/drive/api/guides/limits).');
                    if (getStatus(error) === 403) throw publicError('Permission denied. Make sure you have access to this folder.');
                    throw wrapOperationError('get folder details', error, { status: getStatus(error) });
                }
                // For a shared-drive root, scope every recursive files.list call to
                // that drive. Without this, files.list defaults to corpora='user'
                // (files the caller has personally accessed) even with
                // includeItemsFromAllDrives:true, so descendants the caller has
                // access to via the shared drive but never individually opened are
                // silently omitted from a traversal that reports truncated: false —
                // see https://developers.google.com/workspace/drive/api/guides/enable-shareddrives#search_for_content_on_a_shared_drive
                const sharedDriveId = startFolder.driveId || undefined;

                const entries = [];
                const entriesById = new Map();
                const visitedFolders = new Set([startFolder.id]);
                const unreadable = [];
                let currentLevel = [{ id: startFolder.id, path: startFolder.name, depth: 0 }];
                let truncated = false;
                let truncationReason;
                const addEntry = (file, parentNodes) => {
                    if (!file.id || entriesById.has(file.id)) {
                        const existing = entriesById.get(file.id);
                        if (existing) for (const parentId of file.parents || []) if (!existing.parentIds.includes(parentId)) existing.parentIds.push(parentId);
                        return { entry: existing, added: false };
                    }
                    if (entries.length >= maxItems) return { entry: null, added: false };
                    const parentId = (file.parents || []).find((id) => parentNodes.some((parent) => parent.id === id)) || parentNodes[0]?.id;
                    const parent = parentNodes.find((node) => node.id === parentId) || parentNodes[0];
                    const entry = { id: file.id, name: file.name, mimeType: file.mimeType, path: `${parent.path}/${file.name}`, parentIds: [...new Set(file.parents || [parent.id])], modifiedTime: file.modifiedTime };
                    if (file.mimeType !== FOLDER_MIME_TYPE && file.size !== undefined) entry.size = file.size;
                    if (file.mimeType === SHORTCUT_MIME_TYPE && file.shortcutDetails?.targetId) entry.shortcutDetails = { targetId: file.shortcutDetails.targetId };
                    entries.push(entry);
                    entriesById.set(entry.id, entry);
                    return { entry, added: true };
                };
                // Pages are handed to `onPage` as soon as each arrives (instead of
                // being buffered for the whole chunk before anything downstream
                // sees them) so that a maxItems cap already satisfied by an
                // earlier page can stop pagination before the next page is
                // requested — a 1-item request must not still page through
                // thousands of children first (PR #113 review finding 2).
                const listParentChunk = async (parentNodes, onPage) => {
                    const query = `(${parentNodes.map((parent) => `'${escapeDriveQueryValue(parent.id)}' in parents`).join(' or ')}) and trashed=false`;
                    let pageToken;
                    let budgetExhausted = false;
                    let stopped = false;
                    do {
                        try {
                            countApiCall();
                        }
                        catch (error) {
                            if (error?.message !== 'API_CALL_BUDGET_EXHAUSTED') throw error;
                            budgetExhausted = true;
                            break;
                        }
                        const response = await drive.files.list({
                            q: query, pageSize: RECURSIVE_PAGE_SIZE, pageToken, orderBy: 'folder,name',
                            fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,shortcutDetails)',
                            supportsAllDrives: true, includeItemsFromAllDrives: true,
                            ...(sharedDriveId ? { corpora: 'drive', driveId: sharedDriveId } : {}),
                        });
                        pageToken = response.data.nextPageToken || undefined;
                        stopped = onPage(response.data.files || []) === true;
                    } while (pageToken && !stopped);
                    return { budgetExhausted, stopped };
                };
                const listWithIsolation = async (parentNodes, onPage) => {
                    try { return await listParentChunk(parentNodes, onPage); }
                    catch (error) {
                        // Drive uses 403 for both "you can't read this folder" and
                        // "you're over quota/rate limit right now" — the latter is
                        // Google explicitly documenting exponential backoff, not a
                        // per-folder access problem, so it must never be fabricated
                        // into an `unreadable` entry or trigger isolation bisection
                        // (which would only spend more calls while the service is
                        // asking the client to back off) (finding 1).
                        if (isRateLimitStatus(error)) throw error;
                        if (getStatus(error) !== 403 && getStatus(error) !== 404) throw error;
                        if (parentNodes.length === 1) {
                            const parent = parentNodes[0];
                            unreadable.push({ id: parent.id, path: parent.path, reason: getStatus(error) === 404 ? 'Folder not found or no longer available.' : 'Permission denied or folder unavailable.' });
                            return { budgetExhausted: false, stopped: false };
                        }
                        const midpoint = Math.ceil(parentNodes.length / 2);
                        const first = await listWithIsolation(parentNodes.slice(0, midpoint), onPage);
                        if (first.budgetExhausted || first.stopped) return first;
                        const second = await listWithIsolation(parentNodes.slice(midpoint), onPage);
                        return { budgetExhausted: second.budgetExhausted, stopped: second.stopped };
                    }
                };

                const maxDepth = depth === 'all' ? Infinity : depth;
                while (currentLevel.length > 0 && currentLevel[0].depth < maxDepth && !truncated) {
                    const nextLevel = [];
                    const onPage = (files) => {
                        for (const file of files) {
                            if (file.mimeType !== FOLDER_MIME_TYPE && !includeFiles) continue;
                            const result = addEntry(file, currentLevel);
                            if (!result.entry && entries.length >= maxItems) {
                                truncated = true;
                                truncationReason = `maxItems (${maxItems}) reached at depth ${currentLevel[0].depth + 1}; ${nextLevel.length} discovered folders not expanded`;
                                return true;
                            }
                            if (file.mimeType === FOLDER_MIME_TYPE && result.added && visitedFolders.add(file.id)) nextLevel.push({ id: file.id, path: result.entry.path, depth: currentLevel[0].depth + 1 });
                        }
                        return false;
                    };
                    for (let index = 0; index < currentLevel.length && !truncated; index += PARENT_CHUNK_SIZE) {
                        let chunkResult;
                        try { chunkResult = await listWithIsolation(currentLevel.slice(index, index + PARENT_CHUNK_SIZE), onPage); }
                        catch (error) { throw error; }
                        if (!truncated && chunkResult.budgetExhausted) {
                            truncated = true;
                            truncationReason = `API call budget (${API_CALL_BUDGET}) exhausted`;
                        }
                    }
                    currentLevel = nextLevel;
                }
                if (!truncated && maxDepth !== Infinity && currentLevel.length > 0 && currentLevel[0].depth === maxDepth) {
                    truncated = true;
                    truncationReason = `depth (${maxDepth}) reached; ${currentLevel.length} discovered folders not expanded`;
                }
                return JSON.stringify({ entries, count: entries.length, truncated, ...(truncationReason ? { truncationReason } : {}), unreadable, apiCalls }, null, 2);
            }
            catch (error) {
                if (isPublicError(error)) throw error;
                log.error('Error listing folder contents.');
                if (getStatus(error) === 404) throw publicError('Folder not found. Check the folder ID.');
                if (isRateLimitStatus(error)) throw publicError('Google Drive rate limit or quota exceeded while listing folder contents. Wait and retry with backoff (see https://developers.google.com/workspace/drive/api/guides/limits).');
                if (getStatus(error) === 403) throw publicError('Permission denied. Make sure you have access to this folder.');
                throw wrapOperationError('list folder contents', error, { status: getStatus(error) });
            }
        },
    });
}
