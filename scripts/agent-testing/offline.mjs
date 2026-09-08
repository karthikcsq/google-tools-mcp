/**
 * Install the credential-free Google Workspace backend used by agent tests.
 *
 * Call this before importing any dist module.  The custom loader substitutes
 * only this checkout's dist/clients.js, so production imports and packaging
 * remain unchanged.
 */
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import {
    configureOfflineBackend,
    getOfflineBackendStatus,
    OFFLINE_LIMITATIONS,
} from './offline-clients.mjs';

let installed = null;

function nonEmptyString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${name} must be a non-empty string.`);
    }
    return value;
}

/**
 * Redirect production client imports to an in-memory implementation.
 *
 * @param {{ folderId?: string, workspaceDir: string }} options
 * @returns {Promise<{ backend: 'offline', folderId: string, limitations: string[] }>}
 */
export async function installOfflineBackend({
    folderId = 'agent_test_root',
    workspaceDir,
} = {}) {
    nonEmptyString(folderId, 'folderId');
    nonEmptyString(workspaceDir, 'workspaceDir');

    if (installed) {
        if (installed.folderId !== folderId || installed.workspaceDir !== workspaceDir) {
            throw new Error(
                'Offline backend is already installed for this process. Start a new process for an isolated session.',
            );
        }
        return installed.metadata;
    }

    // Keep helpers such as workspace.js and logger.js away from the user's
    // normal config directory. These values are set before the first dist
    // import, and all paths remain under the caller's run-scoped workspace.
    process.env.GOOGLE_MCP_WORKSPACE_DIR = workspaceDir;
    process.env.XDG_CONFIG_HOME = path.join(workspaceDir, '.offline-config');
    configureOfflineBackend({ folderId, workspaceDir });
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const repositoryRoot = path.resolve(moduleDirectory, '..', '..');
    const targetClientsUrl = pathToFileURL(path.join(repositoryRoot, 'dist', 'clients.js')).href;
    const offlineClientsUrl = pathToFileURL(path.join(moduleDirectory, 'offline-clients.mjs')).href;

    register(new URL('./offline-loader.mjs', import.meta.url), {
        parentURL: import.meta.url,
        data: { targetClientsUrl, offlineClientsUrl },
    });

    const metadata = {
        backend: 'offline',
        folderId,
        limitations: [...OFFLINE_LIMITATIONS],
    };
    installed = { folderId, workspaceDir, metadata };
    return metadata;
}

export { getOfflineBackendStatus };
