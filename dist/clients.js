// Combined clients for google-tools-mcp.
// Lazy-loads all Google API clients (Docs, Drive, Sheets, Script, Gmail) on first use.
import { google } from 'googleapis';
import { publicError, isPublicError, wrapOperationError } from './errors.js';
import { authorize } from './auth.js';
import { logger } from './logger.js';
import { openBrowser } from './shellSafe.js';

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

// Auth is the one failure mode where a generic "the operation failed" costs the
// caller a fix they could otherwise apply themselves, so the caught error is
// classified into a small closed set of known causes and only the matching
// CONSTANT is emitted. Nothing derived from the caught text crosses the
// boundary: an unclassified failure carries no detail at all, and the full
// error is always logged server-side by the caller of this table.
const AUTH_FAILURE_GUIDANCE = {
    invalid_grant:
        'Cause: the saved Google refresh token has expired or been revoked. '
        + 'Re-running auth issues a new one.',
    access_denied:
        'Cause: the Google consent screen was closed or access was declined. '
        + 'Re-run auth and approve the requested scopes.',
    invalid_client:
        'Cause: the configured Google OAuth client is not accepted by Google. '
        + 'Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then re-run auth.',
    missing_credentials:
        'Cause: no OAuth client credentials were found. Set GOOGLE_CLIENT_ID and '
        + 'GOOGLE_CLIENT_SECRET (or place a credentials.json from the Google Cloud '
        + 'Console in the config directory), then re-run auth. Running the auth '
        + 'command prints the exact locations it searched.',
    port_in_use:
        'Cause: the OAuth callback port is already in use. Free it (or set '
        + 'GOOGLE_MCP_OAUTH_PORT to a free port), then re-run auth.',
    timed_out:
        'Cause: the browser authorization flow was not completed in time. Re-run auth '
        + 'and finish the Google sign-in in the browser tab it opens.',
    unreachable:
        'Cause: Google could not be reached to complete authentication. Check network '
        + 'connectivity, then re-run auth.',
};

// Match only on shapes we control or that OAuth defines: our own thrown
// messages from dist/auth.js, Node's `code` for socket-level failures, and the
// RFC 6749 error identifiers Google returns. Anything else returns undefined.
function classifyAuthFailure(error) {
    const message = typeof error?.message === 'string' ? error.message : '';
    const oauthCode = error?.response?.data?.error;
    const nodeCode = error?.code;

    if (oauthCode === 'invalid_grant' || message.includes('invalid_grant')) return 'invalid_grant';
    if (oauthCode === 'access_denied' || /Authorization error: access_denied/.test(message)) return 'access_denied';
    if (oauthCode === 'invalid_client' || message.includes('invalid_client')) return 'invalid_client';
    if (message.startsWith('No OAuth credentials found')
        || message.startsWith('Service account key file not found')) return 'missing_credentials';
    if (nodeCode === 'EADDRINUSE') return 'port_in_use';
    if (message.startsWith('OAuth flow timed out')) return 'timed_out';
    if (nodeCode === 'ENOTFOUND' || nodeCode === 'ECONNREFUSED' || nodeCode === 'EAI_AGAIN'
        || nodeCode === 'ETIMEDOUT') return 'unreachable';
    return undefined;
}

