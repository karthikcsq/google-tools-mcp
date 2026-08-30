import { describe, expect, it, jest } from '@jest/globals';

let fakeDrive;
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDriveClient: async () => fakeDrive,
}));

const { register: registerList } = await import('../dist/tools/drive/listPermissions.js');
const { register: registerAdd } = await import('../dist/tools/drive/addPermission.js');
const { register: registerUpdate } = await import('../dist/tools/drive/updatePermission.js');
const { register: registerRemove } = await import('../dist/tools/drive/removePermission.js');

function getTool(register) {
    let tool;
    register({ addTool(definition) { tool = definition; } });
    return tool;
}

const log = { info() {}, warn() {}, error() {}, debug() {} };
const permissionFields = 'id,type,role,emailAddress,domain,displayName,allowFileDiscovery,pendingOwner';

function setDrive(overrides = {}) {
    fakeDrive = {
        permissions: {
            list: jest.fn(async () => ({ data: { permissions: [] } })),
            create: jest.fn(async () => ({ data: { id: 'permission-1', type: 'user', role: 'reader' } })),
            update: jest.fn(async () => ({ data: { id: 'permission-1', type: 'user', role: 'writer' } })),
            delete: jest.fn(async () => ({})),
            ...overrides,
        },
    };
}

describe('Drive permission tools', () => {
    it('lists permissions with the complete field mask, normalized defaults, and shared-drive support', async () => {
        setDrive({ list: jest.fn(async () => ({ data: { permissions: [{ id: 'permission-1', type: 'user', role: 'reader' }] } })) });
        const result = JSON.parse(await getTool(registerList).execute({ fileId: 'file-1' }, { log }));

        expect(fakeDrive.permissions.list).toHaveBeenCalledWith({
            fileId: 'file-1',
            fields: 'permissions(id,type,role,emailAddress,domain,displayName,allowFileDiscovery,deleted,pendingOwner)',
            supportsAllDrives: true,
        });
        expect(result).toEqual({ fileId: 'file-1', permissions: [{
            id: 'permission-1', type: 'user', role: 'reader', emailAddress: null,
            domain: null, displayName: null, allowFileDiscovery: null, deleted: false, pendingOwner: false,
        }] });
    });

    it('maps user and group emails, preserves roles, and defaults notifications on', async () => {
        setDrive();
        const tool = getTool(registerAdd);
        await tool.execute({ fileId: 'file-1', type: 'user', role: 'writer', emailAddress: 'user@example.com' }, { log });
        await tool.execute({ fileId: 'file-1', type: 'group', role: 'commenter', emailAddress: 'group@example.com' }, { log });

        expect(fakeDrive.permissions.create.mock.calls[0][0]).toMatchObject({
            fileId: 'file-1', requestBody: { type: 'user', role: 'writer', emailAddress: 'user@example.com' },
            sendNotificationEmail: true, supportsAllDrives: true, fields: permissionFields,
        });
        expect(fakeDrive.permissions.create.mock.calls[1][0].requestBody).toEqual({ type: 'group', role: 'commenter', emailAddress: 'group@example.com' });
        await expect(tool.execute({ fileId: 'file-1', type: 'user', role: 'reader' }, { log })).rejects.toThrow("emailAddress is required");
    });

    it('maps domain and anyone sharing without silently changing discovery or notification settings', async () => {
        setDrive();
        const tool = getTool(registerAdd);
        await tool.execute({ fileId: 'file-1', type: 'domain', role: 'reader', domain: 'example.com' }, { log });
        await tool.execute({ fileId: 'file-1', type: 'anyone', role: 'reader', allowFileDiscovery: false, emailMessage: 'ignore me' }, { log });
        await tool.execute({ fileId: 'file-1', type: 'anyone', role: 'reader', allowFileDiscovery: true }, { log });

        expect(fakeDrive.permissions.create.mock.calls[0][0]).toMatchObject({ requestBody: { type: 'domain', role: 'reader', domain: 'example.com' }, sendNotificationEmail: false });
        expect(fakeDrive.permissions.create.mock.calls[0][0].requestBody).not.toHaveProperty('allowFileDiscovery');
        expect(fakeDrive.permissions.create.mock.calls[1][0]).toMatchObject({ requestBody: { type: 'anyone', role: 'reader', allowFileDiscovery: false }, sendNotificationEmail: false, emailMessage: undefined });
        expect(fakeDrive.permissions.create.mock.calls[2][0].requestBody).toEqual({ type: 'anyone', role: 'reader', allowFileDiscovery: true });
        await expect(tool.execute({ fileId: 'file-1', type: 'domain', role: 'reader' }, { log })).rejects.toThrow("domain is required");
    });

    it('requires explicit ownership transfer and forwards it unchanged for add and update', async () => {
        setDrive();
        const add = getTool(registerAdd);
        const update = getTool(registerUpdate);
        await expect(add.execute({ fileId: 'file-1', type: 'user', role: 'owner', emailAddress: 'new-owner@example.com' }, { log })).rejects.toThrow('requires transferOwnership=true');
        await add.execute({ fileId: 'file-1', type: 'user', role: 'owner', emailAddress: 'new-owner@example.com', transferOwnership: true }, { log });
        await expect(update.execute({ fileId: 'file-1', permissionId: 'permission-owner', role: 'owner' }, { log })).rejects.toThrow('requires transferOwnership=true');
        await update.execute({ fileId: 'file-1', permissionId: 'permission-owner', role: 'owner', transferOwnership: true }, { log });

        expect(fakeDrive.permissions.create.mock.calls[0][0]).toMatchObject({ transferOwnership: true, requestBody: { role: 'owner' } });
        expect(fakeDrive.permissions.update.mock.calls[0][0]).toMatchObject({ permissionId: 'permission-owner', requestBody: { role: 'owner' }, transferOwnership: true, supportsAllDrives: true });
    });

    it('updates and removes exactly the requested permission ID with shared-drive support', async () => {
        setDrive();
        await getTool(registerUpdate).execute({ fileId: 'file-1', permissionId: 'permission-42', role: 'writer' }, { log });
        const removeResult = JSON.parse(await getTool(registerRemove).execute({ fileId: 'file-1', permissionId: 'permission-42' }, { log }));

        expect(fakeDrive.permissions.update).toHaveBeenCalledWith({
            fileId: 'file-1', permissionId: 'permission-42', requestBody: { role: 'writer' }, transferOwnership: undefined,
            supportsAllDrives: true, fields: permissionFields,
        });
        expect(fakeDrive.permissions.delete).toHaveBeenCalledWith({ fileId: 'file-1', permissionId: 'permission-42', supportsAllDrives: true });
        expect(removeResult).toEqual({ fileId: 'file-1', permissionId: 'permission-42', removed: true });
    });

    it('propagates a 403 as an error instead of returning success for every permission operation', async () => {
        const forbidden = Object.assign(new Error('forbidden'), { code: 403 });
        setDrive({
            list: jest.fn(async () => { throw forbidden; }),
            create: jest.fn(async () => { throw forbidden; }),
            update: jest.fn(async () => { throw forbidden; }),
            delete: jest.fn(async () => { throw forbidden; }),
        });

        await expect(getTool(registerList).execute({ fileId: 'file-1' }, { log })).rejects.toThrow('Permission denied');
        await expect(getTool(registerAdd).execute({ fileId: 'file-1', type: 'anyone', role: 'reader' }, { log })).rejects.toThrow('Permission denied');
        await expect(getTool(registerUpdate).execute({ fileId: 'file-1', permissionId: 'permission-1', role: 'reader' }, { log })).rejects.toThrow('Permission denied');
        await expect(getTool(registerRemove).execute({ fileId: 'file-1', permissionId: 'permission-1' }, { log })).rejects.toThrow('Permission denied');
    });
});
