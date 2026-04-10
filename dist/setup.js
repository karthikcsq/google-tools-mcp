// Guided setup wizard for google-tools-mcp.
// Rich terminal UI using @clack/prompts.
import * as p from '@clack/prompts';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec, execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const APIS = [
    'docs.googleapis.com',
    'sheets.googleapis.com',
    'drive.googleapis.com',
    'gmail.googleapis.com',
    'calendar-json.googleapis.com',
    'forms.googleapis.com',
    'slides.googleapis.com',
];

const ENABLE_APIS_URL =
    `https://console.cloud.google.com/flows/enableapi?apiid=${APIS.join(',')}`;

const CREATE_CREDENTIALS_URL =
    'https://console.cloud.google.com/apis/credentials/oauthclient';

const CONSENT_SCREEN_URL =
    'https://console.cloud.google.com/apis/credentials/consent';

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
// Setup flow
// ---------------------------------------------------------------------------
export async function runSetup() {
    console.clear();

    p.intro(chalk.bgCyan.bold.white(' google-tools-mcp setup '));

    // ── Step 1: Enable APIs ──────────────────────────────────────────────
    p.log.step(chalk.cyan.bold('Step 1') + chalk.dim(' · ') + 'Enable Google APIs');
    p.log.message([
        'This will open Google Cloud Console to enable all required APIs.',
        chalk.dim('If you don\'t have a project yet, it will ask you to create one.'),
        '',
        chalk.dim('APIs: ') + APIS.map(a => chalk.yellow(a.replace('.googleapis.com', ''))).join(chalk.dim(', ')),
    ].join('\n'));

    const ready1 = await p.confirm({
        message: 'Ready? This will open your browser.',
        active: 'open browser',
        inactive: 'not yet',
    });
    if (p.isCancel(ready1)) cancelled();
    openBrowser(ENABLE_APIS_URL);
    p.log.message(chalk.dim(ENABLE_APIS_URL));

    const step1 = await p.confirm({
        message: 'Done enabling APIs?',
        active: 'yes, continue',
        inactive: 'not yet',
    });
    if (p.isCancel(step1)) cancelled();

    // ── Step 2: OAuth consent screen ─────────────────────────────────────
    p.log.step(chalk.cyan.bold('Step 2') + chalk.dim(' · ') + 'Configure OAuth consent screen');
    p.log.message([
        `${chalk.white('›')} Choose ${chalk.bold('"External"')} for the user type`,
        `${chalk.white('›')} Fill in the app name ${chalk.dim('(anything works, e.g. "MCP")')}`,
        `${chalk.white('›')} Add your email as a ${chalk.bold('test user')}`,
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
    p.log.message('Opening browser for OAuth consent...');

    process.env.GOOGLE_CLIENT_ID = clientId;
    process.env.GOOGLE_CLIENT_SECRET = clientSecret;

    const { runAuthFlow } = await import('./auth.js');
    await runAuthFlow();

    p.log.success('Authenticated with Google!');

    // ── Step 5: Install ──────────────────────────────────────────────────
    p.log.step(chalk.cyan.bold('Step 5') + chalk.dim(' · ') + 'Install MCP server');

    const hasClaude = hasCli('claude');
    if (hasClaude) {
        const install = await p.confirm({
            message: 'Add to Claude Code as a user-scope MCP server?',
            active: 'yes',
            inactive: 'no',
            initialValue: true,
        });
        if (p.isCancel(install)) cancelled();

        if (install) {
            const s = p.spinner();
            s.start('Adding to Claude Code...');
            try {
                await runCommand('claude mcp add -s user google -- npx -y google-tools-mcp');
                s.stop('Added to Claude Code!');
            } catch (err) {
                s.stop('Failed to add automatically');
                p.log.warn(`Error: ${err.message}`);
                p.log.message(`Run manually:\n${chalk.cyan('claude mcp add -s user google -- npx -y google-tools-mcp')}`);
            }
        } else {
            p.log.message(`To add later:\n${chalk.cyan('claude mcp add -s user google -- npx -y google-tools-mcp')}`);
        }
    } else {
        p.log.message([
            'Add to your MCP client:',
            '',
            chalk.dim('Claude Code:'),
            chalk.cyan('  claude mcp add -s user google -- npx -y google-tools-mcp'),
            '',
            chalk.dim('Other clients') + chalk.dim(' (.mcp.json):'),
            chalk.cyan('  { "mcpServers": { "google": { "command": "npx", "args": ["-y", "google-tools-mcp"] } } }'),
        ].join('\n'));
    }

    p.outro(chalk.green.bold('Setup complete!') + chalk.dim(' You\'re ready to use google-tools-mcp.'));
}
