// Tool registration — all categories loaded eagerly at startup.
// (Claude Code doesn't support notifications/tools/list_changed,
//  so lazy-loading doesn't work.)
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getTokenPath } from '../auth.js';
import { resetClients, withAuthRetry } from '../clients.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Wrap server.addTool so every tool's execute() auto-retries on invalid_grant.
// ---------------------------------------------------------------------------
function wrapServerWithAuthRetry(server) {
    const originalAddTool = server.addTool.bind(server);
    server.addTool = function (toolDef) {
        const originalExecute = toolDef.execute;
        if (originalExecute) {
            toolDef.execute = function (...args) {
                return withAuthRetry(() => originalExecute.apply(this, args));
            };
        }
        return originalAddTool(toolDef);
    };
    return server;
}

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
    forms: {
        async loader(server) {
            const { registerFormsTools } = await import('./forms/index.js');
            registerFormsTools(server);
        },
    },
};

// ---------------------------------------------------------------------------
// Public: register all tools eagerly, plus the logout utility.
// ---------------------------------------------------------------------------
export async function registerAllTools(server) {
    // Wrap server so every tool auto-retries on invalid_grant (expired refresh token)
    const wrappedServer = wrapServerWithAuthRetry(server);

    // Load every category
    for (const [name, { loader }] of Object.entries(CATEGORIES)) {
        await loader(wrappedServer);
    }
    logger.info(`Loaded all ${Object.keys(CATEGORIES).length} categories at startup.`);

    // --- Help tool (always available) ---
    server.addTool({
        name: 'help',
        description:
            'Show documentation for google-tools-mcp: setup instructions, available tool categories, environment variables, and troubleshooting. Call this when you need guidance on how to use the Google Workspace tools.',
        parameters: z.object({}),
        execute: async () => {
            const __dirname = path.dirname(fileURLToPath(import.meta.url));
            const readmePath = path.resolve(__dirname, '..', '..', 'README.md');
            try {
                return await fs.readFile(readmePath, 'utf-8');
            } catch {
                return 'README not found. Visit https://www.npmjs.com/package/google-tools-mcp for documentation.';
            }
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
