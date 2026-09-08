// In-memory subset of the googleapis clients required by the offline agent
// harness.  It deliberately has the same client getter exports as
// dist/clients.js, but never imports auth/config or reads credential files.

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOCUMENT_MIME = 'application/vnd.google-apps.document';
const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';

export const OFFLINE_UNSUPPORTED = 'OFFLINE_UNSUPPORTED';
export const OFFLINE_LIMITATIONS = Object.freeze([
    'Data is process-local and is discarded when the Node process exits.',
    'Drive writes are confined to the configured offline folder and its descendants.',
    'Docs supports plain-text body edits only; tabs, rich formatting, images, tables, comments, and templates are unsupported.',
    'Sheets supports a single plain-value grid and basic A1 reads and writes; formatting, charts, formulas, and multi-sheet operations are unsupported.',
    'Gmail only supports users.getProfile. Calendar, Forms, Slides, Tasks, Apps Script, and other Gmail operations are unavailable offline.',
]);

let state = null;
let clients = null;

const clone = (value) => structuredClone(value);

function apiError(code, message, status = 'FAILED_PRECONDITION') {
    const error = new Error(message);
    error.code = code;
    error.status = code;
    error.response = { data: { error: { code, message, status } } };
    return error;
}

function unsupported(method, detail = 'is not implemented by the offline backend.') {
    const error = new Error(`${OFFLINE_UNSUPPORTED}: ${method} ${detail}`);
    error.code = OFFLINE_UNSUPPORTED;
    error.status = OFFLINE_UNSUPPORTED;
    return error;
}

function recordError(method, error) {
    state.counters.errors += 1;
    state.lastError = {
        method,
        code: typeof error?.code === 'string' ? error.code : String(error?.code ?? 'OFFLINE_ERROR'),
        message: String(error?.message ?? 'Offline operation failed.'),
    };
    if (error?.code === OFFLINE_UNSUPPORTED) {
        state.counters.unsupported += 1;
        state.lastUnsupported = { method, message: state.lastError.message };
    }
}

async function operation(method, perform) {
    if (!state) throw new Error('Offline backend is not configured. Call installOfflineBackend before importing dist modules.');
    state.counters.calls += 1;
    state.counters.byMethod[method] = (state.counters.byMethod[method] ?? 0) + 1;
    try {
        return { data: clone(await perform()) };
    } catch (error) {
        recordError(method, error);
        throw error;
    }
}

function assertObject(value, method) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw unsupported(method, 'requires an object request body.');
    }
}

function assertKnownKeys(value, allowed, method) {
    assertObject(value, method);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) throw unsupported(method, `does not support request field "${key}".`);
    }
}

function now() {
    state.clock += 1;
    return new Date(state.startedAt + state.clock).toISOString();
}

function nextId(kind) {
    state.sequence += 1;
    return `offline_${kind}_${state.sequence}`;
}

function nextRevision() {
    state.revisionSequence += 1;
    return `offline-revision-${state.revisionSequence}`;
}

function requireFile(fileId) {
    const file = state.files.get(fileId);
    if (!file) throw apiError(404, `Offline file ${fileId} was not found.`, 'NOT_FOUND');
    return file;
}

function requireLiveFile(fileId) {
    const file = requireFile(fileId);
    if (file.trashed) throw apiError(404, `Offline file ${fileId} is in the trash.`, 'NOT_FOUND');
    return file;
}

function requireFolder(fileId) {
    const file = requireLiveFile(fileId);
    if (file.mimeType !== FOLDER_MIME) {
        throw apiError(400, `Offline file ${fileId} is not a folder.`, 'INVALID_ARGUMENT');
    }
    return file;
}

function isInsideFolder(fileId) {
    if (fileId === state.folderId) return true;
    const seen = new Set();
    let current = fileId;
    while (current && !seen.has(current)) {
        seen.add(current);
        const file = state.files.get(current);
        if (!file) return false;
        if (file.parents.includes(state.folderId)) return true;
        current = file.parents[0] ?? null;
    }
    return false;
}

