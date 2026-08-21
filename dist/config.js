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
const configDir = configuredProfile ? path.join(configBaseDir, configuredProfile) : configBaseDir;
const configFiles = [...new Set([
    path.join(configDir, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(projectRootDir, '.env'),
])];
const loadedConfigFiles = [];
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

export function getDefaultLogPath() {
    return path.join(configDir, 'server.log');
}

function warn(message) {
    process.stderr.write(`WARNING: ${message}\n`);
}

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

    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key === 'GOOGLE_MCP_PROFILE') {
            warn(`Ignoring GOOGLE_MCP_PROFILE in config file ${filePath}; set it in the process environment instead.`);
            continue;
        }
        // A defined environment value, including an intentional empty string,
        // always wins over config files.
        if (process.env[key] === undefined) {
            process.env[key] = value;
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
