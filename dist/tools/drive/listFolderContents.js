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

export function register(server) {
    server.addTool({
        name: 'listFolderContents',
        description: "Lists files and subfolders within a Drive folder. Use folderId='root' to browse the top-level of the Drive. With depth omitted or 1, returns the legacy {folders, files} result. With depth 2 through 10 or 'all', returns a flat breadth-first {entries, count, truncated, truncationReason?, unreadable, apiCalls} tree; each entry has path and parentIds. A node is listed once, using its first-discovered BFS path, while parentIds preserves multiple discovered parent edges. Shortcuts include shortcutDetails.targetId but are never expanded. Recursive calls cap output with maxItems (default 500, maximum 5000), report every truncation, and use maxResults only for the legacy depth-1 response. Use getFilePath for the inverse, upward path lookup.",
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
                // Keep the legacy depth-1 request and response shape intact.
                if (depth === 1) {
                    let queryString = `'${escapeDriveQueryValue(args.folderId)}' in parents and trashed=false`;
                    if (!includeSubfolders) queryString += ` and mimeType!='${FOLDER_MIME_TYPE}'`;
                    else if (!includeFiles) queryString += ` and mimeType='${FOLDER_MIME_TYPE}'`;
                    const response = await drive.files.list({
                        q: queryString, pageSize: maxResults, orderBy: 'folder,name',
                        fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
                        supportsAllDrives: true, includeItemsFromAllDrives: true,
                    });
                    const items = response.data.files || [];
                    const folders = items.filter((f) => f.mimeType === FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
                    const files = items.filter((f) => f.mimeType !== FOLDER_MIME_TYPE).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime }));
                    return JSON.stringify({ folders, files }, null, 2);
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
                    const response = await drive.files.get({ fileId: args.folderId, fields: 'id,name', supportsAllDrives: true });
                    startFolder = response.data;
                }
                catch (error) {
                    if (error?.message === 'API_CALL_BUDGET_EXHAUSTED') throw error;
                    if (getStatus(error) === 404) throw publicError('Folder not found. Check the folder ID.');
                    if (getStatus(error) === 403) throw publicError('Permission denied. Make sure you have access to this folder.');
                    throw wrapOperationError('get folder details', error, { status: getStatus(error) });
                }

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
                const listParentChunk = async (parentNodes) => {
                    const query = `(${parentNodes.map((parent) => `'${escapeDriveQueryValue(parent.id)}' in parents`).join(' or ')}) and trashed=false`;
                    const files = [];
                    let pageToken;
                    let budgetExhausted = false;
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
                        });
                        files.push(...(response.data.files || []));
                        pageToken = response.data.nextPageToken || undefined;
                    } while (pageToken);
                    return { files, budgetExhausted };
                };
                const listWithIsolation = async (parentNodes) => {
                    try { return await listParentChunk(parentNodes); }
                    catch (error) {
                        if (getStatus(error) !== 403 && getStatus(error) !== 404) throw error;
                        if (parentNodes.length === 1) {
                            const parent = parentNodes[0];
                            unreadable.push({ id: parent.id, path: parent.path, reason: getStatus(error) === 404 ? 'Folder not found or no longer available.' : 'Permission denied or folder unavailable.' });
                            return { files: [], budgetExhausted: false };
                        }
                        const midpoint = Math.ceil(parentNodes.length / 2);
                        const first = await listWithIsolation(parentNodes.slice(0, midpoint));
                        if (first.budgetExhausted) return first;
                        const second = await listWithIsolation(parentNodes.slice(midpoint));
                        return { files: [...first.files, ...second.files], budgetExhausted: second.budgetExhausted };
                    }
                };

                const maxDepth = depth === 'all' ? Infinity : depth;
                while (currentLevel.length > 0 && currentLevel[0].depth < maxDepth && !truncated) {
                    const nextLevel = [];
                    for (let index = 0; index < currentLevel.length && !truncated; index += PARENT_CHUNK_SIZE) {
                        let chunkResult;
                        try { chunkResult = await listWithIsolation(currentLevel.slice(index, index + PARENT_CHUNK_SIZE)); }
                        catch (error) { throw error; }
                        const { files, budgetExhausted } = chunkResult;
                        for (const file of files) {
                            if (file.mimeType !== FOLDER_MIME_TYPE && !includeFiles) continue;
                            const result = addEntry(file, currentLevel);
                            if (!result.entry && entries.length >= maxItems) {
                                truncated = true;
                                truncationReason = `maxItems (${maxItems}) reached at depth ${currentLevel[0].depth + 1}; ${nextLevel.length} discovered folders not expanded`;
                                break;
                            }
                            if (file.mimeType === FOLDER_MIME_TYPE && result.added && visitedFolders.add(file.id)) nextLevel.push({ id: file.id, path: result.entry.path, depth: currentLevel[0].depth + 1 });
                        }
                        if (!truncated && budgetExhausted) {
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
                if (getStatus(error) === 403) throw publicError('Permission denied. Make sure you have access to this folder.');
                throw wrapOperationError('list folder contents', error, { status: getStatus(error) });
            }
        },
    });
}