function assertSandboxParents(parents, method) {
    if (!Array.isArray(parents) || parents.length === 0) {
        throw apiError(400, `${method} requires a parent inside the configured offline folder.`, 'INVALID_ARGUMENT');
    }
    for (const parentId of parents) {
        requireFolder(parentId);
        if (!isInsideFolder(parentId)) {
            throw apiError(403, `${method} refused parent ${parentId} outside the configured offline folder.`, 'PERMISSION_DENIED');
        }
    }
}

function touch(file) {
    file.modifiedTime = now();
    file.version += 1;
}

function publicFile(file) {
    return {
        id: file.id,
        name: file.name,
        description: file.description ?? '',
        mimeType: file.mimeType,
        size: String(file.size ?? 0),
        createdTime: file.createdTime,
        modifiedTime: file.modifiedTime,
        webViewLink: file.webViewLink,
        owners: [{ displayName: 'Offline Tester', emailAddress: 'offline-tester@example.invalid' }],
        lastModifyingUser: { displayName: 'Offline Tester', emailAddress: 'offline-tester@example.invalid' },
        shared: false,
        parents: [...file.parents],
        trashed: file.trashed,
        version: String(file.version),
    };
}

function makeDocument(text = '') {
    return {
        text,
        styles: Array(text.length).fill(null),
        tabId: `offline_tab_${state.sequence + 1}`,
        revisionId: nextRevision(),
        revisions: [],
    };
}

function makeSpreadsheet() {
    return {
        sheets: [{ properties: { sheetId: 0, title: 'Sheet1', gridProperties: { rowCount: 1000, columnCount: 26 } }, values: [] }],
    };
}

function makeFile({ id = nextId('file'), name, mimeType, parents, description = '' }) {
    const createdTime = now();
    const file = {
        id,
        name,
        description,
        mimeType,
        parents: [...parents],
        trashed: false,
        createdTime,
        modifiedTime: createdTime,
        version: 1,
        size: 0,
        webViewLink: `https://offline.invalid/drive/${id}`,
        document: mimeType === DOCUMENT_MIME ? makeDocument() : null,
        spreadsheet: mimeType === SPREADSHEET_MIME ? makeSpreadsheet() : null,
    };
    state.files.set(id, file);
    return file;
}

function ensureDocument(fileId) {
    const file = requireLiveFile(fileId);
    if (file.mimeType !== DOCUMENT_MIME || !file.document) {
        throw apiError(400, `Offline file ${fileId} is not a Google Document.`, 'INVALID_ARGUMENT');
    }
    return file;
}

function ensureSpreadsheet(fileId) {
    const file = requireLiveFile(fileId);
    if (file.mimeType !== SPREADSHEET_MIME || !file.spreadsheet) {
        throw apiError(400, `Offline file ${fileId} is not a spreadsheet.`, 'INVALID_ARGUMENT');
    }
    return file;
}

function documentBody(document) {
    const source = `${document.text}\n`;
    let index = 1;
    let lineStart = 0;
    const content = [];
    for (let offset = 0; offset < source.length; offset += 1) {
        if (source[offset] !== '\n') continue;
        const rendered = source.slice(lineStart, offset + 1);
        const elements = [];
        let runStart = 0;
        let runStyle = JSON.stringify(document.styles[lineStart] ?? {});
        for (let runOffset = 1; runOffset <= rendered.length; runOffset += 1) {
            const absolute = lineStart + runOffset;
            const nextStyle = runOffset < rendered.length
                ? JSON.stringify(document.styles[absolute] ?? {})
                : null;
            if (nextStyle !== runStyle) {
                const contentStart = index + runStart;
                const contentEnd = index + runOffset;
                elements.push({
                    startIndex: contentStart,
                    endIndex: contentEnd,
                    textRun: {
                        content: rendered.slice(runStart, runOffset),
                        textStyle: JSON.parse(runStyle),
                    },
                });
                runStart = runOffset;
                runStyle = nextStyle;
            }
        }
        const element = {
            startIndex: index,
            endIndex: index + rendered.length,
            paragraph: {
                elements,
                paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            },
        };
        index += rendered.length;
        content.push(element);
        lineStart = offset + 1;
    }
    return { content };
}

