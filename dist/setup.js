// Guided setup wizard for google-tools-mcp.
// Rich terminal UI using @clack/prompts.
import * as p from '@clack/prompts';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export const REQUIRED_APIS = [
    'docs.googleapis.com',
    'sheets.googleapis.com',
    'drive.googleapis.com',
    'gmail.googleapis.com',
    'calendar-json.googleapis.com',
    'forms.googleapis.com',
    'slides.googleapis.com',
    'tasks.googleapis.com',
];

const ENABLE_APIS_URL =
    `https://console.cloud.google.com/flows/enableapi?apiid=${REQUIRED_APIS.join(',')}`;

const CREATE_CREDENTIALS_URL =
    'https://console.cloud.google.com/apis/credentials/oauthclient';

const CONSENT_SCREEN_URL =
    'https://console.cloud.google.com/apis/credentials/consent';

// Direct link to the Audience tab on the new "Google Auth Platform" UI — this
// is where the Test users section lives in the redesigned console.
const AUDIENCE_URL =
    'https://console.cloud.google.com/auth/audience';

// The command a global-install user needs to run to pick up a new release.
// Unlike `npx -y google-tools-mcp`, a direct `node <global-path>` launch
// command (see the fast-launch block below) never re-resolves to the latest
// version on its own, so we surface this explicitly wherever we point a
// client at a fixed path. Exported so the regression test can assert the
// wizard actually tells the user about it instead of just asserting a
// hardcoded string.
export const UPDATE_COMMAND = 'npm install -g google-tools-mcp@latest';

// ---------------------------------------------------------------------------
// Helpers
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
    exec(cmd, () => {});
}

function getConfigDir() {
    const xdg = process.env.XDG_CONFIG_HOME;
    const base = xdg || path.join(os.homedir(), '.config');
    const baseDir = path.join(base, 'google-tools-mcp');
    const profile = process.env.GOOGLE_MCP_PROFILE;
    return profile ? path.join(baseDir, profile) : baseDir;
}

function hasCli(name) {
    try {
        execSync(`${name} --version`, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function runCommand(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout);
        });
    });
}

function cancelled() {
    p.cancel('Setup cancelled.');
    process.exit(0);
}

// ---------------------------------------------------------------------------
// Fast-launch install
// ---------------------------------------------------------------------------
// `npx -y google-tools-mcp` re-resolves and verifies the whole dependency
// tree on every single launch. On some machines (observed on Windows, likely
// antivirus scanning of npm's file I/O during install/verify — this package
// pulls in fastmcp + the full googleapis client library tree) that takes
// 30+ seconds, even when the exact version is already cached. Claude Code's
// stdio MCP connection timeout is a fixed 30s, so that's enough to lose the
// race and surface as "the server won't connect" with no visible cause.
// See https://github.com/karthikcsq/google-tools-mcp/issues/46
//
// To avoid paying npx's per-launch cost on every server start, we install
// the package globally once here and point the MCP client directly at the
// resolved dist/index.js via `node`, skipping npx entirely afterward.

// Pure helper: where npm puts an installed package's files under a given
// global node_modules root. Exported for testing.
export function resolveGlobalIndexPath(globalRoot) {
    return path.join(globalRoot, 'google-tools-mcp', 'dist', 'index.js');
}

// Installs google-tools-mcp globally and resolves the absolute path to its
// dist/index.js so callers can launch it directly with `node`, bypassing
// npx. `run`/`access`/`hasNpm` are injectable for testing; they default to
// the real shell/filesystem/CLI-detection implementations.
export async function installGlobalFastLaunch({
    run = runCommand,
    access = fs.access,
    hasNpm = () => hasCli('npm'),
} = {}) {
    if (!hasNpm()) {
        return { ok: false, npmMissing: true, reason: 'npm was not found on PATH, so nothing can be installed globally.' };
    }

    try {
        await run('npm install -g google-tools-mcp@latest');
    } catch (err) {
        return { ok: false, reason: `npm install -g google-tools-mcp failed: ${err.message}` };
    }

    let globalRoot;
    try {
        globalRoot = (await run('npm root -g')).trim();
    } catch (err) {
        return { ok: false, reason: `could not resolve the npm global root: ${err.message}` };
    }

    const indexPath = resolveGlobalIndexPath(globalRoot);
    try {
        await access(indexPath);
    } catch {
        return { ok: false, reason: `installed globally, but dist/index.js was not found at ${indexPath}` };
    }

    return { ok: true, indexPath };
}

