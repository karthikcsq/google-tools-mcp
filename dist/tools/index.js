// Tool registration — all categories loaded eagerly at startup.
// (Claude Code doesn't support notifications/tools/list_changed,
//  so lazy-loading doesn't work.)
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getTokenPath, getConfigDir, SCOPES } from '../auth.js';
import { resetClients, withAuthRetry, getAuthClientIfReady } from '../clients.js';
import { logger } from '../logger.js';
import { google } from 'googleapis';

const execAsync = promisify(exec);

const REPO = 'karthikcsq/google-tools-mcp';

async function tryGhCli(title, body, label) {
    // Probe for gh CLI
    try {
        await execAsync('gh --version');
    } catch {
        return { ok: false, reason: 'gh CLI not installed' };
    }
    // Probe for auth
    try {
        await execAsync('gh auth status');
    } catch {
        return { ok: false, reason: 'gh CLI not authenticated (run: gh auth login)' };
    }
    // Write body to a temp file to avoid shell-escaping issues with newlines/quotes.
    const tmpFile = path.join(os.tmpdir(), `gtm-feedback-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    try {
        await fs.writeFile(tmpFile, body, 'utf8');
        const { stdout } = await execAsync(
            `gh issue create --repo ${REPO} --title ${JSON.stringify(title)} --label ${JSON.stringify(label)} --body-file ${JSON.stringify(tmpFile)}`,
            { maxBuffer: 10 * 1024 * 1024 }
        );
        const issueUrl = stdout.trim().split('\n').pop();
        return { ok: true, issueUrl };
    } catch (err) {
        return { ok: false, reason: `gh CLI failed: ${err.stderr || err.message || err}` };
    } finally {
        try { await fs.unlink(tmpFile); } catch {}
    }
}

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
    return new Promise((resolve) => {
        exec(cmd, (err) => resolve(!err));
    });
}

// ---------------------------------------------------------------------------
// Wrap server.addTool so every tool's execute() auto-retries on invalid_grant
// and appends a troubleshoot/feedback hint to errors.
// ---------------------------------------------------------------------------
const ERROR_HINT =
    '\n\nIf this error is unexpected or unclear, you can:\n' +
    '  • Call the `troubleshoot` tool to run a health check (auth, API connectivity, recent logs).\n' +
    '  • Call the `feedback` tool to file a bug report with diagnostics auto-attached.';

// Tools that should NOT have the hint appended (would be circular/noisy).
const HINT_EXCLUDED_TOOLS = new Set(['troubleshoot', 'feedback', 'help', 'logout']);

function appendHintToError(error, toolName) {
    if (HINT_EXCLUDED_TOOLS.has(toolName)) return error;
    if (!error) return error;
    // Avoid double-appending if something else (or a retry) already added it.
    const existingMsg = error.message || '';
    if (existingMsg.includes('`troubleshoot` tool')) return error;
    try {
        error.message = existingMsg + ERROR_HINT;
    } catch {
        // Some error types have non-writable message; fall back to a new error.
        const wrapped = new Error(existingMsg + ERROR_HINT);
        wrapped.cause = error;
        return wrapped;
    }
    return error;
}

function wrapServerWithAuthRetry(server) {
    const originalAddTool = server.addTool.bind(server);
    server.addTool = function (toolDef) {
        const originalExecute = toolDef.execute;
        const toolName = toolDef.name;
        if (originalExecute) {
            toolDef.execute = async function (...args) {
                try {
                    return await withAuthRetry(() => originalExecute.apply(this, args));
                } catch (err) {
                    throw appendHintToError(err, toolName);
                }
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

    // --- Troubleshoot tool (always available) ---
    server.addTool({
        name: 'troubleshoot',
        description:
            'Run a health check on google-tools-mcp: verify OAuth token, test API connectivity, show config and recent logs. Call this when tools are failing or behaving unexpectedly.',
        parameters: z.object({}),
        execute: async () => {
            const report = { auth: {}, services: {}, config: {}, recentLogs: null, environment: {} };

            // --- Auth status ---
            const tokenPath = getTokenPath();
            try {
                const tokenContent = await fs.readFile(tokenPath, 'utf8');
                const token = JSON.parse(tokenContent);
                report.auth.tokenFile = 'present';
                report.auth.hasRefreshToken = !!token.refresh_token;
                report.auth.type = token.type || 'unknown';
            } catch (err) {
                report.auth.tokenFile = err.code === 'ENOENT' ? 'missing' : 'unreadable';
                report.auth.hasRefreshToken = false;
            }

            // Try refreshing token
            const client = getAuthClientIfReady();
            if (client) {
                try {
                    const { credentials } = await client.refreshAccessToken();
                    client.setCredentials(credentials);
                    report.auth.status = 'valid';
                    report.auth.expiry = credentials.expiry_date
                        ? new Date(credentials.expiry_date).toISOString()
                        : 'unknown';
                } catch (err) {
                    report.auth.status = 'expired_or_revoked';
                    report.auth.refreshError = err.message;
                }
            } else {
                report.auth.status = report.auth.tokenFile === 'present' ? 'not_initialized' : 'missing';
            }

            // --- Service probes ---
            if (client && report.auth.status === 'valid') {
                // Drive
                try {
                    const drive = google.drive({ version: 'v3', auth: client });
                    const res = await drive.about.get({ fields: 'user' });
                    report.services.drive = { status: 'ok', account: res.data.user?.emailAddress || 'unknown' };
                } catch (err) {
                    report.services.drive = { status: 'error', error: err.message };
                }

                // Gmail
                try {
                    const gmail = google.gmail({ version: 'v1', auth: client });
                    const res = await gmail.users.getProfile({ userId: 'me' });
                    report.services.gmail = { status: 'ok', email: res.data.emailAddress || 'unknown' };
                } catch (err) {
                    report.services.gmail = { status: 'error', error: err.message };
                }

                // Calendar
                try {
                    const calendar = google.calendar({ version: 'v3', auth: client });
                    await calendar.calendarList.list({ maxResults: 1 });
                    report.services.calendar = { status: 'ok' };
                } catch (err) {
                    report.services.calendar = { status: 'error', error: err.message };
                }

                // Forms — just check scope presence
                report.services.forms = {
                    status: SCOPES.some(s => s.includes('forms')) ? 'configured' : 'no_scope',
                };

                // Docs/Sheets — covered by Drive auth
                report.services.docs = { status: report.services.drive.status === 'ok' ? 'ok (via Drive auth)' : 'unknown' };
                report.services.sheets = { status: report.services.drive.status === 'ok' ? 'ok (via Drive auth)' : 'unknown' };
            } else {
                report.services = { note: 'Skipped — auth not available' };
            }

            // --- Config summary ---
            const configDir = getConfigDir();
            report.config = {
                configDir,
                profile: process.env.GOOGLE_MCP_PROFILE || '(default)',
                tokenPath,
                credentialSource: process.env.GOOGLE_CLIENT_ID ? 'environment' : 'file',
                scopes: SCOPES,
                logFile: process.env.GOOGLE_MCP_LOG_FILE || '(not set)',
            };

            // --- Recent logs ---
            const logFilePath = process.env.GOOGLE_MCP_LOG_FILE === '1'
                ? path.join(configDir, 'server.log')
                : process.env.GOOGLE_MCP_LOG_FILE;
            if (logFilePath) {
                try {
                    const logContent = await fs.readFile(logFilePath, 'utf8');
                    const lines = logContent.trimEnd().split('\n');
                    report.recentLogs = lines.slice(-20);
                } catch (err) {
                    report.recentLogs = err.code === 'ENOENT' ? '(log file not found)' : `(error reading log: ${err.message})`;
                }
            } else {
                report.recentLogs = '(file logging not enabled — set GOOGLE_MCP_LOG_FILE to enable)';
            }

            // --- Environment ---
            const __dirname = path.dirname(fileURLToPath(import.meta.url));
            let pkgVersion = 'unknown';
            try {
                const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
                const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
                pkgVersion = pkg.version;
            } catch {}
            report.environment = {
                serverVersion: pkgVersion,
                nodeVersion: process.version,
                platform: process.platform,
                osRelease: os.release(),
                arch: process.arch,
            };

            return JSON.stringify(report, null, 2);
        },
    });

    // --- Feedback tool (always available) ---
    server.addTool({
        name: 'feedback',
        description:
            'Submit feedback or a bug report for google-tools-mcp. Automatically collects diagnostic info, then files the issue via the GitHub CLI (`gh`) if available, or falls back to opening a pre-filled GitHub issue URL in the user\'s browser.',
        parameters: z.object({
            type: z.enum(['bug', 'feature']).describe('Type of feedback'),
            title: z.string().describe('Short summary'),
            description: z.string().describe('Detailed description of the issue or feature request'),
        }),
        execute: async (args) => {
            // Collect diagnostics
            const __dirname = path.dirname(fileURLToPath(import.meta.url));
            let pkgVersion = 'unknown';
            try {
                const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
                const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
                pkgVersion = pkg.version;
            } catch {}

            let authStatus = 'unknown';
            const tokenPath = getTokenPath();
            try {
                await fs.access(tokenPath);
                const client = getAuthClientIfReady();
                if (client) {
                    try {
                        await client.refreshAccessToken();
                        authStatus = 'valid';
                    } catch {
                        authStatus = 'expired_or_revoked';
                    }
                } else {
                    authStatus = 'not_initialized';
                }
            } catch {
                authStatus = 'missing';
            }

            const enabledScopes = SCOPES.map(s => s.split('/').pop());

            // Build markdown body
            const diagnostics = [
                `- **Server version:** ${pkgVersion}`,
                `- **Node version:** ${process.version}`,
                `- **OS:** ${process.platform} ${os.release()} (${process.arch})`,
                `- **Auth status:** ${authStatus}`,
                `- **Scopes:** ${enabledScopes.join(', ')}`,
            ].join('\n');

            const body = [
                `## Description`,
                ``,
                args.description,
                ``,
                `<details>`,
                `<summary>Diagnostic Info</summary>`,
                ``,
                diagnostics,
                ``,
                `</details>`,
            ].join('\n');

            const label = args.type === 'bug' ? 'bug' : 'enhancement';

            // Try gh CLI first
            const ghResult = await tryGhCli(args.title, body, label);
            if (ghResult.ok) {
                return JSON.stringify({
                    method: 'gh-cli',
                    issueUrl: ghResult.issueUrl,
                    note: 'Issue filed successfully via GitHub CLI.',
                }, null, 2);
            }

            // Fallback: open pre-filled GitHub issue URL in the user's browser
            const params = new URLSearchParams({
                title: args.title,
                body,
                labels: label,
            });
            const url = `https://github.com/${REPO}/issues/new?${params.toString()}`;
            const opened = await openBrowser(url);

            return JSON.stringify({
                method: 'browser-fallback',
                ghCliUnavailableReason: ghResult.reason,
                url,
                browserOpened: opened,
                markdown: body,
                note: url.length > 8000
                    ? 'The URL may be too long for some browsers. Use the markdown body to create the issue manually.'
                    : opened
                        ? 'Opened the pre-filled GitHub issue in your browser. Click "Submit new issue" to file it.'
                        : 'Could not auto-open browser. Please open the URL manually.',
            }, null, 2);
        },
    });
}