function documentResource(file, { includeTabsContent = false } = {}) {
    const body = documentBody(file.document);
    const resource = {
        documentId: file.id,
        title: file.name,
        revisionId: file.document.revisionId,
        body,
        documentStyle: {},
        namedStyles: { styles: [] },
        lists: {},
    };
    if (includeTabsContent) {
        resource.tabs = [{
            tabProperties: { tabId: file.document.tabId, title: 'Offline tab', index: 0 },
            documentTab: { body: clone(body), lists: {} },
        }];
    }
    return resource;
}

function assertSupportedTab(file, value, method) {
    if (value !== undefined && value !== null && value !== '' && value !== file.document.tabId) {
        throw unsupported(method, 'does not support document tabs.');
    }
}

function applyDocumentRequest(file, request) {
    assertObject(request, 'docs.documents.batchUpdate');
    const entries = Object.entries(request);
    if (entries.length !== 1) throw unsupported('docs.documents.batchUpdate', 'requires one operation per request.');
    const [kind, value] = entries[0];
    if (kind === 'insertText') {
        assertKnownKeys(value, new Set(['location', 'text']), 'docs.documents.batchUpdate.insertText');
        if (!value.location || typeof value.location.index !== 'number' || typeof value.text !== 'string') {
            throw apiError(400, 'Offline insertText requires a numeric location.index and string text.', 'INVALID_ARGUMENT');
        }
        assertSupportedTab(file, value.location.tabId, 'docs.documents.batchUpdate.insertText');
        const position = value.location.index - 1;
        if (!Number.isInteger(position) || position < 0 || position > file.document.text.length) {
            throw apiError(400, `Offline insertText index ${value.location.index} is outside the document body.`, 'INVALID_ARGUMENT');
        }
        file.document.text = file.document.text.slice(0, position) + value.text + file.document.text.slice(position);
        file.document.styles.splice(position, 0, ...Array(value.text.length).fill(null));
        return;
    }
    if (kind === 'deleteContentRange') {
        if (!value || !value.range || typeof value.range.startIndex !== 'number' || typeof value.range.endIndex !== 'number') {
            throw apiError(400, 'Offline deleteContentRange requires numeric range indices.', 'INVALID_ARGUMENT');
        }
        assertSupportedTab(file, value.range.tabId, 'docs.documents.batchUpdate.deleteContentRange');
        const start = value.range.startIndex - 1;
        const end = value.range.endIndex - 1;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > file.document.text.length) {
            throw apiError(400, 'Offline deleteContentRange is outside the document body.', 'INVALID_ARGUMENT');
        }
        file.document.text = file.document.text.slice(0, start) + file.document.text.slice(end);
        file.document.styles.splice(start, end - start);
        return;
    }
    if (kind === 'updateTextStyle') {
        // Every plain-text insertion in the production tools gets an explicit
        // NORMAL_TEXT foreground color. It changes visual styling only, which
        // this text-only backend intentionally does not model, so accept that
        // exact write while rejecting other formatting requests explicitly.
        if (!value || value.fields !== 'foregroundColor' || !value.range || !value.textStyle?.foregroundColor) {
            throw unsupported('docs.documents.batchUpdate', 'only the default foregroundColor style emitted by plain-text tools is supported.');
        }
        assertKnownKeys(value, new Set(['range', 'textStyle', 'fields']), 'docs.documents.batchUpdate.updateTextStyle');
        assertKnownKeys(value.textStyle, new Set(['foregroundColor']), 'docs.documents.batchUpdate.updateTextStyle');
        assertSupportedTab(file, value.range.tabId, 'docs.documents.batchUpdate.updateTextStyle');
        const start = value.range.startIndex - 1;
        const end = value.range.endIndex - 1;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > file.document.text.length) {
            throw apiError(400, 'Offline updateTextStyle is outside the document body.', 'INVALID_ARGUMENT');
        }
        for (let index = start; index < end; index += 1) file.document.styles[index] = clone(value.textStyle);
        return;
    }
    throw unsupported('docs.documents.batchUpdate', `does not support ${kind}. Plain insertText and deleteContentRange are available.`);
}

