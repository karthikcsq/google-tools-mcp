// Combined auth for google-tools-mcp.
// Merges GDrive + Gmail scopes into a single OAuth flow.
// Config dir: ~/.config/google-tools-mcp/ (with GOOGLE_MCP_PROFILE subdirs).
// `google.auth.OAuth2` was only ever OAuth2Client re-exported from
// google-auth-library, which is already a direct dependency, so this file needs
// no scoped API package at all (#71).
import { JWT, OAuth2Client } from 'google-auth-library';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { getConfigDir, loadConfigFiles } from './config.js';
import { openBrowser as openBrowserSafely } from './shellSafe.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRootDir = path.resolve(__dirname, '..');
const cwd = process.cwd();
const CREDENTIALS_PATH = path.join(projectRootDir, 'credentials.json');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
function getTokenPath() {
    return path.join(getConfigDir(), 'token.json');
}

// ---------------------------------------------------------------------------
// Scopes (GDrive + Gmail combined)
// ---------------------------------------------------------------------------
const SCOPES = [
    // GDrive / Docs / Sheets
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/script.external_request',
    // Gmail
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.settings.basic',
    'https://www.googleapis.com/auth/gmail.settings.sharing',
    // Calendar
    'https://www.googleapis.com/auth/calendar',
    // Forms
    'https://www.googleapis.com/auth/forms.body',
    'https://www.googleapis.com/auth/forms.body.readonly',
    'https://www.googleapis.com/auth/forms.responses.readonly',
    // Slides
    'https://www.googleapis.com/auth/presentations',
    // Tasks
    'https://www.googleapis.com/auth/tasks',
    // Service Usage — lets the setup wizard programmatically enable the APIs above
    // in the user's own project (Service Usage API itself is enabled by default).
    'https://www.googleapis.com/auth/service.management',
];

// ---------------------------------------------------------------------------
// Client secrets resolution
// ---------------------------------------------------------------------------
export async function loadClientSecrets() {
    loadConfigFiles();
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
        return { client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET };
    }
    const configDir = getConfigDir();
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
        logger.info('Loaded client credentials from .env file.');
        return { client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET };
    }
    const credentialsPaths = [
        path.join(configDir, 'credentials.json'),
        path.join(cwd, 'credentials.json'),
        CREDENTIALS_PATH,
    ];
    for (const credPath of credentialsPaths) {
        try {
            const content = await fs.readFile(credPath, 'utf8');
            const keys = JSON.parse(content);
            const key = keys.installed || keys.web;
            if (key) {
                logger.info('Loaded client credentials from', credPath);
                return { client_id: key.client_id, client_secret: key.client_secret };
            }
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
    }
    const configDirDisplay = configDir.replace(os.homedir(), '~');
    throw new Error(
        'No OAuth credentials found. Provide them in any of these ways:\n' +
        `  1. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars in your MCP config\n` +
        `  2. Create a .env file with GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in ${configDirDisplay}/ or your project directory\n` +
        `  3. Place your credentials.json (from Google Cloud Console) in ${configDirDisplay}/ or your project directory`
    );
}

// ---------------------------------------------------------------------------
// Service account auth
// ---------------------------------------------------------------------------
async function authorizeWithServiceAccount() {
    const serviceAccountPath = process.env.SERVICE_ACCOUNT_PATH;
    const impersonateUser = process.env.GOOGLE_IMPERSONATE_USER;
    try {
        const keyFileContent = await fs.readFile(serviceAccountPath, 'utf8');
        const serviceAccountKey = JSON.parse(keyFileContent);
        const auth = new JWT({
            email: serviceAccountKey.client_email,
            key: serviceAccountKey.private_key,
            scopes: SCOPES,
            subject: impersonateUser,
        });
        await auth.authorize();
        if (impersonateUser) {
            logger.info(`Service Account authentication successful, impersonating: ${impersonateUser}`);
        } else {
            logger.info('Service Account authentication successful!');
        }
        return auth;
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.error(`FATAL: Service account key file not found at path: ${serviceAccountPath}`);
            throw new Error('Service account key file not found. Please check the path in SERVICE_ACCOUNT_PATH.');
        }
        logger.error('FATAL: Error loading or authorizing the service account key:', error.message);
        throw new Error('Failed to authorize using the service account.');
    }
}

