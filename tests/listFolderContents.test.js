import { describe, expect, it, jest } from '@jest/globals';

let fakeDrive;
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDriveClient: async () => fakeDrive,
}));

const { register } = await import('../dist/tools/drive/listFolderContents.js');

function getTool() {
    let tool;
    register({ addTool(definition) { tool = definition; } });
    return tool;
}

const noopLog = { info() {}, error() {}, warn() {}, debug() {} };
const folder = (id, name, parents) => ({ id, name, mimeType: 'application/vnd.google-apps.folder', parents, modifiedTime: '2026-08-21T00:00:00Z' });
const file = (id, name, parents) => ({ id, name, mimeType: 'text/plain', parents, modifiedTime: '2026-08-21T00:00:00Z', size: '12' });

describe('listFolderContents recursive traversal', () => {
    it('keeps the omitted-depth request and {folders, files} response byte-for-byte compatible', async () => {
        const list = jest.fn(async () => ({ data: { files: [
            { id: 'child', name: 'Child', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01' },
            { id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' },
        ] } }));
        fakeDrive = { files: { list, get: jest.fn() } };

        const result = await getTool().execute({ folderId: "ro'ot", includeSubfolders: true, includeFiles: true, maxResults: 50, depth: 1 }, { log: noopLog });

        expect(result).toBe(JSON.stringify({
            folders: [{ id: 'child', name: 'Child', modifiedTime: '2026-01-01' }],
            files: [{ id: 'note', name: 'note.txt', mimeType: 'text/plain', modifiedTime: '2026-01-02' }],
        }, null, 2));
        expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: "'ro\\'ot' in parents and trashed=false", pageSize: 50 }));
    });

    it('validates recursive parameter combinations and boundaries', () => {
        const parameters = getTool().parameters;
        expect(parameters.safeParse({ folderId: 'x', depth: 0 }).success).toBe(false);
        expect(parameters.safeParse({ folderId: 'x', depth: 11 }).success).toBe(false);
        expect(parameters.safeParse({ folderId: 'x', depth: 1.5 }).success).toBe(false);
        expect(parameters.safeParse({ folderId: 'x', depth: 'all' }).success).toBe(true);
        expect(parameters.safeParse({ folderId: 'x', depth: 1, maxItems: 2 }).success).toBe(false);
        expect(parameters.safeParse({ folderId: 'x', depth: 2, includeSubfolders: false }).success).toBe(false);
        expect(parameters.safeParse({ folderId: 'x', depth: 2, maxItems: 5001 }).success).toBe(false);
    });

    it('lists depth two with one batched child query and reconstructable paths', async () => {
        const list = jest.fn(async ({ q }) => {
            if (q.includes("'root-id'")) return { data: { files: [folder('a', 'A', ['root-id']), folder('b', 'B', ['root-id']), folder('c', 'C', ['root-id'])] } };
            return { data: { files: [file('a-file', 'a.txt', ['a']), file('b-file', 'b.txt', ['b']), file('c-file', 'c.txt', ['c'])] } };
        });
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'My Drive' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 2, includeSubfolders: true, includeFiles: true }, { log: noopLog }));

        expect(result.apiCalls).toBe(3);
        expect(list).toHaveBeenCalledTimes(2);
        expect(list.mock.calls[1][0].q).toContain("'a' in parents or 'b' in parents or 'c' in parents");
        expect(result.entries.find((entry) => entry.id === 'b-file')).toMatchObject({ path: 'My Drive/B/b.txt', parentIds: ['b'], size: '12' });
        expect(result.truncated).toBe(false);
    });

    it('terminates depth all for multi-parent folders and upward shortcuts', async () => {
        const list = jest.fn(async ({ q }) => {
            if (q.includes("'root-id'")) return { data: { files: [folder('a', 'A', ['root-id']), folder('b', 'B', ['root-id'])] } };
            if (q.includes("'a' in parents") || q.includes("'b' in parents")) return { data: { files: [
                folder('c', 'C', ['a', 'b']),
                { id: 'up', name: 'Up', mimeType: 'application/vnd.google-apps.shortcut', parents: ['a'], shortcutDetails: { targetId: 'root-id' } },
            ] } };
            return { data: { files: [folder('a', 'A', ['c'])] } };
        });
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 'all' }, { log: noopLog }));

        expect(result.entries.filter((entry) => entry.id === 'a')).toHaveLength(1);
        expect(result.entries.find((entry) => entry.id === 'a').parentIds).toEqual(['root-id', 'c']);
        expect(result.entries.find((entry) => entry.id === 'c').parentIds).toEqual(['a', 'b']);
        expect(result.entries.find((entry) => entry.id === 'up').shortcutDetails).toEqual({ targetId: 'root-id' });
        expect(list).toHaveBeenCalledTimes(3);
    });

    it('reports maxItems truncation instead of silently returning a partial tree', async () => {
        const list = jest.fn(async () => ({ data: { files: [folder('a', 'A', ['root-id']), file('f', 'f.txt', ['root-id'])] } }));
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 'all', maxItems: 1 }, { log: noopLog }));

        expect(result).toMatchObject({ count: 1, truncated: true });
        expect(result.truncationReason).toMatch(/maxItems \(1\).*discovered folders not expanded/);
    });

    it('reports API-budget truncation after bounding a deep traversal', async () => {
        const list = jest.fn(async ({ q }) => {
            const parentId = q.match(/'([^']+)' in parents/)?.[1];
            return { data: { files: [folder(`child-of-${parentId}`, 'Child', [parentId])] } };
        });
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 'all' }, { log: noopLog }));

        expect(result).toMatchObject({ truncated: true, truncationReason: 'API call budget (50) exhausted', apiCalls: 50 });
        expect(list).toHaveBeenCalledTimes(49);
    });

    it('isolates an unreadable subfolder without losing readable siblings', async () => {
        const list = jest.fn(async ({ q }) => {
            if (q.includes("'root-id'")) return { data: { files: [folder('a', 'A', ['root-id']), folder('b', 'B', ['root-id'])] } };
            if (q.includes("'a' in parents") && q.includes("'b' in parents")) { const error = new Error('forbidden'); error.code = 403; throw error; }
            if (q.includes("'b' in parents")) { const error = new Error('forbidden'); error.code = 403; throw error; }
            return { data: { files: [file('a-file', 'a.txt', ['a'])] } };
        });
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 'all' }, { log: noopLog }));

        expect(result.entries.some((entry) => entry.id === 'a-file')).toBe(true);
        expect(result.unreadable).toEqual([{ id: 'b', path: 'Root/B', reason: 'Permission denied or folder unavailable.' }]);
    });

    it('fully paginates a level before descending and deduplicates page overlap', async () => {
        const calls = [];
        const list = jest.fn(async ({ q, pageToken }) => {
            calls.push({ q, pageToken });
            if (q.includes("'root-id'") && !pageToken) return { data: { files: [folder('a', 'A', ['root-id'])], nextPageToken: 'second' } };
            if (q.includes("'root-id'")) return { data: { files: [folder('a', 'A', ['root-id']), file('root-file', 'root.txt', ['root-id'])] } };
            return { data: { files: [] } };
        });
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 'all' }, { log: noopLog }));

        expect(calls.map((call) => call.pageToken)).toEqual([undefined, 'second', undefined]);
        expect(result.entries.map((entry) => entry.id)).toEqual(['a', 'root-file']);
    });

    it('omits files when requested but still descends through folders', async () => {
        const list = jest.fn(async ({ q }) => q.includes("'root-id'")
            ? ({ data: { files: [folder('a', 'A', ['root-id']), file('root-file', 'root.txt', ['root-id'])] } })
            : ({ data: { files: [file('nested-file', 'nested.txt', ['a'])] } }));
        fakeDrive = { files: { get: jest.fn(async () => ({ data: { id: 'root-id', name: 'Root' } })), list } };

        const result = JSON.parse(await getTool().execute({ folderId: 'root', depth: 2, includeFiles: false }, { log: noopLog }));

        expect(result.entries.map((entry) => entry.id)).toEqual(['a']);
        expect(list).toHaveBeenCalledTimes(2);
    });
});