function parseA1(range) {
    if (typeof range !== 'string' || range.trim() === '') {
        throw apiError(400, 'Offline Sheets requires a non-empty A1 range.', 'INVALID_ARGUMENT');
    }
    const [sheetPart, cells] = range.includes('!') ? range.split('!', 2) : [null, range];
    const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i.exec(cells);
    if (!match) throw unsupported('sheets.spreadsheets.values', `does not support A1 range "${range}".`);
    const column = (letters) => [...letters.toUpperCase()].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
    return {
        sheetName: sheetPart?.replace(/^'|'$/g, '') ?? null,
        startCol: column(match[1]),
        startRow: Number(match[2]) - 1,
        endCol: match[3] ? column(match[3]) : column(match[1]),
        endRow: match[4] ? Number(match[4]) - 1 : Number(match[2]) - 1,
    };
}

function resolveSheet(file, range) {
    const parsed = parseA1(range);
    const sheet = parsed.sheetName
        ? file.spreadsheet.sheets.find((candidate) => candidate.properties.title === parsed.sheetName)
        : file.spreadsheet.sheets[0];
    if (!sheet) throw apiError(400, `Offline sheet "${parsed.sheetName}" was not found.`, 'INVALID_ARGUMENT');
    return { parsed, sheet };
}

function trimValues(values) {
    const result = values.map((row) => {
        const copy = [...row];
        while (copy.length > 0 && copy[copy.length - 1] === undefined) copy.pop();
        return copy;
    });
    while (result.length > 0 && result[result.length - 1].length === 0) result.pop();
    return result;
}

function unimplementedResource(path) {
    // A callable proxy lets arbitrary unsupported API paths fail at the final
    // invocation. For example, slides.presentations.create() records one
    // OFFLINE_UNSUPPORTED error instead of throwing a TypeError while looking
    // up the intermediate presentations resource.
    return new Proxy(function offlineUnsupportedInvocation() {}, {
        get(_target, property) {
            if (property === 'then') return undefined;
            if (typeof property !== 'string') return undefined;
            return unimplementedResource(`${path}.${property}`);
        },
        apply() {
            return operation(path, () => { throw unsupported(path); });
        },
    });
}

class OfflineDriveFiles {
    async create(params = {}) {
        return operation('drive.files.create', () => {
            assertKnownKeys(params.requestBody ?? {}, new Set(['name', 'mimeType', 'parents', 'description']), 'drive.files.create');
            const body = params.requestBody;
            if (typeof body.name !== 'string' || body.name.trim() === '' || typeof body.mimeType !== 'string') {
                throw apiError(400, 'Offline Drive create requires requestBody.name and requestBody.mimeType.', 'INVALID_ARGUMENT');
            }
            const parents = Array.isArray(body.parents) ? body.parents : [];
            assertSandboxParents(parents, 'Offline Drive create');
            return publicFile(makeFile({ name: body.name, mimeType: body.mimeType, parents, description: body.description ?? '' }));
        });
    }

    async get(params = {}) {
        return operation('drive.files.get', () => {
            if (params.fileId === 'root') return publicFile(requireFile(state.folderId));
            return publicFile(requireFile(params.fileId));
        });
    }

    async list(params = {}) {
        return operation('drive.files.list', () => {
            let entries = [...state.files.values()].filter((file) => file.id !== state.folderId);
            const query = params.q?.trim();
            if (query) entries = filterDriveQuery(entries, query);
            const order = params.orderBy ?? 'name';
            entries.sort((a, b) => compareDriveFiles(a, b, order));
            const pageSize = Number.isInteger(params.pageSize) && params.pageSize > 0 ? params.pageSize : 100;
            const start = params.pageToken ? Number(params.pageToken) : 0;
            if (!Number.isInteger(start) || start < 0) throw apiError(400, 'Offline pageToken must be a numeric offset.', 'INVALID_ARGUMENT');
            const page = entries.slice(start, start + pageSize).map(publicFile);
            const next = start + pageSize < entries.length ? String(start + pageSize) : undefined;
            return { files: page, ...(next ? { nextPageToken: next } : {}) };
        });
    }

    async copy(params = {}) {
        return operation('drive.files.copy', () => {
            const source = requireLiveFile(params.fileId);
            assertKnownKeys(params.requestBody ?? {}, new Set(['name', 'parents', 'description']), 'drive.files.copy');
            const body = params.requestBody ?? {};
            const parents = body.parents === undefined ? source.parents : body.parents;
            assertSandboxParents(parents, 'Offline Drive copy');
            const duplicate = makeFile({
                name: body.name ?? `Copy of ${source.name}`,
                mimeType: source.mimeType,
                parents,
                description: body.description ?? source.description,
            });
            if (source.document) {
                duplicate.document = {
                    ...clone(source.document),
                    tabId: duplicate.document.tabId,
                    revisionId: nextRevision(),
                    revisions: [],
                };
            }
            if (source.spreadsheet) duplicate.spreadsheet = clone(source.spreadsheet);
            return publicFile(duplicate);
        });
    }