// ---------------------------------------------------------------------------
// Token persistence
// ---------------------------------------------------------------------------
async function loadSavedCredentialsIfExist() {
    try {
        const tokenPath = getTokenPath();
        const content = await fs.readFile(tokenPath, 'utf8');
        const credentials = JSON.parse(content);

        // Check that the saved token covers all current SCOPES.
        // Tokens without a scopes field (pre-upgrade) or with missing scopes
        // are stale — delete and force re-auth via browser automatically.
        if (!Array.isArray(credentials.scopes)) {
            logger.info('Saved token has no scopes record (pre-upgrade token). Re-authentication required for new scopes.');
            try { await fs.unlink(tokenPath); } catch {}
            return null;
        }
        const saved = new Set(credentials.scopes);
        const missing = SCOPES.filter(s => !saved.has(s));
        if (missing.length > 0) {
            logger.info(`Saved token is missing scope(s): ${missing.join(', ')}. Re-authentication required.`);
            try { await fs.unlink(tokenPath); } catch {}
            return null;
        }

        const { client_secret, client_id } = await loadClientSecrets();
        const client = new OAuth2Client(client_id, client_secret);
        client.setCredentials(credentials);
        return client;
    } catch {
        return null;
    }
}

async function saveCredentials(client) {
    const { client_secret, client_id } = await loadClientSecrets();
    const tokenPath = await persistTokenCredentials({ clientId: client_id, clientSecret: client_secret,
        refreshToken: client.credentials.refresh_token });
    logger.info('Token stored to', tokenPath);
}

export async function persistTokenCredentials({ clientId, clientSecret, refreshToken, scopes = SCOPES }, {
    configDir = getConfigDir(), mkdir = fs.mkdir, chmod = fs.chmod, open = fs.open,
    rename = fs.rename, unlink = fs.unlink,
} = {}) {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await chmod(configDir, 0o700);
    const tokenPath = path.join(configDir, 'token.json');
    const payload = JSON.stringify({
        type: 'authorized_user', client_id: clientId, client_secret: clientSecret,
        refresh_token: refreshToken, scopes,
    }, null, 2);
    const temporary = `${tokenPath}.tmp-${process.pid}-${Date.now()}`;
    let handle;
    try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temporary, tokenPath);
        await chmod(tokenPath, 0o600);
    } finally {
        await handle?.close().catch(() => {});
        await unlink(temporary).catch(() => {});
    }
    return tokenPath;
}

// ---------------------------------------------------------------------------
// Interactive OAuth browser flow
// ---------------------------------------------------------------------------
function getOAuthCallbackPort() {
    const configured = process.env.GOOGLE_MCP_OAUTH_PORT;
    if (configured === undefined || configured === '') return 0;

    if (!/^\d+$/.test(configured)) {
        throw new Error('GOOGLE_MCP_OAUTH_PORT must be an integer from 1 through 65535.');
    }
    const port = Number(configured);
    if (port < 1 || port > 65535) {
        throw new Error('GOOGLE_MCP_OAUTH_PORT must be an integer from 1 through 65535.');
    }
    return port;
}

