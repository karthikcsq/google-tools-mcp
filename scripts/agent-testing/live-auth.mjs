import * as fs from 'node:fs/promises';
import { publicError } from '../../dist/errors.js';
import { OAuth2Client } from 'google-auth-library';
import { getTokenPath, loadClientSecrets, SCOPES } from '../../dist/auth.js?agent-test-read-only';
export * from '../../dist/auth.js?agent-test-read-only';

const REFUSAL = 'Live agent-test requires usable saved OAuth credentials. Repair authentication outside the test broker; shared credentials were not changed.';

export async function authorize() {
    try {
        const tokenPath = getTokenPath();
        const stat = await fs.lstat(tokenPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe token');
        const saved = JSON.parse(await fs.readFile(tokenPath, 'utf8'));
        if (saved.type !== 'authorized_user' || typeof saved.refresh_token !== 'string' || !saved.refresh_token.trim()
            || !Array.isArray(saved.scopes) || SCOPES.some((scope) => !saved.scopes.includes(scope))) {
            throw new Error('unusable token');
        }
        const { client_id, client_secret } = await loadClientSecrets();
        const client = new OAuth2Client(client_id, client_secret);
        client.setCredentials({ refresh_token: saved.refresh_token });
        const { credentials } = await client.refreshAccessToken();
        if (!credentials?.access_token || !Number.isFinite(credentials.expiry_date) || credentials.expiry_date <= Date.now()) {
            throw new Error('unusable refresh result');
        }
        client.setCredentials({ ...credentials, refresh_token: credentials.refresh_token || saved.refresh_token });
        // No persistence listener, token unlink, or interactive fallback.
        return client;
    } catch {
        throw publicError(REFUSAL);
    }
}

export async function runAuthFlow() { throw publicError(REFUSAL); }