    async update(params = {}) {
        return operation('drive.files.update', () => {
            const file = requireFile(params.fileId);
            const body = params.requestBody ?? {};
            assertKnownKeys(body, new Set(['name', 'description', 'trashed', 'parents']), 'drive.files.update');
            if (file.id === state.folderId) {
                throw apiError(403, 'Offline test root is immutable.', 'PERMISSION_DENIED');
            }
            if (params.addParents !== undefined || params.removeParents !== undefined) {
                const add = params.addParents ? String(params.addParents).split(',').filter(Boolean) : [];
                const remove = new Set(params.removeParents ? String(params.removeParents).split(',').filter(Boolean) : []);
                const parents = [...new Set([...file.parents.filter((id) => !remove.has(id)), ...add])];
                assertSandboxParents(parents, 'Offline Drive move');
                file.parents = parents;
            }
            if (body.parents !== undefined) {
                assertSandboxParents(body.parents, 'Offline Drive update');
                file.parents = [...body.parents];
            }
            if (body.name !== undefined) {
                if (typeof body.name !== 'string' || body.name.trim() === '') throw apiError(400, 'Offline Drive file name must be non-empty.', 'INVALID_ARGUMENT');
                file.name = body.name;
            }
            if (body.description !== undefined) file.description = String(body.description);
            if (body.trashed !== undefined) file.trashed = Boolean(body.trashed);
            touch(file);
            return publicFile(file);
        });
    }

    async delete(params = {}) {
        return operation('drive.files.delete', () => {
            const file = requireFile(params.fileId);
            if (file.id === state.folderId) throw apiError(403, 'Offline test root cannot be deleted.', 'PERMISSION_DENIED');
            if (!isInsideFolder(file.id)) throw apiError(403, 'Offline Drive delete refused outside the test folder.', 'PERMISSION_DENIED');
            state.files.delete(file.id);
            return {};
        });
    }

    async export(params = {}) {
        return operation('drive.files.export', () => {
            const file = ensureDocument(params.fileId);
            if (!['text/plain', 'text/markdown'].includes(params.mimeType)) {
                throw unsupported('drive.files.export', `does not support export MIME type "${params.mimeType}".`);
            }
            return file.document.text;
        });
    }

    async emptyTrash() {
        return operation('drive.files.emptyTrash', () => {
            for (const [id, file] of state.files) if (id !== state.folderId && file.trashed) state.files.delete(id);
            return {};
        });
    }
}

function filterDriveQuery(files, query) {
    const supported = /^(?:\(*\s*)?(?:(?:'[^']*'\s+in\s+parents)(?:\s+or\s+'[^']*'\s+in\s+parents)*|trashed\s*=\s*(?:true|false)|mimeType\s*(?:=|!=)\s*'[^']*'|name\s+contains\s+'[^']*'|fullText\s+contains\s+'[^']*')(?:\s*\)*\s*(?:and\s+(?:trashed\s*=\s*(?:true|false)|mimeType\s*(?:=|!=)\s*'[^']*'|name\s+contains\s+'[^']*'|fullText\s+contains\s+'[^']*')))*\s*$/i;
    if (!supported.test(query)) throw unsupported('drive.files.list', `does not support query "${query}".`);
    const parentIds = [...query.matchAll(/'([^']*)'\s+in\s+parents/gi)].map((match) => match[1].replace(/\\'/g, "'"));
    if (parentIds.length) files = files.filter((file) => parentIds.some((id) => file.parents.includes(id)));
    const trashed = /trashed\s*=\s*(true|false)/i.exec(query);
    if (trashed) files = files.filter((file) => file.trashed === (trashed[1].toLowerCase() === 'true'));
    const mime = /mimeType\s*(=|!=)\s*'([^']*)'/i.exec(query);
    if (mime) files = files.filter((file) => (mime[1] === '=' ? file.mimeType === mime[2] : file.mimeType !== mime[2]));
    const name = /name\s+contains\s+'([^']*)'/i.exec(query);
    if (name) files = files.filter((file) => file.name.includes(name[1]));
    const fullText = /fullText\s+contains\s+'([^']*)'/i.exec(query);
    if (fullText) files = files.filter((file) => `${file.name}\n${file.document?.text ?? ''}`.includes(fullText[1]));
    return files;
}

