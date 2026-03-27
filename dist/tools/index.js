// Tool registration — all categories loaded eagerly at startup.
// (Claude Code doesn't support notifications/tools/list_changed,
//  so lazy-loading doesn't work.)
import { z } from 'zod';
import * as fs from 'fs/promises';
import { getTokenPath } from '../auth.js';
import { resetClients } from '../clients.js';
import { logger } from '../logger.js';

// --- Category registry ---
const CATEGORIES = {
    files: {
        async loader(server) {
            const { registerDriveTools } = await import('./drive/index.js');
            const { registerExtrasTools } = await import('./extras/index.js');
            registerDriveTools(server);
            registerExtrasTools(server);
        },
    },
    documents: {
        async loader(server) {
            const { registerDocsTools } = await import('./docs/index.js');
            const { registerUtilsTools } = await import('./utils/index.js');
            registerDocsTools(server);
            registerUtilsTools(server);
        },
    },
    spreadsheets: {
        async loader(server) {
            const { registerSheetsTools } = await import('./sheets/index.js');
            registerSheetsTools(server);
        },
    },
    email: {
        async loader(server) {
            const { register: registerMessages } = await import('./gmail/messages.js');
            const { register: registerDrafts } = await import('./gmail/drafts.js');
            registerMessages(server);
            registerDrafts(server);
        },
    },
    email_threads: {
        async loader(server) {
            const { register } = await import('./gmail/threads.js');
            register(server);
        },
    },
    email_labels: {
        async loader(server) {
            const { register } = await import('./gmail/labels.js');
            register(server);
        },
    },
    email_settings: {
        async loader(server) {
            const { register } = await import('./gmail/settings.js');
            register(server);
        },
    },
    calendar: {
        async loader(server) {
            const { registerCalendarTools } = await import('./calendar/index.js');
            registerCalendarTools(server);
        },
    },
};

// ---------------------------------------------------------------------------
// Public: register all tools eagerly, plus the logout utility.
// ---------------------------------------------------------------------------
export async function registerAllTools(server) {
    // Load every category
    for (const [name, { loader }] of Object.entries(CATEGORIES)) {
        await loader(server);
    }
    logger.info(`Loaded all ${Object.keys(CATEGORIES).length} categories at startup.`);

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
