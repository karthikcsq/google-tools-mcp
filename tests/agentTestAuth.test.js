import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import childProcess from 'node:child_process';

let tokenPath;
let temporary;
let refresh;
const originalConfig = process.env.XDG_CONFIG_HOME;
const originalProfile = process.env.GOOGLE_MCP_PROFILE;
const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-readonly-auth-'));
process.env.XDG_CONFIG_HOME = configRoot;
delete process.env.GOOGLE_MCP_PROFILE;
jest.unstable_mockModule('google-auth-library', () => ({
    JWT: class {},
    OAuth2Client: class {
        setCredentials(value) { this.credentials = value; }
        async refreshAccessToken() { return refresh(); }
    },
}));
const { authorize, runAuthFlow } = await import('../scripts/agent-testing/live-auth.mjs');
const { getTokenPath, SCOPES } = await import('../dist/auth.js');
if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalConfig;
if (originalProfile === undefined) delete process.env.GOOGLE_MCP_PROFILE; else process.env.GOOGLE_MCP_PROFILE = originalProfile;
let serverSpy;
let browserSpy;
beforeEach(async () => {
    temporary = configRoot;
    tokenPath = getTokenPath();
    await fs.mkdir(path.dirname(tokenPath), { recursive: true });
    process.env.GOOGLE_CLIENT_ID = 'test-client';
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
    refresh = jest.fn().mockResolvedValue({ credentials: { access_token: 'test-access', expiry_date: Date.now() + 60_000 } });
    serverSpy = jest.spyOn(http, 'createServer').mockImplementation(() => { throw new Error('OAuth callback must not start'); });
    browserSpy = jest.spyOn(childProcess, 'execFile').mockImplementation(() => { throw new Error('Browser must not start'); });
});
afterEach(async () => {
    expect(serverSpy).not.toHaveBeenCalled();
    expect(browserSpy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    await fs.rm(temporary, { recursive: true, force: true });
});
const valid = () => ({ type: 'authorized_user', refresh_token: 'saved-refresh', scopes: [...SCOPES] });
async function preserveAcrossFailure(contents) {
    await fs.writeFile(tokenPath, contents);
    const before = await fs.stat(tokenPath);
    await expect(authorize()).rejects.toThrow('shared credentials were not changed');
    expect(await fs.readFile(tokenPath, 'utf8')).toBe(contents);
    expect((await fs.stat(tokenPath)).mtimeMs).toBe(before.mtimeMs);
}
describe('live agent-test read-only authentication', () => {
    test.each(['malformed', 'missing-scopes', 'missing-refresh', 'wrong-type'])('rejects %s without credential or browser side effects', async (kind) => {
        const saved = valid();
        if (kind === 'missing-scopes') delete saved.scopes;
        if (kind === 'missing-refresh') delete saved.refresh_token;
        if (kind === 'wrong-type') saved.type = 'service_account';
        await preserveAcrossFailure(kind === 'malformed' ? '{broken' : JSON.stringify(saved));
        expect(refresh).not.toHaveBeenCalled();
    });
    test('rejects a revoked token without deleting or rewriting it', async () => {
        refresh.mockRejectedValue(Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } }));
        await preserveAcrossFailure(JSON.stringify(valid()));
        expect(refresh).toHaveBeenCalledTimes(1);
    });
    test('rejects an expired refresh result without changing the saved token', async () => {
        refresh.mockResolvedValue({ credentials: { access_token: 'expired', expiry_date: Date.now() - 1 } });
        await preserveAcrossFailure(JSON.stringify(valid()));
    });
    test('uses refreshed credentials in memory without persisting a rotated token', async () => {
        const contents = JSON.stringify(valid());
        await fs.writeFile(tokenPath, contents);
        refresh.mockResolvedValue({ credentials: { access_token: 'new-access', refresh_token: 'rotated', expiry_date: Date.now() + 60_000 } });
        const client = await authorize();
        expect(client.credentials.refresh_token).toBe('rotated');
        expect(await fs.readFile(tokenPath, 'utf8')).toBe(contents);
        await expect(runAuthFlow()).rejects.toThrow('outside the test broker');
    });
});