function compareDriveFiles(left, right, orderBy) {
    const descending = /\bdesc\b/i.test(orderBy);
    let result;
    if (/folder/i.test(orderBy) && left.mimeType !== right.mimeType) result = left.mimeType === FOLDER_MIME ? -1 : 1;
    else if (/modifiedTime/i.test(orderBy)) result = left.modifiedTime.localeCompare(right.modifiedTime);
    else if (/createdTime/i.test(orderBy)) result = left.createdTime.localeCompare(right.createdTime);
    else result = left.name.localeCompare(right.name);
    return descending ? -result : result;
}

class OfflineDocsDocuments {
    async get(params = {}) {
        return operation('docs.documents.get', () => {
            const file = ensureDocument(params.documentId);
            return documentResource(file, { includeTabsContent: Boolean(params.includeTabsContent) });
        });
    }

    async batchUpdate(params = {}) {
        return operation('docs.documents.batchUpdate', () => {
            const file = ensureDocument(params.documentId);
            const body = params.requestBody;
            assertObject(body, 'docs.documents.batchUpdate');
            assertKnownKeys(body, new Set(['requests', 'writeControl']), 'docs.documents.batchUpdate');
            if (!Array.isArray(body.requests) || body.requests.length === 0) {
                throw apiError(400, 'Offline Docs batchUpdate requires at least one request.', 'INVALID_ARGUMENT');
            }
            const expected = body.writeControl?.requiredRevisionId;
            if (expected !== undefined && expected !== file.document.revisionId) {
                throw apiError(409, 'Offline document revision changed since it was read.', 'FAILED_PRECONDITION');
            }
            // Google Docs batchUpdate is atomic. Validate and mutate a detached
            // document copy first so a later unsupported request cannot leave a
            // partial fake write behind.
            const staged = { ...file, document: clone(file.document) };
            for (const request of body.requests) applyDocumentRequest(staged, request);
            file.document = staged.document;
            file.document.revisions.push({ id: file.document.revisionId, modifiedTime: file.modifiedTime });
            file.document.revisionId = nextRevision();
            touch(file);
            return { documentId: file.id, replies: body.requests.map(() => ({})), writeControl: { requiredRevisionId: file.document.revisionId } };
        });
    }
}

class OfflineSheetsValues {
    async get(params = {}) {
        return operation('sheets.spreadsheets.values.get', () => {
            const file = ensureSpreadsheet(params.spreadsheetId);
            const { parsed, sheet } = resolveSheet(file, params.range);
            const values = [];
            for (let row = parsed.startRow; row <= parsed.endRow; row += 1) {
                values.push(Array.from({ length: parsed.endCol - parsed.startCol + 1 }, (_, offset) => sheet.values[row]?.[parsed.startCol + offset]));
            }
            return { range: `${sheet.properties.title}!${params.range.includes('!') ? params.range.split('!', 2)[1] : params.range}`, majorDimension: 'ROWS', values: trimValues(values) };
        });
    }

    async update(params = {}) {
        return operation('sheets.spreadsheets.values.update', () => {
            const file = ensureSpreadsheet(params.spreadsheetId);
            const body = params.requestBody;
            assertObject(body, 'sheets.spreadsheets.values.update');
            assertKnownKeys(body, new Set(['values']), 'sheets.spreadsheets.values.update');
            if (!Array.isArray(body.values) || body.values.some((row) => !Array.isArray(row))) {
                throw apiError(400, 'Offline Sheets update requires requestBody.values as a two-dimensional array.', 'INVALID_ARGUMENT');
            }
            const { parsed, sheet } = resolveSheet(file, params.range);
            body.values.forEach((row, rowOffset) => {
                const targetRow = parsed.startRow + rowOffset;
                if (!sheet.values[targetRow]) sheet.values[targetRow] = [];
                row.forEach((value, columnOffset) => { sheet.values[targetRow][parsed.startCol + columnOffset] = clone(value); });
            });
            touch(file);
            const updatedRows = body.values.length;
            const updatedColumns = body.values.reduce((maximum, row) => Math.max(maximum, row.length), 0);
            return { spreadsheetId: file.id, updatedRange: params.range, updatedRows, updatedColumns, updatedCells: body.values.reduce((total, row) => total + row.length, 0) };
        });
    }

