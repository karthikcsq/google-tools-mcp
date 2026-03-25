// src/auth.ts
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRootDir = path.resolve(__dirname, '..');
/** Credentials file path (legacy dev workflow fallback). */
const CREDENTIALS_PATH = path.join(projectRootDir, 'credentials.json');
/**
 * Token storage directory following XDG Base Directory spec.
 * Uses $XDG_CONFIG_HOME if set, otherwise ~/.config.
 *
 * When GOOGLE_MCP_PROFILE is set, tokens are stored in a subdirectory
 * per profile, allowing multiple Google accounts (one per project).
 */
function getConfigDir() {
    const xdg = process.env.XDG_CONFIG_HOME;
    const base = xdg || path.join(os.homedir(), '.config');
    const baseDir = path.join(base, 'google-docs-mcp');
    const profile = process.env.GOOGLE_MCP_PROFILE;
    return profile ? path.join(baseDir, profile) : baseDir;
}
function getTokenPath() {
    return path.join(getConfigDir(), 'token.json');
}
// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------
const SCOPES = [
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/script.external_request',
];
// ---------------------------------------------------------------------------
// .env file loader
// ---------------------------------------------------------------------------
async function loadEnvFile(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            let value = trimmed.slice(eqIdx + 1).trim();
            // Strip surrounding quotes
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (!process.env[key]) {
                process.env[key] = value;
            }
        }
        return true;
    } catch {
        return false;
    }
}
// ---------------------------------------------------------------------------
// Client secrets resolution
// ---------------------------------------------------------------------------
/**
 * Resolves OAuth client ID and secret.
 *
 * Priority:
 *   1. GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET env vars (including from MCP config)
 *   2. .env file in config dir (~/.config/google-docs-mcp/.env)
 *   3. .env file in project root
 *   4. credentials.json in config dir (~/.config/google-docs-mcp/credentials.json)
 *   5. credentials.json in project root (legacy dev fallback)
 */
async function loadClientSecrets() {
    // 1. Check env vars first (may already be set via MCP config)
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
        return { client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET };
    }
    // 2–4. Try loading .env files (config dir, cwd, then package root)
    const configDir = getConfigDir();
    const cwd = process.cwd();
    await loadEnvFile(path.join(configDir, '.env'));
    await loadEnvFile(path.join(cwd, '.env'));
    await loadEnvFile(path.join(projectRootDir, '.env'));
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
        logger.info('Loaded client credentials from .env file.');
        return { client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET };
    }
    // 5–7. Try credentials.json (config dir, cwd, then package root)
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
// Service account auth (unchanged)
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
        }
        else {
            logger.info('Service Account authentication successful!');
        }
        return auth;
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            logger.error(`FATAL: Service account key file not found at path: ${serviceAccountPath}`);
            throw new Error('Service account key file not found. Please check the path in SERVICE_ACCOUNT_PATH.');
        }
        logger.error('FATAL: Error loading or authorizing the service account key:', error.message);
        throw new Error('Failed to authorize using the service account. Ensure the key file is valid and the path is correct.');
    }
}
// ---------------------------------------------------------------------------
// Token persistence (XDG path)
// ---------------------------------------------------------------------------
async function loadSavedCredentialsIfExist() {
    try {
        const tokenPath = getTokenPath();
        const content = await fs.readFile(tokenPath, 'utf8');
        const credentials = JSON.parse(content);
        const { client_secret, client_id } = await loadClientSecrets();
        const client = new google.auth.OAuth2(client_id, client_secret);
        client.setCredentials(credentials);
        return client;
    }
    catch {
        return null;
    }
}
async function saveCredentials(client) {
    const { client_secret, client_id } = await loadClientSecrets();
    const configDir = getConfigDir();
    await fs.mkdir(configDir, { recursive: true });
    const tokenPath = getTokenPath();
    const payload = JSON.stringify({
        type: 'authorized_user',
        client_id,
        client_secret,
        refresh_token: client.credentials.refresh_token,
    }, null, 2);
    await fs.writeFile(tokenPath, payload);
    logger.info('Token stored to', tokenPath);
}
// ---------------------------------------------------------------------------
// Auto-open browser (cross-platform)
// ---------------------------------------------------------------------------
function openBrowser(url) {
    const platform = process.platform;
    let cmd;
    if (platform === 'win32') {
        cmd = `start "" "${url}"`;
    } else if (platform === 'darwin') {
        cmd = `open "${url}"`;
    } else {
        cmd = `xdg-open "${url}"`;
    }
    exec(cmd, (err) => {
        if (err) {
            logger.warn('Could not auto-open browser. Please open this URL manually.');
        }
    });
}
// ---------------------------------------------------------------------------
// Interactive OAuth browser flow
// ---------------------------------------------------------------------------
async function authenticate() {
    const { client_secret, client_id } = await loadClientSecrets();
    // Start a temporary local server to receive the OAuth callback
    const server = http.createServer();
    await new Promise((resolve) => server.listen(0, 'localhost', resolve));
    const port = server.address().port;
    const redirectUri = `http://localhost:${port}`;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);
    const authorizeUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES.join(' '),
    });
    logger.info('Opening browser for authorization...');
    logger.info('If the browser does not open, visit this URL:', authorizeUrl);
    openBrowser(authorizeUrl);
    // Wait for the OAuth callback
    const code = await new Promise((resolve, reject) => {
        server.on('request', (req, res) => {
            const url = new URL(req.url, `http://localhost:${port}`);
            const authCode = url.searchParams.get('code');
            const error = url.searchParams.get('error');
            if (error) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<h1>Authorization failed</h1><p>You can close this tab.</p>');
                reject(new Error(`Authorization error: ${error}`));
                server.close();
                return;
            }
            if (authCode) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<h1>Authorization successful!</h1><p>You can close this tab.</p>');
                resolve(authCode);
                server.close();
            }
        });
    });
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    if (tokens.refresh_token) {
        await saveCredentials(oAuth2Client);
    }
    else {
        logger.warn('Did not receive refresh token. Token might expire.');
    }
    logger.info('Authentication successful!');
    return oAuth2Client;
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Main authorization entry point used by the server at startup.
 *
 * Resolution order:
 *   1. SERVICE_ACCOUNT_PATH env var -> service account JWT
 *   2. Saved token in ~/.config/google-docs-mcp/token.json -> OAuth2Client
 *   3. Interactive browser OAuth flow -> OAuth2Client (saves token for next time)
 */
export async function authorize() {
    if (process.env.SERVICE_ACCOUNT_PATH) {
        logger.info('Service account path detected. Attempting service account authentication...');
        return authorizeWithServiceAccount();
    }
    logger.info('Attempting OAuth 2.0 authentication...');
    const client = await loadSavedCredentialsIfExist();
    if (client) {
        logger.info('Using saved credentials.');
        return client;
    }
    logger.info('No saved token found. Starting interactive authentication flow...');
    return authenticate();
}
/**
 * Forces the interactive OAuth browser flow, ignoring any saved token.
 * Used by the `auth` CLI subcommand to let users (re-)authorize.
 */
export async function runAuthFlow() {
    await authenticate();
}
