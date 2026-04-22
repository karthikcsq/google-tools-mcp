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
let calendarClient = null;
let formsClient = null;
let slidesClient = null;
let tasksClient = null;

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

/**
 * Re-authenticate and rebuild all API clients after an invalid_grant error.
 */
async function reauthorize() {
    logger.info('Re-authorizing after invalid_grant...');
    authClient = null;
    googleDocs = null;
    googleDrive = null;
    googleSheets = null;
    googleScript = null;
    gmailClient = null;
    calendarClient = null;
    formsClient = null;
    slidesClient = null;
    tasksClient = null;
    authClient = await authorize();
    logger.info('Re-authorization successful.');
}

/**
 * Check if an error is an invalid_grant error (expired/revoked refresh token).
 */
function isInvalidGrantError(error) {
    if (!error) return false;
    const msg = error.message || '';
    const code = error.response?.data?.error || error.code || '';
    return msg.includes('invalid_grant') || code === 'invalid_grant';
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

// --- Calendar client ---
export async function initializeCalendarClient() {
    if (calendarClient) return { authClient, calendarClient };
    await ensureAuth();
    if (!calendarClient) calendarClient = google.calendar({ version: 'v3', auth: authClient });
    return { authClient, calendarClient };
}

// --- Forms client ---
export async function initializeFormsClient() {
    if (formsClient) return { authClient, formsClient };
    await ensureAuth();
    if (!formsClient) formsClient = google.forms({ version: 'v1', auth: authClient });
    return { authClient, formsClient };
}

// --- Slides client ---
export async function initializeSlidesClient() {
    if (slidesClient) return { authClient, slidesClient };
    await ensureAuth();
    if (!slidesClient) slidesClient = google.slides({ version: 'v1', auth: authClient });
    return { authClient, slidesClient };
}

// --- Get auth client without triggering init (for diagnostics) ---
export function getAuthClientIfReady() {
    return authClient;
}

// --- Reset all clients (used by logout) ---
export function resetClients() {
    authClient = null;
    googleDocs = null;
    googleDrive = null;
    googleSheets = null;
    googleScript = null;
    gmailClient = null;
    calendarClient = null;
    formsClient = null;
    slidesClient = null;
    tasksClient = null;
}

/**
 * Execute a function with automatic re-auth on invalid_grant errors.
 * Wraps any API call so that if the refresh token has been revoked mid-session,
 * we re-authenticate transparently and retry once.
 */
export async function withAuthRetry(fn) {
    try {
        return await fn();
    } catch (error) {
        if (isInvalidGrantError(error)) {
            logger.warn('Got invalid_grant during API call. Re-authenticating...');
            await reauthorize();
            return await fn();
        }
        throw error;
    }
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

export async function getCalendarClient() {
    const { calendarClient: calendar } = await initializeCalendarClient();
    if (!calendar) throw new UserError('Google Calendar client is not initialized.');
    return calendar;
}

export async function getFormsClient() {
    const { formsClient: forms } = await initializeFormsClient();
    if (!forms) throw new UserError('Google Forms client is not initialized.');
    return forms;
}

export async function getSlidesClient() {
    const { slidesClient: slides } = await initializeSlidesClient();
    if (!slides) throw new UserError('Google Slides client is not initialized.');
    return slides;
}

// --- Tasks client ---
export async function initializeTasksClient() {
    if (tasksClient) return { authClient, tasksClient };
    await ensureAuth();
    if (!tasksClient) tasksClient = google.tasks({ version: 'v1', auth: authClient });
    return { authClient, tasksClient };
}

export async function getTasksClient() {
    const { tasksClient: tasks } = await initializeTasksClient();
    if (!tasks) throw new UserError('Google Tasks client is not initialized.');
    return tasks;
}
