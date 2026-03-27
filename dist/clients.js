// Combined clients for google-tools-mcp.
// Lazy-loads all Google API clients (Docs, Drive, Sheets, Script, Gmail) on first use.
import { google } from 'googleapis';
import { UserError } from 'fastmcp';
import { authorize } from './auth.js';
import { logger } from './logger.js';

let authClient = null;
let googleDocs = null;
let googleDrive = null;
let googleSheets = null;
let googleScript = null;
let gmailClient = null;

async function ensureAuth() {
    if (authClient) return;
    try {
        logger.info('Attempting to authorize Google API client...');
        authClient = await authorize();
        logger.info('Google API client authorized successfully.');
    } catch (error) {
        logger.error('Failed to initialize Google API client:', error);
        authClient = null;
        throw new UserError(
            'Google authentication required. A browser window should have opened automatically. ' +
            'If not, run: npx google-tools-mcp auth\n\n' +
            'Details: ' + (error.message || error)
        );
    }
}

// --- GDrive clients ---
export async function initializeGoogleClient() {
    if (googleDocs && googleDrive && googleSheets)
        return { authClient, googleDocs, googleDrive, googleSheets, googleScript };
    await ensureAuth();
    if (!googleDocs) googleDocs = google.docs({ version: 'v1', auth: authClient });
    if (!googleDrive) googleDrive = google.drive({ version: 'v3', auth: authClient });
    if (!googleSheets) googleSheets = google.sheets({ version: 'v4', auth: authClient });
    if (!googleScript) googleScript = google.script({ version: 'v1', auth: authClient });
    return { authClient, googleDocs, googleDrive, googleSheets, googleScript };
}

// --- Gmail client ---
export async function initializeGmailClient() {
    if (gmailClient) return { authClient, gmailClient };
    await ensureAuth();
    if (!gmailClient) gmailClient = google.gmail({ version: 'v1', auth: authClient });
    return { authClient, gmailClient };
}

// --- Reset all clients (used by logout) ---
export function resetClients() {
    authClient = null;
    googleDocs = null;
    googleDrive = null;
    googleSheets = null;
    googleScript = null;
    gmailClient = null;
}

// --- Individual client getters ---
export async function getDocsClient() {
    const { googleDocs: docs } = await initializeGoogleClient();
    if (!docs) throw new UserError('Google Docs client is not initialized.');
    return docs;
}

export async function getDriveClient() {
    const { googleDrive: drive } = await initializeGoogleClient();
    if (!drive) throw new UserError('Google Drive client is not initialized.');
    return drive;
}

export async function getSheetsClient() {
    const { googleSheets: sheets } = await initializeGoogleClient();
    if (!sheets) throw new UserError('Google Sheets client is not initialized.');
    return sheets;
}

export async function getAuthClient() {
    const { authClient: client } = await initializeGoogleClient();
    if (!client) throw new UserError('Auth client is not initialized.');
    return client;
}

export async function getScriptClient() {
    const { googleScript: script } = await initializeGoogleClient();
    if (!script) throw new UserError('Google Script client is not initialized.');
    return script;
}

export async function getGmailClient() {
    const { gmailClient: gmail } = await initializeGmailClient();
    if (!gmail) throw new UserError('Gmail client is not initialized.');
    return gmail;
}
