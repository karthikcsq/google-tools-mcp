## `listFolderContents`

### `feat/independents`

Tool registration and schema:

[`dist/tools/drive/listFolderContents.js:45-61`](<C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE/dist/tools/drive/listFolderContents.js:45>)

```js
export function register(server) {
    server.addTool({
        name: 'listFolderContents',
        ...
        execute: async (args, { log }) => {
```

The depth-1 listing is inline in `execute`, at [`:70-82`](<C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE/dist/tools/drive/listFolderContents.js:70>):

```js
let queryString = `'${escapeDriveQueryValue(args.folderId)}' in parents and trashed=false`;
if (!includeSubfolders) queryString += ` and mimeType!='${FOLDER_MIME_TYPE}'`;
else if (!includeFiles) queryString += ` and mimeType='${FOLDER_MIME_TYPE}'`;

const response = await drive.files.list({
    q: queryString, pageSize: maxResults, orderBy: 'folder,name',
    fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
    supportsAllDrives: true, includeItemsFromAllDrives: true,
});
```

Parameters:

- `q`: folder ID in `parents`, plus `trashed=false`; optionally a folder MIME-type filter.
- `pageSize`: `maxResults`, default `50`.
- `orderBy`: `'folder,name'`.
- `fields`: `'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))'`.
- `supportsAllDrives`: `true`.
- `includeItemsFromAllDrives`: `true`.
- No `corpora`, `driveId`, `spaces`, or `pageToken`.
- `nextPageToken` is not requested or handled.

The recursive listing uses a separate helper, [`:142-166`](<C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE/dist/tools/drive/listFolderContents.js:142>):

```js
const listParentChunk = async (parentNodes, onPage) => {
    const query = `(${parentNodes.map((parent) => `'${escapeDriveQueryValue(parent.id)}' in parents`).join(' or ')}) and trashed=false`;
    let pageToken;
    ...
    const response = await drive.files.list({
        q: query, pageSize: RECURSIVE_PAGE_SIZE, pageToken, orderBy: 'folder,name',
        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,shortcutDetails)',
        supportsAllDrives: true, includeItemsFromAllDrives: true,
        ...(sharedDriveId ? { corpora: 'drive', driveId: sharedDriveId } : {}),
    });
    pageToken = response.data.nextPageToken || undefined;
    stopped = onPage(response.data.files || []) === true;
} while (pageToken && !stopped);
```

Recursive parameters:

- `q`: an `OR` disjunction of up to 50 parent IDs, plus `trashed=false`.
- `pageSize`: constant `RECURSIVE_PAGE_SIZE`, `100`.
- `pageToken`: passed on every iteration, initially `undefined`, then taken from `response.data.nextPageToken`.
- `orderBy`: `'folder,name'`.
- `fields`: includes `nextPageToken`, `parents`, and `shortcutDetails`.
- `supportsAllDrives`: `true`.
- `includeItemsFromAllDrives`: `true`.
- `corpora: 'drive'` and `driveId: sharedDriveId` only when the initial folder metadata contains a `driveId`.
- No `spaces`.

### `docs/mcp-plan-client-evidence`

The tool and listing are both inline in `execute`, at [`dist/tools/drive/listFolderContents.js:4-53`](<C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-pr109/dist/tools/drive/listFolderContents.js:4>):

```js
export function register(server) {
    server.addTool({
        name: 'listFolderContents',
        ...
        execute: async (args, { log }) => {
```

```js
let queryString = `'${args.folderId}' in parents and trashed=false`;
if (!args.includeSubfolders) {
    queryString += ` and mimeType!='application/vnd.google-apps.folder'`;
}
else if (!args.includeFiles) {
    queryString += ` and mimeType='application/vnd.google-apps.folder'`;
}
const response = await drive.files.list({
    q: queryString,
    pageSize: args.maxResults,
    orderBy: 'folder,name',
    fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
});
```

It passes:

- `q`: folder ID in `parents`, plus `trashed=false`, with the optional MIME filter.
- `pageSize`: `args.maxResults`.
- `orderBy`: `'folder,name'`.
- `fields`: `'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))'`.
- `supportsAllDrives`: `true`.
- `includeItemsFromAllDrives`: `true`.
- No `corpora`, `driveId`, `spaces`, or `pageToken`.
- No pagination handling.

## Recursive traversal

Only `feat/independents` has recursive traversal. It:

1. Gets the starting folder metadata, including `driveId`, at [`:91-111`](<C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE/dist/tools/drive/listFolderContents.js:91>).
2. Maintains the current BFS level in `currentLevel`.
3. Chunks parent folders in groups of 50 at [`:208-217`](<C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE/dist/tools/drive/listFolderContents.js:208>).
4. Calls `listWithIsolation`, which calls `listParentChunk`.
5. Adds discovered folders to `nextLevel` at [`:195-205`](<C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE/dist/tools/drive/listFolderContents.js:195>).
6. Replaces `currentLevel` with `nextLevel` and continues.

This is a second listing code path. The legacy depth-1 block does not reuse `listParentChunk`.

## Empty results, failures, and truncation

In `docs/mcp-plan-client-evidence`, zero items become empty arrays:

```js
const items = response.data.files || [];
...
return JSON.stringify({ folders, files }, null, 2);
```

[`dist/tools/drive/listFolderContents.js:54-70`](<C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-pr109/dist/tools/drive/listFolderContents.js:54>)

It does not distinguish an empty folder from a successful enumeration that happened to return no items. It also ignores any `nextPageToken`, so it exposes no pagination truncation or partial-result status. API errors are thrown or mapped to public errors.

The depth-1 path in `feat/independents` behaves the same way.

The recursive path does expose structured status:

```js
return JSON.stringify({
    entries,
    count: entries.length,
    truncated,
    ...(truncationReason ? { truncationReason } : {}),
    unreadable,
    apiCalls
}, null, 2);
```

[`dist/tools/drive/listFolderContents.js:223`](<C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE/dist/tools/drive/listFolderContents.js:223>)

It records child-folder 403/404 failures in `unreadable`, follows pagination, and reports cap, depth, or API-budget truncation. It does not return raw page tokens or per-page diagnostics.

## `supportsAllDrives` and `includeItemsFromAllDrives`

Both flags appear in the target listing code:

[`feat/independents/dist/tools/drive/listFolderContents.js:74-78`](<C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE/dist/tools/drive/listFolderContents.js:74>)

```js
const response = await drive.files.list({
    q: queryString, pageSize: maxResults, orderBy: 'folder,name',
    fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
    supportsAllDrives: true, includeItemsFromAllDrives: true,
});
```

[`feat/independents/dist/tools/drive/listFolderContents.js:156-161`](<C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE/dist/tools/drive/listFolderContents.js:156>)

```js
const response = await drive.files.list({
    ...
    supportsAllDrives: true, includeItemsFromAllDrives: true,
    ...(sharedDriveId ? { corpora: 'drive', driveId: sharedDriveId } : {}),
});
```

[`docs/mcp-plan-client-evidence/dist/tools/drive/listFolderContents.js:46-53`](<C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-pr109/dist/tools/drive/listFolderContents.js:46>)

```js
const response = await drive.files.list({
    ...
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
});
```

Repository-wide, excluding `node_modules` and `.git`:

- `supportsAllDrives`: 33 files in `feat/independents`, 31 files in `docs/mcp-plan-client-evidence`.
- The common files are the Drive, Docs, Sheets, Slides, extras, helper, tracker, and two plan files containing the flag.
- `feat/independents` additionally has `tests/createDocument.test.js` and `tests/drivePermissions.test.js`.
- `includeItemsFromAllDrives`: exactly these six files in both trees:
  - `docs/plans/issue-99-recursive-folder-listing.md`
  - `dist/tools/extras/searchFileContents.js`
  - `dist/tools/drive/listDriveFiles.js`
  - `dist/tools/drive/listFolderContents.js`
  - `dist/tools/drive/listSharedWithMe.js`
  - `dist/tools/drive/searchGoogleDocs.js`

The plan also states the intended recursive flags at [`docs/plans/issue-99-recursive-folder-listing.md:21-24`](<C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE/docs/plans/issue-99-recursive-folder-listing.md:21>).

## `getFileInfo`

The implementation is identical in both trees, at [`dist/tools/drive/getFileInfo.js:4-19`](<C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE/dist/tools/drive/getFileInfo.js:4>):

```js
export function register(server) {
    server.addTool({
        name: 'getFileInfo',
        ...
        execute: async (args, { log }) => {
            ...
            const response = await drive.files.get({
                fileId: args.fileId,
                fields: 'id,name,description,mimeType,size,createdTime,modifiedTime,webViewLink,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),shared,parents,version',
                supportsAllDrives: true,
            });
```

`getFileInfo` passes:

- `fileId`
- Its metadata `fields` mask
- `supportsAllDrives: true`

Compared with `listFolderContents`, `fileId` is the parameter unique to `files.get`. `getFileInfo` does not pass `q`, `pageSize`, `orderBy`, `corpora`, `driveId`, `includeItemsFromAllDrives`, `spaces`, or `pageToken`.

No files were modified.

### In flight

Nothing is running.