    async append(params = {}) {
        return operation('sheets.spreadsheets.values.append', () => {
            const file = ensureSpreadsheet(params.spreadsheetId);
            const body = params.requestBody;
            assertObject(body, 'sheets.spreadsheets.values.append');
            if (!Array.isArray(body.values) || body.values.some((row) => !Array.isArray(row))) throw apiError(400, 'Offline Sheets append requires a two-dimensional values array.', 'INVALID_ARGUMENT');
            const { parsed, sheet } = resolveSheet(file, params.range);
            const firstOpenRow = Math.max(parsed.startRow, sheet.values.length);
            body.values.forEach((row, rowOffset) => {
                const targetRow = firstOpenRow + rowOffset;
                if (!sheet.values[targetRow]) sheet.values[targetRow] = [];
                row.forEach((value, columnOffset) => { sheet.values[targetRow][parsed.startCol + columnOffset] = clone(value); });
            });
            touch(file);
            return { tableRange: params.range, updates: { updatedRows: body.values.length, updatedCells: body.values.reduce((total, row) => total + row.length, 0) } };
        });
    }

    async clear(params = {}) {
        return operation('sheets.spreadsheets.values.clear', () => {
            const file = ensureSpreadsheet(params.spreadsheetId);
            const { parsed, sheet } = resolveSheet(file, params.range);
            for (let row = parsed.startRow; row <= parsed.endRow; row += 1) {
                if (!sheet.values[row]) continue;
                for (let column = parsed.startCol; column <= parsed.endCol; column += 1) sheet.values[row][column] = undefined;
            }
            touch(file);
            return { clearedRange: params.range };
        });
    }
}

class OfflineSheetsSpreadsheets {
    constructor() { this.values = new OfflineSheetsValues(); }

    async get(params = {}) {
        return operation('sheets.spreadsheets.get', () => {
            const file = ensureSpreadsheet(params.spreadsheetId);
            return {
                spreadsheetId: file.id,
                properties: { title: file.name },
                sheets: file.spreadsheet.sheets.map((sheet) => ({ properties: clone(sheet.properties) })),
            };
        });
    }

    async batchUpdate() {
        return operation('sheets.spreadsheets.batchUpdate', () => { throw unsupported('sheets.spreadsheets.batchUpdate', 'does not support formatting or sheet-structure changes.'); });
    }

    async create() {
        return operation('sheets.spreadsheets.create', () => { throw unsupported('sheets.spreadsheets.create', 'use the production createSpreadsheet tool with parentFolderId so the offline sandbox can enforce confinement.'); });
    }
}

class OfflineDriveClient {
    constructor() {
        this.files = new OfflineDriveFiles();
        this.about = { get: async () => operation('drive.about.get', () => ({ user: { displayName: 'Offline Tester', emailAddress: 'offline-tester@example.invalid' } })) };
        this.revisions = {
            list: async ({ fileId } = {}) => operation('drive.revisions.list', () => {
                const file = ensureDocument(fileId);
                return { revisions: [...file.document.revisions, { id: file.document.revisionId, modifiedTime: file.modifiedTime }].map(clone) };
            }),
            get: async ({ fileId, revisionId } = {}) => operation('drive.revisions.get', () => {
                const file = ensureDocument(fileId);
                const revision = [...file.document.revisions, { id: file.document.revisionId, modifiedTime: file.modifiedTime }].find((entry) => entry.id === revisionId);
                if (!revision) throw apiError(404, `Offline revision ${revisionId} was not found.`, 'NOT_FOUND');
                return revision;
            }),
        };
        this.permissions = unimplementedResource('drive.permissions');
        this.comments = unimplementedResource('drive.comments');
        this.replies = unimplementedResource('drive.replies');
        this.drives = unimplementedResource('drive.drives');
    }
}

