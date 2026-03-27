// Tool discovery and lazy-loading registration.
//
// Only the `load_google_tools` discovery tool is registered at startup.
// When a category is loaded, its tools are dynamically registered and the
// client is notified via tools/list_changed so it picks them up.
import { z } from 'zod';
import * as fs from 'fs/promises';
import { getTokenPath } from '../auth.js';
import { resetClients } from '../clients.js';
import { logger } from '../logger.js';

// --- Category registry ---
// Maps category names to { loader, description, toolCount }
const CATEGORIES = {
    files: {
        description: 'Google Drive file management — list, search, create, copy, move, rename, delete files/folders, read file contents (pdf, docx), search within files',
        toolCount: 16,
        async loader(server) {
            const { registerDriveTools } = await import('./drive/index.js');
            const { registerExtrasTools } = await import('./extras/index.js');
            registerDriveTools(server);
            registerExtrasTools(server);
        },
    },
    documents: {
        description: 'Google Docs — read, write, insert text/tables/images, formatting, comments, tabs, markdown conversion',
        toolCount: 23,
        async loader(server) {
            const { registerDocsTools } = await import('./docs/index.js');
            const { registerUtilsTools } = await import('./utils/index.js');
            registerDocsTools(server);
            registerUtilsTools(server);
        },
    },
    spreadsheets: {
        description: 'Google Sheets — read, write, format cells, charts, tables, conditional formatting, data validation',
        toolCount: 30,
        async loader(server) {
            const { registerSheetsTools } = await import('./sheets/index.js');
            registerSheetsTools(server);
        },
    },
    email: {
        description: 'Gmail — send, reply, forward, get, list, delete, trash messages, create/update/send drafts, attachments, batch operations',
        toolCount: 19,
        async loader(server) {
            const { register: registerMessages } = await import('./gmail/messages.js');
            const { register: registerDrafts } = await import('./gmail/drafts.js');
            registerMessages(server);
            registerDrafts(server);
        },
    },
    email_threads: {
        description: 'Gmail threads — get, list, batch get, modify, delete, trash/untrash conversation threads',
        toolCount: 7,
        async loader(server) {
            const { register } = await import('./gmail/threads.js');
            register(server);
        },
    },
    email_labels: {
        description: 'Gmail labels — create, delete, get, list, update labels for organizing email',
        toolCount: 6,
        async loader(server) {
            const { register } = await import('./gmail/labels.js');
            register(server);
        },
    },
    email_settings: {
        description: 'Gmail settings — auto-forwarding, IMAP, POP, vacation responder, delegates, filters, forwarding addresses, send-as aliases, S/MIME, profile, mailbox watch',
        toolCount: 37,
        async loader(server) {
            const { register } = await import('./gmail/settings.js');
            register(server);
        },
    },
    calendar: {
        description: 'Google Calendar — list calendars, get/create/update/delete events, check busy times, find free slots, move events, recurring event instances, manage calendars',
        toolCount: 8,
        async loader(server) {
            const { registerCalendarTools } = await import('./calendar/index.js');
            registerCalendarTools(server);
        },
    },
};

// Track which categories have been loaded
const loadedCategories = new Set();

// ---------------------------------------------------------------------------
// Notify the MCP client that the tool list has changed
// ---------------------------------------------------------------------------
function notifyToolsChanged(server) {
    try {
        const session = server.sessions?.[0];
        if (session?.server?.notification) {
            session.server.notification({ method: 'notifications/tools/list_changed' });
            logger.debug('Sent tools/list_changed notification.');
        } else {
            logger.debug('No session available for tools/list_changed notification.');
        }
    } catch (err) {
        logger.warn('Failed to send tools/list_changed notification:', err.message);
    }
}

// ---------------------------------------------------------------------------
// Public: register the discovery tool (and logout)
// ---------------------------------------------------------------------------
export function registerAllTools(server) {
    // --- Discovery tool ---
    server.addTool({
        name: 'load_google_tools',
        description:
            'Load Google Workspace tools by category. Call this first before using any Google service.\n\n' +
            'Categories:\n' +
            Object.entries(CATEGORIES)
                .map(([name, { description, toolCount }]) => `  • ${name} (${toolCount} tools) — ${description}`)
                .join('\n') +
            '\n\nYou can load multiple categories at once by passing an array.',
        parameters: z.object({
            categories: z
                .array(z.enum(Object.keys(CATEGORIES)))
                .describe('One or more category names to load'),
        }),
        execute: async ({ categories }, { log }) => {
            const results = [];
            for (const cat of categories) {
                if (loadedCategories.has(cat)) {
                    results.push({ category: cat, status: 'already_loaded' });
                    continue;
                }
                log.info(`Loading category: ${cat}`);
                await CATEGORIES[cat].loader(server);
                loadedCategories.add(cat);
                results.push({
                    category: cat,
                    status: 'loaded',
                    toolCount: CATEGORIES[cat].toolCount,
                });
            }
            notifyToolsChanged(server);
            return JSON.stringify({
                loaded: results,
                message: 'Tools are now available. You can call them directly.',
                all_loaded_categories: [...loadedCategories],
            });
        },
    });

    // --- Logout tool (always available) ---
    server.addTool({
        name: 'logout',
        description:
            'Log out of the current Google account by deleting the saved OAuth token. The next tool call will require re-authentication.',
        parameters: z.object({}),
        execute: async () => {
            const tokenPath = getTokenPath();
            try {
                await fs.unlink(tokenPath);
            } catch (err) {
                if (err.code !== 'ENOENT') throw err;
            }
            resetClients();
            return JSON.stringify({
                success: true,
                message: 'Logged out. The next tool call will require re-authentication.',
            });
        },
    });
}
