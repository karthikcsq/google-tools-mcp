// src/clients.ts
//
// Lazy-loading Gmail API client. Auth only runs on first tool call.
import { google } from 'googleapis';
import { UserError } from 'fastmcp';
import { authorize } from './auth.js';
import { logger } from './logger.js';

let authClient = null;
let gmailClient = null;

export async function initializeGmailClient() {
    if (gmailClient)
        return { authClient, gmailClient };
    if (!authClient) {
        try {
            logger.info('Attempting to authorize Gmail API client...');
            const client = await authorize();
            authClient = client;
            gmailClient = google.gmail({ version: 'v1', auth: authClient });
            logger.info('Gmail API client authorized successfully.');
        } catch (error) {
            authClient = null;
            gmailClient = null;
            throw new UserError(
                'Gmail authentication required. A browser window should have opened automatically. ' +
                'If not, run: npx mcp-gmail auth\n\n' +
                'Details: ' + (error.message || error)
            );
        }
    }
    if (authClient && !gmailClient) {
        gmailClient = google.gmail({ version: 'v1', auth: authClient });
    }
    if (!gmailClient) {
        throw new Error('Gmail client could not be initialized.');
    }
    return { authClient, gmailClient };
}

export async function getGmailClient() {
    const { gmailClient: gmail } = await initializeGmailClient();
    if (!gmail) {
        throw new UserError('Gmail client is not initialized. Authentication might have failed.');
    }
    return gmail;
}