async function ensureAuth() {
    if (authClient) return;
    try {
        logger.info('Attempting to authorize Google API client...');
        authClient = await authorize();
        logger.info('Google API client authorized successfully.');
    } catch (error) {
        if (isPublicError(error)) throw error;
        logger.error('Failed to initialize Google API client:', error);
        authClient = null;
        const guidance = AUTH_FAILURE_GUIDANCE[classifyAuthFailure(error)];
        throw publicError(
            'Google authentication required. A browser window should have opened automatically. '
            + 'If not, run: npx google-tools-mcp auth'
            + (guidance ? `\n\n${guidance}` : '')
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

/**
 * Detect "API has not been used / is disabled" errors from Google APIs.
 * Triggered when a required Google API was never enabled in the user's project.
 */
function isApiNotEnabledError(error) {
    if (!error) return false;
    const msg = error.message || '';
    if (/has not been used in project .* before or it is disabled/i.test(msg)) return true;
    if (/SERVICE_DISABLED/i.test(msg)) return true;
    const details = error.response?.data?.error?.details;
    if (Array.isArray(details)) {
        for (const d of details) {
            if (d?.reason === 'SERVICE_DISABLED') return true;
        }
    }
    return false;
}

/**
 * Pull the API name, project ID, and enable URL out of an API-disabled error.
 * Returns null if extraction fails.
 */
function extractApiEnableInfo(error) {
    const msg = error?.message || '';
    let api = null;
    let projectId = null;
    let enableUrl = null;
    const urlMatch = msg.match(/https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s)]+/);
    if (urlMatch) enableUrl = urlMatch[0];
    const apiMatch = msg.match(/api\/([a-z0-9.-]+\.googleapis\.com)/i)
        || msg.match(/([a-z0-9.-]+\.googleapis\.com)/i);
    if (apiMatch) api = apiMatch[1];
    const projMatch = msg.match(/project=(\d+)/) || msg.match(/project (\d+)/);
    if (projMatch) projectId = projMatch[1];
    const details = error?.response?.data?.error?.details;
    if (Array.isArray(details)) {
        for (const d of details) {
            if (d?.metadata?.service && !api) api = d.metadata.service;
            if (d?.metadata?.consumer && !projectId) {
                const m = d.metadata.consumer.match(/projects\/(\d+)/);
                if (m) projectId = m[1];
            }
        }
    }
    if (!enableUrl && api) {
        enableUrl = `https://console.cloud.google.com/apis/api/${api}/overview${projectId ? `?project=${projectId}` : ''}`;
    }
    if (!api && !enableUrl) return null;
    return { api, projectId, enableUrl };
}

// Track APIs we've auto-opened this session so we don't spam the browser.
const openedApiEnableUrls = new Set();

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
        if (isPublicError(error)) throw error;
        if (isInvalidGrantError(error)) {
            logger.warn('Got invalid_grant during API call. Re-authenticating...');
            await reauthorize();
            return await fn();
        }
        if (isApiNotEnabledError(error)) {
            const info = extractApiEnableInfo(error);
            if (info?.enableUrl) {
                const apiLabel = info.api || 'a required Google API';
                if (!openedApiEnableUrls.has(info.enableUrl)) {
                    openedApiEnableUrls.add(info.enableUrl);
                    logger.warn(`Auto-opening enable URL for ${apiLabel}: ${info.enableUrl}`);
                    openBrowser(info.enableUrl);
                }
                throw publicError(
                    `${apiLabel} is not enabled${info.projectId ? ` for project ${info.projectId}` : ''}. ` +
                    `A browser window was opened to the enable page — click "Enable", wait ~30 seconds for it to propagate, then retry your request.\n\n` +
                    `Enable URL: ${info.enableUrl}`
                );
            }
        }
        throw error;
    }
}

// --- Individual client getters ---
export async function getDocsClient() {
    const { googleDocs: docs } = await initializeGoogleClient();
    if (!docs) throw publicError('Google Docs client is not initialized.');
    return docs;
}

export async function getDriveClient() {
    const { googleDrive: drive } = await initializeGoogleClient();
    if (!drive) throw publicError('Google Drive client is not initialized.');
    return drive;
}

export async function getSheetsClient() {
    const { googleSheets: sheets } = await initializeGoogleClient();
    if (!sheets) throw publicError('Google Sheets client is not initialized.');
    return sheets;
}

export async function getAuthClient() {
    const { authClient: client } = await initializeGoogleClient();
    if (!client) throw publicError('Auth client is not initialized.');
    return client;
}

export async function getScriptClient() {
    const { googleScript: script } = await initializeGoogleClient();
    if (!script) throw publicError('Google Script client is not initialized.');
    return script;
}

export async function getGmailClient() {
    const { gmailClient: gmail } = await initializeGmailClient();
    if (!gmail) throw publicError('Gmail client is not initialized.');
    return gmail;
}

export async function getCalendarClient() {
    const { calendarClient: calendar } = await initializeCalendarClient();
    if (!calendar) throw publicError('Google Calendar client is not initialized.');
    return calendar;
}

export async function getFormsClient() {
    const { formsClient: forms } = await initializeFormsClient();
    if (!forms) throw publicError('Google Forms client is not initialized.');
    return forms;
}

export async function getSlidesClient() {
    const { slidesClient: slides } = await initializeSlidesClient();
    if (!slides) throw publicError('Google Slides client is not initialized.');
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
    if (!tasks) throw publicError('Google Tasks client is not initialized.');
    return tasks;
}