// Absolute path to the dist/index.js sitting next to this file, i.e. the copy
// of the package that is running setup right now. Used as the last fallback:
// wherever this wizard was launched from, that entry point demonstrably exists.
// Returns null if the URL can't be turned into a path, so a surprise here
// degrades to "no last-resort fallback" instead of crashing the wizard.
export function resolveRunningIndexPath(moduleUrl = import.meta.url) {
    try {
        return path.join(path.dirname(fileURLToPath(moduleUrl)), 'index.js');
    } catch {
        return null;
    }
}

// Builds the { command, args, shellDisplay, source } to launch the server with,
// given the result of installGlobalFastLaunch().
//
// Falling back to `npx` unconditionally would be wrong: on a standard Node
// installation npm and npx ship together, so "npm is not on PATH" almost always
// means npx is not either, and the wizard would finish happily after writing a
// launch command that cannot run. So the order is: the global install if it
// worked, then npx if npx actually exists, then the copy of the package running
// this wizard. Returns null when none of those is available, which the caller
// must report rather than write a broken config.
export function buildLaunchCommand(fastLaunch, {
    execPath = process.execPath,
    runningIndexPath = null,
    hasNpx = () => hasCli('npx'),
} = {}) {
    const direct = (indexPath, source) => ({
        command: execPath,
        args: [indexPath],
        shellDisplay: `"${execPath}" "${indexPath}"`,
        source,
    });

    if (fastLaunch?.ok) return direct(fastLaunch.indexPath, 'global');

    if (hasNpx()) {
        return {
            command: 'npx',
            args: ['-y', 'google-tools-mcp'],
            shellDisplay: 'npx -y google-tools-mcp',
            source: 'npx',
        };
    }

    if (runningIndexPath) return direct(runningIndexPath, 'running-copy');

    return null;
}

// Pull the GCP project number out of an OAuth client ID.
// Format: <project_number>-<hash>.apps.googleusercontent.com
function extractProjectNumberFromClientId(clientId) {
    const m = clientId.match(/^(\d+)-/);
    return m ? m[1] : null;
}

// Programmatically enable all required APIs in the user's project using the
// Service Usage API. Returns { ok: true } on success, or
// { ok: false, error } on failure (caller falls back to the manual URL).
async function enableApisProgrammatically(authClient, projectNumber) {
    const serviceUsage = google.serviceusage({ version: 'v1', auth: authClient });
    const batchRes = await serviceUsage.services.batchEnable({
        parent: `projects/${projectNumber}`,
        requestBody: { serviceIds: REQUIRED_APIS },
    });
    const opName = batchRes.data?.name;
    if (!opName) {
        // Some implementations return done synchronously.
        if (batchRes.data?.done) return { ok: true };
        return { ok: false, error: new Error('batchEnable returned no operation name') };
    }
    // Poll the long-running operation. Enabling 7 APIs usually completes in
    // 5-20s; we cap at 60s before giving up and falling back.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1500));
        const opRes = await serviceUsage.operations.get({ name: opName });
        if (opRes.data?.done) {
            if (opRes.data.error) {
                return { ok: false, error: new Error(opRes.data.error.message || 'operation failed') };
            }
            return { ok: true };
        }
    }
    return { ok: false, error: new Error('enable operation timed out after 60s') };
}