// RFC 7636 PKCE. Generated here rather than through the library's
// generateCodeVerifierAsync so the pair is plain data the callback handler can
// close over without holding a client reference, and so the unit tests that
// mock google-auth-library do not have to reimplement it.
function createPkcePair() {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

/** Constant-time compare of the `state` we issued against the one that came back. */
function stateMatches(expected, received) {
    if (typeof received !== 'string') return false;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(received, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
}

async function authenticate() {
    const { client_secret, client_id } = await loadClientSecrets();
    const server = http.createServer();
    const requestedPort = getOAuthCallbackPort();
    // `server.listen` reports failure by emitting 'error', never by throwing or
    // by skipping the callback. A resolve-only Promise therefore never settles
    // when the configured port is taken: authenticate() hangs for the life of
    // the process, the EADDRINUSE reaches the process-level handler in
    // index.js which only logs it, and the `port_in_use` remedy that
    // clients.js already knows how to render is unreachable. Reject instead,
    // the way startV2HttpServer in mcpServer.js already does.
    await new Promise((resolve, reject) => {
        const onError = (error) => {
            server.close();
            if (error?.code !== 'EADDRINUSE') {
                reject(error);
                return;
            }
            // Keep `code` on the rethrown error so classifyAuthFailure in
            // clients.js still maps it to the port_in_use guidance.
            const conflict = new Error(
                `The OAuth callback port ${requestedPort} is already in use, so the browser `
                + 'authorization flow could not start. Free that port, or set '
                + 'GOOGLE_MCP_OAUTH_PORT to a different port, or unset it to use an ephemeral one.'
            );
            conflict.code = 'EADDRINUSE';
            reject(conflict);
        };
        server.once('error', onError);
        server.listen(requestedPort, 'localhost', () => {
            server.removeListener('error', onError);
            resolve();
        });
    });
    const port = server.address().port;
    const redirectUri = `http://localhost:${port}`;
    const oAuth2Client = new OAuth2Client(client_id, client_secret, redirectUri);
    const state = randomBytes(32).toString('base64url');
    const pkce = createPkcePair();
    const authorizeUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES.join(' '),
        // The redirect lands on a loopback server that, without this, accepts
        // whatever arrives carrying a `code`. Any page the user visits during
        // the five-minute window can point the browser at
        // http://localhost:<port>/?code=<an attacker's code>; the exchange
        // below then succeeds and persists the ATTACKER's refresh token, so
        // every later tool call operates on someone else's Google account
        // while looking completely normal. Google's OAuth guidance calls for a
        // unique, non-guessable state validated on return, which is what the
        // request handler below does:
        // https://developers.google.com/identity/protocols/oauth2/resources/best-practices
        state,
        // PKCE (RFC 7636) covers the other direction: an authorization code
        // observed on the loopback redirect is useless to anyone else, because
        // the verifier never leaves this process. Passed as the literal 'S256'
        // rather than google-auth-library's CodeChallengeMethod enum so the
        // suites that mock that module do not have to export one more name.
        code_challenge_method: 'S256',
        code_challenge: pkce.challenge,
        // Google only guarantees a refresh_token on the FIRST exchange for a
        // given client/user/scope combination — without forcing re-consent, a
        // returning user (stale/deleted token.json, invalid_grant recovery,
        // a fresh machine reusing the same Google account) can complete the
        // exchange without one, silently losing persistent offline access
        // (issue #115). Google always shows the consent screen anyway on a
        // genuinely first-time authorization, so this costs first-time users
        // nothing while making every other case obtain a refresh token too
        // (https://developers.google.com/identity/protocols/oauth2/web-server).
        prompt: 'consent',
    });
    logger.info('Opening browser for Google authorization...');
    logger.info('If the browser does not open, visit this URL:', authorizeUrl);
    void openBrowserSafely(authorizeUrl).then((opened) => {
        if (!opened) logger.warn('Could not auto-open browser. Please open this URL manually.');
    });
    const OAUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const code = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            server.close();
            reject(new Error(
                'OAuth flow timed out after 5 minutes. ' +
                'Please re-run `google-tools-mcp auth` or call the `troubleshoot` tool.'
            ));
        }, OAUTH_TIMEOUT_MS);
        server.on('request', (req, res) => {
            const url = new URL(req.url, `http://localhost:${port}`);
            const authCode = url.searchParams.get('code');
            const error = url.searchParams.get('error');
            // Checked before either outcome below settles the Promise, so a
            // forged callback can deliver neither a code nor a failure. Note
            // that a mismatch does NOT reject: rejecting would let anyone who
            // can reach this port cancel a legitimate sign-in that is still in
            // progress. Ignore it and keep waiting; the five-minute timeout
            // above is what bounds the flow.
            if ((authCode || error) && !stateMatches(state, url.searchParams.get('state'))) {
                logger.warn('Ignoring an OAuth callback whose state did not match this authorization request.');
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end('<h1>Authorization rejected</h1><p>This response did not come from the sign-in this app started. You can close this tab.</p>');
                return;
            }
            if (error) {
                clearTimeout(timeout);
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<h1>Authorization failed</h1><p>You can close this tab.</p>');
                server.close();
                reject(new Error(`Authorization error: ${error}`));
                return;
            }
            if (authCode) {
                clearTimeout(timeout);
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<h1>Google authorization successful!</h1><p>You can close this tab.</p>');
                server.close();
                resolve(authCode);
                return;
            }
            // Unrecognized request (favicon, prefetch, etc.) — respond so the
            // browser does not hang, but do not settle the Promise.
            res.writeHead(404);
            res.end();
        });
    });
    const { tokens } = await oAuth2Client.getToken({ code, codeVerifier: pkce.verifier });
    oAuth2Client.setCredentials(tokens);
    if (!tokens.refresh_token) {
        // Nothing durable was saved: the next process still has no token.json
        // and will have to run this whole interactive browser flow again.
        // Reporting "Authentication successful!" here would tell the caller
        // persistent offline access exists when it does not — the exact
        // failure mode of issue #115. Fail loudly instead of degrading to a
        // silently-temporary access-token-only client. Consent was already
        // forced above, so this means Google still didn't mint one — revoking
        // access is the only remaining lever.
        throw new Error('Google did not return a refresh token, so persistent offline access ' +
            'could not be saved, even with re-consent requested. Revoke access for this app at ' +
            'https://myaccount.google.com/permissions and run `google-tools-mcp auth` again.');
    }
    await saveCredentials(oAuth2Client);
    logger.info('Authentication successful!');
    return oAuth2Client;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export { getTokenPath, getConfigDir, getOAuthCallbackPort, SCOPES };

