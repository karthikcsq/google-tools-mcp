// Guided setup wizard for google-tools-mcp.
// Opens the right Google Cloud Console URLs and saves credentials.
import * as readline from 'readline';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';

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

function prompt(rl, question) {
    return new Promise((resolve) => rl.question(question, resolve));
}

function getConfigDir() {
    const xdg = process.env.XDG_CONFIG_HOME;
    const base = xdg || path.join(os.homedir(), '.config');
    const baseDir = path.join(base, 'google-tools-mcp');
    const profile = process.env.GOOGLE_MCP_PROFILE;
    return profile ? path.join(baseDir, profile) : baseDir;
}

// ---------------------------------------------------------------------------
// Setup flow
// ---------------------------------------------------------------------------
export async function runSetup() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    console.log('\n🔧 google-tools-mcp setup\n');

    // Step 1: Enable APIs
    console.log('Step 1: Enable Google APIs');
    console.log('─────────────────────────');
    console.log('Opening Google Cloud Console to enable all required APIs.');
    console.log('If you don\'t have a project yet, it will ask you to create one.\n');
    openBrowser(ENABLE_APIS_URL);
    await prompt(rl, 'Press Enter when done...');

    // Step 2: OAuth consent screen
    console.log('\nStep 2: Configure OAuth consent screen');
    console.log('──────────────────────────────────────');
    console.log('Opening the OAuth consent screen configuration.');
    console.log('  • Choose "External" for the user type');
    console.log('  • Fill in the app name (anything is fine, e.g. "MCP")');
    console.log('  • Add your email as a test user\n');
    openBrowser(CONSENT_SCREEN_URL);
    await prompt(rl, 'Press Enter when done...');

    // Step 3: Create OAuth credentials
    console.log('\nStep 3: Create OAuth Client ID');
    console.log('──────────────────────────────');
    console.log('Opening the credentials page.');
    console.log('  • Select "Desktop application" as the type');
    console.log('  • Click Create, then copy the Client ID and Client Secret\n');
    openBrowser(CREATE_CREDENTIALS_URL);
    await prompt(rl, 'Press Enter when you have your Client ID and Secret...');

    // Step 4: Collect credentials
    console.log('');
    const clientId = (await prompt(rl, 'Client ID: ')).trim();
    const clientSecret = (await prompt(rl, 'Client Secret: ')).trim();

    if (!clientId || !clientSecret) {
        rl.close();
        throw new Error('Client ID and Client Secret are required.');
    }

    // Save to config dir
    const configDir = getConfigDir();
    await fs.mkdir(configDir, { recursive: true });
    const envPath = path.join(configDir, '.env');
    const envContent = `GOOGLE_CLIENT_ID=${clientId}\nGOOGLE_CLIENT_SECRET=${clientSecret}\n`;
    await fs.writeFile(envPath, envContent);
    const displayPath = envPath.replace(os.homedir(), '~');
    console.log(`\nCredentials saved to ${displayPath}`);

    // Step 5: Run OAuth flow
    console.log('\nStep 4: Authenticate with Google');
    console.log('────────────────────────────────');
    console.log('Opening browser for OAuth consent...\n');
    rl.close();

    // Set env vars so auth picks them up immediately
    process.env.GOOGLE_CLIENT_ID = clientId;
    process.env.GOOGLE_CLIENT_SECRET = clientSecret;

    const { runAuthFlow } = await import('./auth.js');
    await runAuthFlow();

    console.log('\n✅ Setup complete! You\'re ready to use google-tools-mcp.');
    console.log('\nAdd it to Claude Code:');
    console.log('  claude mcp add -s user google -- npx -y google-tools-mcp\n');
}
