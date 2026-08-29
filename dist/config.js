// Shared startup configuration for google-tools-mcp.
//
// This module deliberately has no imports that read process.env. It is loaded
// before the rest of the server so file configuration is visible to every
// startup consumer, including the logger and transport selection.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const projectRootDir = path.resolve(path.dirname(__filename), '..');

// Profiles choose separate persistent directories. This snapshot must be made
// before loading files, so a config file cannot move a running process between
// profiles after another consumer has already selected its paths.
const xdgConfigHome = process.env.XDG_CONFIG_HOME;
const configuredProfile = process.env.GOOGLE_MCP_PROFILE;
const configBaseDir = path.join(xdgConfigHome || path.join(os.homedir(), '.config'), 'google-tools-mcp');

// GOOGLE_MCP_PROFILE selects a subdirectory of configBaseDir -- it is a
// profile identifier, not a filesystem path. Every writer that touches
// getConfigDir() (logging, HTTP state/token persistence, OAuth token storage)
// mkdir/chmod's that directory, so an unchecked ".." here could move those
// operations outside ~/.config/google-tools-mcp entirely and chmod/write an
// unrelated directory the operator never chose (finding 14). Reject path
// separators, ".", "..", and absolute paths outright, then defend in depth by
// requiring the resolved directory to still be a direct child of
// configBaseDir. This throws at module load, which is the first thing
// dist/index.js imports, so an unsafe profile fails startup before any file
// is touched rather than silently escaping.
function validateProfile(rawProfile) {
    if (rawProfile === undefined) return undefined;
    const profile = String(rawProfile).trim();
    if (!profile) return undefined;
    if (path.isAbsolute(profile) || /[\\/]/.test(profile) || profile === '.' || profile === '..') {
        throw new Error(`Invalid GOOGLE_MCP_PROFILE ${JSON.stringify(rawProfile)}: must be a plain directory name with no path separators and not "." or "..".`);
    }
    const resolvedDir = path.resolve(configBaseDir, profile);
    if (path.dirname(resolvedDir) !== path.resolve(configBaseDir)) {
        throw new Error(`Invalid GOOGLE_MCP_PROFILE ${JSON.stringify(rawProfile)}: must resolve to a direct child of the config directory.`);
    }
    return profile;
}

const validatedProfile = validateProfile(configuredProfile);
const configDir = validatedProfile ? path.join(configBaseDir, validatedProfile) : configBaseDir;
const configFiles = [...new Set([
    path.join(configDir, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(projectRootDir, '.env'),
])];
const loadedConfigFiles = [];
const configWarnings = [];
const loadedConfigKeys = new Set();
let filesLoaded = false;

export function getConfigDir() {
    return configDir;
}

export function getConfigFiles() {
    return [...configFiles];
}

export function getLoadedConfigFiles() {
    return [...loadedConfigFiles];
}
export function getConfigWarnings() { return [...configWarnings]; }
export function getLoadedConfigKeys() { return [...loadedConfigKeys]; }

export function getDefaultLogPath() {
    return path.join(configDir, 'server.log');
}

export function getDefaultJsonlPath() {
    return path.join(configDir, 'server.jsonl');
}

function warn(message) {
    configWarnings.push(message);
    process.stderr.write(`WARNING: ${message}\n`);
}

// dist/index.js imports this module first and reads its result before
// selecting a transport or resolving HTTP auth, so any key loaded here can
// change startup security/lifecycle behavior. The user config directory
// (configDir/.env) is a tier the operator explicitly chose -- selected via
// XDG_CONFIG_HOME / GOOGLE_MCP_PROFILE in the real process environment, both
// snapshotted before any file is read. process.cwd()/.env and the
// package-root .env are a materially lower trust boundary: cwd is wherever
// the operator happened to launch the client from (often a cloned repository
// they do not control), and the package root ships with the installed
// package. A repository's own .env choosing to run this MCP server over
// unauthenticated HTTP, or on a transport/port the operator never chose, is
// not something opening or npx-ing that repository should be able to do
// silently (finding 17). These keys are therefore accepted only from the
// user config directory or the real process environment, never from cwd or
// package-root config files.
const RESTRICTED_CONFIG_KEYS = new Set([
    'GOOGLE_MCP_TRANSPORT',
    'GOOGLE_MCP_HTTP_NO_AUTH',
    'GOOGLE_MCP_HTTP_HOST',
    'GOOGLE_MCP_HTTP_ALLOWED_ORIGINS',
    'GOOGLE_MCP_HTTP_TOKEN',
    'GOOGLE_MCP_PORT',
    'GOOGLE_MCP_ENDPOINT',
    'GOOGLE_MCP_LOG_FILE',
    'GOOGLE_MCP_JSONL_FILE',
    'GOOGLE_MCP_OAUTH_PORT',
    'SERVICE_ACCOUNT_PATH',
    'GOOGLE_IMPERSONATE_USER',
]);
const trustedConfigFile = path.join(configDir, '.env');

export function loadEnvFile(filePath) {
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            warn(`Unable to read config file ${filePath} (${error?.code || 'unknown error'}).`);
        }
        return false;
    }

    const trusted = path.resolve(filePath) === path.resolve(trustedConfigFile);
    for (const [lineIndex, line] of content.split('\n').entries()) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        const keyCandidate = eqIdx === -1 ? '' : trimmed.slice(0, eqIdx).trim();
        if (eqIdx === -1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyCandidate)) {
            warn(`Malformed config line ${filePath}:${lineIndex + 1}; expected KEY=VALUE.`);
            continue;
        }
        const key = keyCandidate;
        let value = trimmed.slice(eqIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key === 'GOOGLE_MCP_PROFILE') {
            warn(`Ignoring GOOGLE_MCP_PROFILE in config file ${filePath}; set it in the process environment instead.`);
            continue;
        }
        if (!trusted && RESTRICTED_CONFIG_KEYS.has(key)) {
            warn(`Ignoring ${key} in lower-trust config file ${filePath}; security and lifecycle settings are only accepted from ${trustedConfigFile} or the process environment.`);
            continue;
        }
        // A defined environment value, including an intentional empty string,
        // always wins over config files.
        if (process.env[key] === undefined) {
            process.env[key] = value;
            loadedConfigKeys.add(key);
        }
    }
    return true;
}

export function loadConfigFiles() {
    if (filesLoaded) return getLoadedConfigFiles();
    filesLoaded = true;
    for (const filePath of configFiles) {
        if (loadEnvFile(filePath)) loadedConfigFiles.push(filePath);
    }
    return getLoadedConfigFiles();
}

loadConfigFiles();