export async function authorize() {
    if (process.env.SERVICE_ACCOUNT_PATH) {
        logger.info('Service account path detected. Attempting service account authentication...');
        return authorizeWithServiceAccount();
    }
    logger.info('Attempting OAuth 2.0 authentication...');
    const client = await loadSavedCredentialsIfExist();
    if (client) {
        // Proactively refresh to verify the token is still valid
        try {
            logger.info('Refreshing access token...');
            const { credentials } = await client.refreshAccessToken();
            client.setCredentials(credentials);
            if (credentials.refresh_token) {
                await saveCredentials(client);
            }
            const expiryDate = credentials.expiry_date
                ? new Date(credentials.expiry_date).toISOString()
                : 'unknown';
            logger.info(`Token refreshed successfully. Expires: ${expiryDate}`);
            return client;
        } catch (err) {
            const isInvalidGrant = err.message?.includes('invalid_grant') ||
                err.response?.data?.error === 'invalid_grant';
            if (isInvalidGrant) {
                logger.warn('Saved refresh token is invalid/revoked. Starting re-authentication...');
                try { await fs.unlink(getTokenPath()); } catch {}
                return authenticate();
            }
            logger.error('Token refresh failed:', err.message || err);
            throw err;
        }
    }
    logger.info('No saved token found. Starting interactive authentication flow...');
    return authenticate();
}

export async function runAuthFlow() {
    return await authenticate();
}