class OfflineDocsClient {
    constructor() { this.documents = new OfflineDocsDocuments(); }
}

class OfflineSheetsClient {
    constructor() { this.spreadsheets = new OfflineSheetsSpreadsheets(); }
}

class OfflineGmailClient {
    constructor() {
        this.users = {
            getProfile: async () => operation('gmail.users.getProfile', () => ({ emailAddress: 'offline-tester@example.invalid', messagesTotal: 0, threadsTotal: 0, historyId: 'offline-history-0' })),
            messages: unimplementedResource('gmail.users.messages'),
            drafts: unimplementedResource('gmail.users.drafts'),
            labels: unimplementedResource('gmail.users.labels'),
            threads: unimplementedResource('gmail.users.threads'),
            settings: unimplementedResource('gmail.users.settings'),
        };
    }
}

export function configureOfflineBackend({ folderId, workspaceDir }) {
    if (state) return;
    const startedAt = Date.now();
    state = {
        folderId,
        workspaceDir,
        startedAt,
        clock: 0,
        sequence: 0,
        revisionSequence: 0,
        files: new Map(),
        counters: { calls: 0, errors: 0, unsupported: 0, byMethod: {} },
        lastError: null,
        lastUnsupported: null,
    };
    makeFile({ id: folderId, name: 'Offline agent test root', mimeType: FOLDER_MIME, parents: [] });
    clients = {
        docs: new OfflineDocsClient(),
        drive: new OfflineDriveClient(),
        sheets: new OfflineSheetsClient(),
        gmail: new OfflineGmailClient(),
        calendar: unimplementedResource('calendar'),
        forms: unimplementedResource('forms'),
        slides: unimplementedResource('slides'),
        tasks: unimplementedResource('tasks'),
        script: unimplementedResource('script'),
        auth: { offline: true, getAccessToken: async () => ({ token: 'offline' }) },
    };
}

export function getOfflineBackendStatus() {
    if (!state) return {
        configured: false,
        counters: { calls: 0, errors: 0, unsupported: 0, byMethod: {} },
        lastError: null,
        lastUnsupported: null,
    };
    const activeFileIds = [...state.files.values()]
        .filter((file) => !file.trashed)
        .map((file) => file.id)
        .sort();
    return clone({
        configured: true,
        folderId: state.folderId,
        workspaceDir: state.workspaceDir,
        activeFileIds,
        resourceCount: Math.max(0, activeFileIds.length - 1),
        counters: state.counters,
        lastError: state.lastError,
        lastUnsupported: state.lastUnsupported,
    });
}

function getClients() {
    if (!clients) throw new Error('Offline backend is not configured. Call installOfflineBackend before importing dist modules.');
    return clients;
}

export async function initializeGoogleClient() {
    const current = getClients();
    return { authClient: current.auth, googleDocs: current.docs, googleDrive: current.drive, googleSheets: current.sheets, googleScript: current.script };
}
export async function initializeGmailClient() { const current = getClients(); return { authClient: current.auth, gmailClient: current.gmail }; }
export async function initializeCalendarClient() { const current = getClients(); return { authClient: current.auth, calendarClient: current.calendar }; }
export async function initializeFormsClient() { const current = getClients(); return { authClient: current.auth, formsClient: current.forms }; }
export async function initializeSlidesClient() { const current = getClients(); return { authClient: current.auth, slidesClient: current.slides }; }
export async function initializeTasksClient() { const current = getClients(); return { authClient: current.auth, tasksClient: current.tasks }; }
export function getAuthClientIfReady() { return clients?.auth ?? null; }
export function resetClients() { /* Offline state intentionally remains stable for one installed process. */ }
export async function withAuthRetry(fn) { return fn(); }
export async function getDocsClient() { return getClients().docs; }
export async function getDriveClient() { return getClients().drive; }
export async function getSheetsClient() { return getClients().sheets; }
export async function getAuthClient() { return getClients().auth; }
export async function getScriptClient() { return getClients().script; }
export async function getGmailClient() { return getClients().gmail; }
export async function getCalendarClient() { return getClients().calendar; }
export async function getFormsClient() { return getClients().forms; }
export async function getSlidesClient() { return getClients().slides; }
export async function getTasksClient() { return getClients().tasks; }
