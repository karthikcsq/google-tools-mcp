// src/auth.ts
//
// OAuth2 authentication for gmail-mcp-tools.
// Config dir: ~/.config/gmail-mcp-tools/ (with GOOGLE_MCP_PROFILE subdirs).
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRootDir = path.resolve(__dirname, '..');
const CREDENTIALS_PATH = path.join(projectRootDir, 'credentials.json');

// ---------------------------------------------------------------------------
// Paths (own config dir, same multi-profile pattern as gmail-mcp-tools)
// ---------------------------------------------------------------------------
function getConfigDir() {
    const xdg = process.env.XDG_CONFIG_HOME;
    const base = xdg || path.join(os.homedir(), '.config');
    const baseDir = path.join(base, 'gmail-mcp-tools');
    const profile = process.env.GOOGLE_MCP_PROFILE;
    return profile ? path.join(baseDir, profile) : baseDir;
}

function getTokenPath() {
    return path.join(getConfigDir(), 'token.json');
}

// ---------------------------------------------------------------------------
// Scopes (Gmail-specific)
// ---------------------------------------------------------------------------
const SCOPES = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.settings.basic',
    'https://www.googleapis.com/auth/gmail.settings.sharing',
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
// Client secrets resolution (same priority as gmail-mcp-tools)
// ---------------------------------------------------------------------------
async function loadClientSecrets() {
    // 1. Check env vars first
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
        return { client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET };
    }
    // 2-4. Try .env files
    const configDir = getConfigDir();
    const cwd = process.cwd();
    await loadEnvFile(path.join(configDir, '.env'));
    await loadEnvFile(path.join(cwd, '.env'));
    await loadEnvFile(path.join(projectRootDir, '.env'));
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
        logger.info('Loaded client credentials from .env file.');
        return { client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET };
    }
    // 5-7. Try credentials.json files
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
        const { client_secret, client_id } = await loadClientSecrets();
        const client = new google.auth.OAuth2(client_id, client_secret);
        client.setCredentials(credentials);
        return client;
    } catch {
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
// Browser opener (cross-platform)
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
    const server = http.createServer();
    await new Promise((resolve) => server.listen(0, 'localhost', resolve));
    const port = server.address().port;
    const redirectUri = `http://localhost:${port}`;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);
    const authorizeUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES.join(' '),
    });
    logger.info('Opening browser for Gmail authorization...');
    logger.info('If the browser does not open, visit this URL:', authorizeUrl);
    openBrowser(authorizeUrl);
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
                res.end('<h1>Gmail authorization successful!</h1><p>You can close this tab.</p>');
                resolve(authCode);
                server.close();
            }
        });
    });
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    if (tokens.refresh_token) {
        await saveCredentials(oAuth2Client);
    } else {
        logger.warn('Did not receive refresh token. Token might expire.');
    }
    logger.info('Gmail authentication successful!');
    return oAuth2Client;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function authorize() {
    if (process.env.SERVICE_ACCOUNT_PATH) {
        logger.info('Service account path detected. Attempting service account authentication...');
        return authorizeWithServiceAccount();
    }
    logger.info('Attempting Gmail OAuth 2.0 authentication...');
    const client = await loadSavedCredentialsIfExist();
    if (client) {
        logger.info('Using saved Gmail credentials.');
        return client;
    }
    logger.info('No saved Gmail token found. Starting interactive authentication flow...');
    return authenticate();
}

export async function runAuthFlow() {
    await authenticate();
}