// ---------------------------------------------------------------------------
// Setup flow
// ---------------------------------------------------------------------------
export async function runSetup() {
    console.clear();

    p.intro(chalk.bgCyan.bold.white(' google-tools-mcp setup '));

    // ── Step 1: Project setup ────────────────────────────────────────────
    p.log.step(chalk.cyan.bold('Step 1') + chalk.dim(' · ') + 'Google Cloud project');
    p.log.message([
        chalk.dim('You need a Google Cloud project to host the OAuth client.'),
        chalk.green('If you don\'t have one yet, the next page (consent screen) will prompt you to create one.'),
        '',
        chalk.dim('APIs to be enabled (we\'ll do this automatically after authentication):'),
        chalk.dim('  ') + REQUIRED_APIS.map(a => chalk.yellow(a.replace('.googleapis.com', ''))).join(chalk.dim(', ')),
    ].join('\n'));

    const wantManualEnable = await p.confirm({
        message: 'Pre-enable APIs manually now? (advanced — recommended: NO, we\'ll auto-enable later)',
        active: 'yes, open manual page',
        inactive: 'no, skip',
        initialValue: false,
    });
    if (p.isCancel(wantManualEnable)) cancelled();
    if (wantManualEnable) {
        openBrowser(ENABLE_APIS_URL);
        p.log.message(chalk.dim(ENABLE_APIS_URL));
        const manualDone = await p.confirm({
            message: 'Done with manual enable?',
            active: 'yes, continue',
            inactive: 'not yet',
        });
        if (p.isCancel(manualDone)) cancelled();
    }

    // ── Step 2: OAuth consent screen ─────────────────────────────────────
    p.log.step(chalk.cyan.bold('Step 2') + chalk.dim(' · ') + 'Configure OAuth consent screen');
    p.log.message([
        chalk.dim('Google has two versions of this UI — both lead to the same place:'),
        '',
        chalk.bold('New UI ("Google Auth Platform"):'),
        `${chalk.white('›')} Click ${chalk.bold('"Get started"')} if prompted`,
        `${chalk.white('›')} App name: anything ${chalk.dim('(e.g. "MCP")')}, support email: your own`,
        `${chalk.white('›')} Audience: choose ${chalk.bold('"External"')}`,
        `${chalk.white('›')} Click ${chalk.bold('Create')} / ${chalk.bold('Save and continue')} through each section`,
        '',
        chalk.bold('Old UI (wizard):'),
        `${chalk.white('›')} User type: ${chalk.bold('"External"')}`,
        `${chalk.white('›')} App name: anything ${chalk.dim('(e.g. "MCP")')}`,
        `${chalk.white('›')} Click ${chalk.bold('Save and continue')} through Scopes (skip), then finish`,
        '',
        chalk.yellow('We will add your email as a test user in the NEXT step — don\'t worry about that here yet.'),
    ].join('\n'));

    const ready2 = await p.confirm({
        message: 'Ready? This will open your browser.',
        active: 'open browser',
        inactive: 'not yet',
    });
    if (p.isCancel(ready2)) cancelled();
    openBrowser(CONSENT_SCREEN_URL);
    p.log.message(chalk.dim(CONSENT_SCREEN_URL));

    const step2 = await p.confirm({
        message: 'Done configuring consent screen?',
        active: 'yes, continue',
        inactive: 'not yet',
    });
    if (p.isCancel(step2)) cancelled();

    // ── Step 2b: Add test user ───────────────────────────────────────────
    p.log.step(chalk.cyan.bold('Step 2b') + chalk.dim(' · ') + 'Set audience to External + add test user');
    p.log.message([
        chalk.yellow.bold('This step is the #1 cause of "Access blocked / app not verified" errors later.'),
        '',
        chalk.bold('On the Audience page, do BOTH of these:'),
        '',
        chalk.bold('1. Set User type to ') + chalk.bold.cyan('"External"'),
        chalk.dim('   If it\'s currently "Internal" or unset, click ') + chalk.bold('"Make external"') + chalk.dim(' / change it to External.'),
        chalk.dim('   (Internal only works for Google Workspace orgs and will block personal Gmail accounts.)'),
        '',
        chalk.bold('2. Add yourself under ') + chalk.bold.cyan('"Test users"'),
        `   ${chalk.white('›')} New UI: scroll down on the ${chalk.bold('Audience')} page → ${chalk.bold('Test users')} → ${chalk.bold('+ Add users')}`,
        `   ${chalk.white('›')} Old UI: OAuth consent screen page → ${chalk.bold('Test users')} section → ${chalk.bold('+ Add users')}`,
        '',
        chalk.bold.red('CRITICAL: '),
        chalk.red('The email you add must EXACTLY match the Google account you\'ll sign in with in Step 4.'),
        chalk.dim('(e.g. if you sign in as you@gmail.com, add you@gmail.com — not a work alias)'),
    ].join('\n'));

    const authEmail = await p.text({
        message: 'Which Google account will you authenticate with?',
        placeholder: 'you@gmail.com',
        validate: (v) => {
            if (!v?.trim()) return 'Required — we need this so you can confirm it matches the test user';
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) return 'Doesn\'t look like an email address';
        },
    });
    if (p.isCancel(authEmail)) cancelled();
    const authEmailTrimmed = authEmail.trim();

    p.log.message(chalk.bold(`→ Add ${chalk.cyan(authEmailTrimmed)} to the Test users list now.`));

    const ready2b = await p.confirm({
        message: 'Ready? This opens the Audience page directly.',
        active: 'open browser',
        inactive: 'not yet',
    });
    if (p.isCancel(ready2b)) cancelled();
    openBrowser(AUDIENCE_URL);
    p.log.message(chalk.dim(AUDIENCE_URL));
    p.log.message(chalk.dim('If that page doesn\'t show Test users, try: ') + chalk.dim(CONSENT_SCREEN_URL));

    const step2b = await p.confirm({
        message: `Confirmed: audience is External AND ${authEmailTrimmed} is in the Test users list.`,
        active: 'yes, both done',
        inactive: 'not yet',
    });
    if (p.isCancel(step2b)) cancelled();

    // ── Step 3: Create OAuth credentials ─────────────────────────────────
    p.log.step(chalk.cyan.bold('Step 3') + chalk.dim(' · ') + 'Create OAuth Client ID');
    p.log.message([
        `${chalk.white('›')} Select ${chalk.bold('"Desktop application"')} as the type`,
        `${chalk.white('›')} Click ${chalk.bold('Create')}`,
        `${chalk.white('›')} Copy the ${chalk.bold('Client ID')} and ${chalk.bold('Client Secret')}`,
    ].join('\n'));

    const ready3 = await p.confirm({
        message: 'Ready? This will open your browser.',
        active: 'open browser',
        inactive: 'not yet',
    });
    if (p.isCancel(ready3)) cancelled();
    openBrowser(CREATE_CREDENTIALS_URL);
    p.log.message(chalk.dim(CREATE_CREDENTIALS_URL));

    const credentials = await p.group({
        clientId: () => p.text({
            message: 'Client ID',
            placeholder: 'xxxx.apps.googleusercontent.com',
            validate: (v) => {
                if (!v?.trim()) return 'Client ID is required';
            },
        }),
        clientSecret: () => p.text({
            message: 'Client Secret',
            placeholder: 'GOCSPX-xxxx',
            validate: (v) => {
                if (!v?.trim()) return 'Client Secret is required';
            },
        }),
    });
    if (p.isCancel(credentials)) cancelled();

    const clientId = credentials.clientId.trim();
    const clientSecret = credentials.clientSecret.trim();

    // ── Save credentials ─────────────────────────────────────────────────
    const configDir = getConfigDir();
    await fs.mkdir(configDir, { recursive: true });
    const envPath = path.join(configDir, '.env');
    const envContent = `GOOGLE_CLIENT_ID=${clientId}\nGOOGLE_CLIENT_SECRET=${clientSecret}\n`;
    await fs.writeFile(envPath, envContent);
    const displayPath = envPath.replace(os.homedir(), '~');
    p.log.success(`Credentials saved to ${chalk.dim(displayPath)}`);

    // ── Step 4: Authenticate ─────────────────────────────────────────────
    p.log.step(chalk.cyan.bold('Step 4') + chalk.dim(' · ') + 'Authenticate with Google');
    p.log.message([
        'Opening browser for OAuth consent...',
        chalk.dim(`Sign in as ${chalk.bold(authEmailTrimmed)} (the test user you added in Step 2b).`),
    ].join('\n'));

    process.env.GOOGLE_CLIENT_ID = clientId;
    process.env.GOOGLE_CLIENT_SECRET = clientSecret;

    const { runAuthFlow } = await import('./auth.js');
    let authClient = null;
    try {
        authClient = await runAuthFlow();
    } catch (err) {
        const msg = err?.message || String(err);
        const looksLikeAccessBlocked =
            /access_denied|access blocked|not.*verified|has not completed.*verification|test users/i.test(msg);
        if (looksLikeAccessBlocked) {
            p.log.error(chalk.red.bold('Auth failed — likely test user mismatch.'));
            p.log.message([
                chalk.red('Google blocked the sign-in. This almost always means:'),
                `${chalk.white('›')} The email you signed in with isn't in the Test users list, OR`,
                `${chalk.white('›')} You added a different email than the one you actually signed in with`,
                '',
                `${chalk.bold('Fix:')} go back to ${chalk.cyan(AUDIENCE_URL)}, confirm ${chalk.cyan(authEmailTrimmed)} is listed under Test users, then re-run setup.`,
                '',
                chalk.dim('Original error: ') + chalk.dim(msg),
            ].join('\n'));
        }
        throw err;
    }

    p.log.success('Authenticated with Google!');

    // ── Step 4b: Auto-enable APIs ────────────────────────────────────────
    p.log.step(chalk.cyan.bold('Step 4b') + chalk.dim(' · ') + 'Enabling Google APIs in your project');
    const projectNumber = extractProjectNumberFromClientId(clientId);
    if (!projectNumber) {
        p.log.warn('Could not parse project number from Client ID — falling back to manual enable.');
        openBrowser(ENABLE_APIS_URL);
        p.log.message(chalk.dim('Manually enable APIs at: ') + chalk.dim(ENABLE_APIS_URL));
        const fallback = await p.confirm({
            message: 'Done enabling APIs manually?',
            active: 'yes, continue',
            inactive: 'not yet',
        });
        if (p.isCancel(fallback)) cancelled();
    } else if (!authClient) {
        p.log.warn('Auth client unavailable — falling back to manual enable.');
        openBrowser(ENABLE_APIS_URL);
        const fallback = await p.confirm({
            message: 'Done enabling APIs manually?',
            active: 'yes, continue',
            inactive: 'not yet',
        });
        if (p.isCancel(fallback)) cancelled();
    } else {
        const s = p.spinner();
        s.start(`Enabling ${REQUIRED_APIS.length} APIs in project ${projectNumber}...`);
        try {
            const result = await enableApisProgrammatically(authClient, projectNumber);
            if (result.ok) {
                s.stop(chalk.green(`Enabled ${REQUIRED_APIS.length} APIs in project ${projectNumber}`));
                p.log.message(chalk.dim('(May take ~30s to propagate. The server will auto-open the enable page if any API is still disabled when you first use it.)'));
            } else {
                s.stop(chalk.yellow('Auto-enable failed — falling back to manual.'));
                p.log.warn(`Error: ${result.error?.message || result.error}`);
                openBrowser(ENABLE_APIS_URL);
                p.log.message(chalk.dim('Open: ') + chalk.dim(ENABLE_APIS_URL));
                const fallback = await p.confirm({
                    message: 'Done enabling APIs manually?',
                    active: 'yes, continue',
                    inactive: 'not yet',
                });
                if (p.isCancel(fallback)) cancelled();
            }
        } catch (err) {
            s.stop(chalk.yellow('Auto-enable failed — falling back to manual.'));
            p.log.warn(`Error: ${err.message || err}`);
            openBrowser(ENABLE_APIS_URL);
            p.log.message(chalk.dim('Open: ') + chalk.dim(ENABLE_APIS_URL));
            const fallback = await p.confirm({
                message: 'Done enabling APIs manually?',
                active: 'yes, continue',
                inactive: 'not yet',
            });
            if (p.isCancel(fallback)) cancelled();
        }
    }

    // ── Step 5: Install ──────────────────────────────────────────────────
    p.log.step(chalk.cyan.bold('Step 5') + chalk.dim(' · ') + 'Install MCP server');
    p.log.message(chalk.dim(
        'Installing globally so your MCP client launches google-tools-mcp directly ' +
        'instead of through npx — npx re-resolves the whole dependency tree on every ' +
        'launch, which can take 30+ seconds on some machines and lose the race against ' +
        "Claude Code's 30s connection timeout (github.com/karthikcsq/google-tools-mcp/issues/46)."
    ));

    const installSpinner = p.spinner();
    installSpinner.start('Installing google-tools-mcp globally...');
    const fastLaunch = await installGlobalFastLaunch();

    // Last-resort launch target: the copy of the package running this wizard.
    // Only offered if it is really there, so we never write a path we haven't
    // confirmed.
    let runningIndexPath = resolveRunningIndexPath();
    try {
        await fs.access(runningIndexPath);
    } catch {
        runningIndexPath = null;
    }

    const launch = buildLaunchCommand(fastLaunch, { runningIndexPath });

    if (fastLaunch.ok) {
        installSpinner.stop(chalk.green('Installed globally — MCP clients will launch it directly via node.'));
        p.log.message(chalk.dim(
            'Note: unlike npx, this direct launch path does not auto-update. The server checks for new ' +
            'releases at startup and will log a line if one is available, without slowing down connection. ' +
            `To update whenever you like, run: `
        ) + chalk.cyan(UPDATE_COMMAND));
    } else if (!launch) {
        installSpinner.stop(chalk.red('Could not work out any way to launch the server on this machine.'));
        p.log.warn(fastLaunch.reason);
        p.log.error(
            'No global install, no npx on PATH, and no readable entry point next to this wizard. ' +
            'Install Node.js with npm from nodejs.org, or install this package yourself with ' +
            '`npm install -g google-tools-mcp`, then run setup again. Nothing was written to your MCP client config.'
        );
        process.exit(1);
    } else if (launch.source === 'npx') {
        installSpinner.stop(chalk.yellow('Global install failed — falling back to npx (slower; can hit connection timeouts).'));
        p.log.warn(fastLaunch.reason);
        p.log.message(chalk.dim('See the README troubleshooting section if the MCP server fails to connect.'));
    } else {
        installSpinner.stop(chalk.yellow('Global install failed and npx is not on PATH — pointing at this copy of the package instead.'));
        p.log.warn(fastLaunch.reason);
        p.log.message(chalk.dim(
            `Your MCP client will launch ${runningIndexPath} directly. That works as long as this copy stays ` +
            'where it is; if it was run from a temporary npx cache, install the package properly and run setup again.'
        ));
        p.log.message(chalk.dim(
            'This path does not auto-update either. Once npm is available, run: '
        ) + chalk.cyan(UPDATE_COMMAND) + chalk.dim(' to update, or re-run this wizard.'));
    }

    const hasCodex = hasCli('codex');
    const hasClaude = hasCli('claude');
    if (hasCodex) {
        const install = await p.confirm({
            message: 'Add to Codex as an MCP server?',
            active: 'yes',
            inactive: 'no',
            initialValue: true,
        });
        if (p.isCancel(install)) cancelled();

        const codexAddCmd = `codex mcp add google -- ${launch.shellDisplay}`;
        if (install) {
            const s = p.spinner();
            s.start('Adding to Codex...');
            try {
                await runCommand(codexAddCmd);
                s.stop('Added to Codex!');
            } catch (err) {
                s.stop('Failed to add automatically');
                p.log.warn(`Error: ${err.message}`);
                p.log.message(`Run manually:\n${chalk.cyan(codexAddCmd)}`);
            }
        } else {
            p.log.message(`To add later:\n${chalk.cyan(codexAddCmd)}`);
        }
    }

    if (hasClaude) {
        const install = await p.confirm({
            message: 'Add to Claude Code as a user-scope MCP server?',
            active: 'yes',
            inactive: 'no',
            initialValue: true,
        });
        if (p.isCancel(install)) cancelled();

        const claudeAddCmd = `claude mcp add -s user google -- ${launch.shellDisplay}`;
        if (install) {
            const s = p.spinner();
            s.start('Adding to Claude Code...');
            try {
                await runCommand(claudeAddCmd);
                s.stop('Added to Claude Code!');
            } catch (err) {
                s.stop('Failed to add automatically');
                p.log.warn(`Error: ${err.message}`);
                p.log.message(`Run manually:\n${chalk.cyan(claudeAddCmd)}`);
            }
        } else {
            p.log.message(`To add later:\n${chalk.cyan(claudeAddCmd)}`);
        }
    }

    if (!hasCodex && !hasClaude) {
        const jsonSnippet = JSON.stringify({
            mcpServers: { google: { command: launch.command, args: launch.args } },
        });
        p.log.message([
            'Add to your MCP client:',
            '',
            chalk.dim('Codex:'),
            chalk.cyan(`  codex mcp add google -- ${launch.shellDisplay}`),
            '',
            chalk.dim('Claude Code:'),
            chalk.cyan(`  claude mcp add -s user google -- ${launch.shellDisplay}`),
            '',
            chalk.dim('Other clients') + chalk.dim(' (.mcp.json):'),
            chalk.cyan(`  ${jsonSnippet}`),
        ].join('\n'));
    }

    p.outro(chalk.green.bold('Setup complete!') + chalk.dim(' You\'re ready to use google-tools-mcp.'));
}
