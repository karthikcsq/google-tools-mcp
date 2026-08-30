// Trust-boundary tests for PR #109 review finding 3818096403: arbitrary caught
// error text must never be promoted to a caller-visible PublicToolError.
//
// The redactor in dist/errors.js removes registered secrets and labeled
// credential patterns, but it cannot remove an internal diagnostic that is not
// secret-shaped -- a filesystem path, a Google Cloud project number, a resolved
// host. Those only stay server-side if the caught text is never interpolated
// into a public message in the first place. These tests pin both halves of that
// rule: generic caught text becomes an internal OperationError, while a
// structured, validated field from a known Google API error shape still
// reaches the caller.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// A path-like internal diagnostic. Nothing about it is secret-shaped, so the
// redactor would happily pass it through to a caller if a public message
// carried it.
const LEAKY_PATH = 'C:\\Users\\someone\\AppData\\Roaming\\google-tools-mcp\\token.json';

let authorizeImpl = async () => ({ setCredentials() {}, on() {} });
const presentationsGet = jest.fn();
const permissionsCreate = jest.fn();

jest.unstable_mockModule('../dist/auth.js', () => ({
    authorize: (...args) => authorizeImpl(...args),
    runAuthFlow: async () => {},
    getTokenPath: () => LEAKY_PATH,
    getConfigDir: () => 'C:/fake-config',
    SCOPES: [],
}));

jest.unstable_mockModule('googleapis', () => ({
    google: {
        slides: () => ({ presentations: { get: presentationsGet } }),
        docs: () => ({}),
        drive: () => ({ permissions: { create: permissionsCreate } }),
        sheets: () => ({}),
        script: () => ({}),
        gmail: () => ({}),
        calendar: () => ({}),
        forms: () => ({}),
        tasks: () => ({}),
    },
}));

const { resetClients, initializeGoogleClient, getSlidesClient } = await import('../dist/clients.js');
const { executeBatchUpdate } = await import('../dist/googleDocsApiHelpers.js');
const { readRange, createTableHelper } = await import('../dist/googleSheetsApiHelpers.js');
const { register: registerGetPresentation } = await import('../dist/tools/slides/getPresentation.js');
const { register: registerAddPermission } = await import('../dist/tools/drive/addPermission.js');

const log = { info() {}, error() {}, warn() {}, debug() {} };

function createServer() {
    const tools = new Map();
    return {
        addTool(tool) { tools.set(tool.name, tool); },
        getTool(name) { return tools.get(name); },
    };
}

async function capture(promise) {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('expected the call to reject');
}

beforeEach(() => {
    resetClients();
    presentationsGet.mockReset();
    permissionsCreate.mockReset();
    authorizeImpl = async () => ({ setCredentials() {}, on() {} });
});

describe('auth failures surface a fixed template, never the caught text', () => {
    it('drops an unclassifiable auth error entirely', async () => {
        authorizeImpl = async () => {
            throw new Error(`EACCES: permission denied, open '${LEAKY_PATH}'`);
        };

        const error = await capture(initializeGoogleClient());

        expect(error.message).not.toContain(LEAKY_PATH);
        expect(error.message).not.toContain('EACCES');
        expect(error.message).not.toContain('Details:');
        expect(error.message).toContain('npx google-tools-mcp auth');
        // No classification matched, so no cause line is offered at all.
        expect(error.message).not.toContain('Cause:');
    });

    it('maps a known invalid_grant failure to its constant guidance', async () => {
        authorizeImpl = async () => {
            throw new Error(`invalid_grant: token revoked (from ${LEAKY_PATH})`);
        };

        const error = await capture(initializeGoogleClient());

        expect(error.message).not.toContain(LEAKY_PATH);
        expect(error.message).not.toContain('token revoked');
        expect(error.message).toContain('expired or been revoked');
    });

    it('maps a callback-port collision by Node error code, not by message text', async () => {
        authorizeImpl = async () => {
            throw Object.assign(new Error(`listen EADDRINUSE: address already in use 127.0.0.1:${43117}`), {
                code: 'EADDRINUSE',
            });
        };

        const error = await capture(initializeGoogleClient());

        expect(error.message).not.toContain('127.0.0.1');
        expect(error.message).toContain('GOOGLE_MCP_OAUTH_PORT');
    });
});

describe('Sheets helpers keep raw API failures internal', () => {
    it('does not put the caught text into the caller-visible read-range failure', async () => {
        const sheets = {
            spreadsheets: {
                values: {
                    get: jest.fn().mockRejectedValue(
                        new Error(`socket hang up while loading credentials from ${LEAKY_PATH}`),
                    ),
                },
            },
        };

        const error = await capture(readRange(sheets, 'sheet-1', 'A1:B2'));

        expect(error.message).toBe('The read range operation failed.');
        expect(error.message).not.toContain(LEAKY_PATH);
        expect(error.message).not.toContain('socket hang up');
    });

    it('keeps the structured 400 description from the Sheets API caller-visible', async () => {
        const apiError = Object.assign(new Error(`Request failed, see ${LEAKY_PATH}`), {
            code: 400,
            response: {
                data: { error: { message: 'Invalid table name: names must not contain spaces.' } },
            },
        });
        const sheets = { spreadsheets: { batchUpdate: jest.fn().mockRejectedValue(apiError) } };

        const error = await capture(createTableHelper(sheets, 'sheet-1', { name: 'my table' }));

        expect(error.message).toContain('Invalid table definition');
        expect(error.message).toContain('Invalid table name: names must not contain spaces.');
        // The validated field crosses; the raw thrown message does not.
        expect(error.message).not.toContain(LEAKY_PATH);
    });

    it('falls back to an internal error when the 400 carries no structured description', async () => {
        const apiError = Object.assign(new Error(`Request failed, see ${LEAKY_PATH}`), { code: 400 });
        const sheets = { spreadsheets: { batchUpdate: jest.fn().mockRejectedValue(apiError) } };

        const error = await capture(createTableHelper(sheets, 'sheet-1', { name: 'my table' }));

        expect(error.message).toBe('The create spreadsheet table operation failed.');
        expect(error.message).not.toContain(LEAKY_PATH);
    });
});

describe('Docs batchUpdate keeps its validated detail and drops the fallback', () => {
    it('still surfaces the API details[].description for an invalid request', async () => {
        const apiError = Object.assign(new Error(`Invalid requests[0], see ${LEAKY_PATH}`), {
            code: 400,
            response: {
                data: {
                    error: {
                        details: [{ description: 'Index 500 must be less than the end index of the body.' }],
                    },
                },
            },
        });
        const docs = { documents: { batchUpdate: jest.fn().mockRejectedValue(apiError) } };

        const error = await capture(executeBatchUpdate(docs, 'doc-1', [{ insertText: {} }]));

        expect(error.message).toContain('Invalid request sent to Google Docs API');
        expect(error.message).toContain('Index 500 must be less than the end index of the body.');
        expect(error.message).not.toContain(LEAKY_PATH);
    });

    it('routes the no-details fallback through an internal error instead of error.message', async () => {
        const apiError = Object.assign(new Error(`Invalid requests[0], see ${LEAKY_PATH}`), {
            code: 400,
            response: { data: { error: {} } },
        });
        const docs = { documents: { batchUpdate: jest.fn().mockRejectedValue(apiError) } };

        const error = await capture(executeBatchUpdate(docs, 'doc-1', [{ insertText: {} }]));

        expect(error.message).toBe('The Google Docs batch update operation failed.');
        expect(error.message).not.toContain(LEAKY_PATH);
    });
});

describe('Drive permission tools show the structured detail and nothing else', () => {
    async function addPermission() {
        const server = createServer();
        registerAddPermission(server);
        return capture(
            server.getTool('addPermission').execute(
                {
                    fileId: 'file-1',
                    type: 'user',
                    role: 'writer',
                    emailAddress: 'someone@example.com',
                    transferOwnership: false,
                },
                { log },
            ),
        );
    }

    it('surfaces the Drive API 400 description without the raw thrown message', async () => {
        permissionsCreate.mockRejectedValue(Object.assign(
            new Error(`Bad Request while reading client secret from ${LEAKY_PATH}`),
            {
                code: 400,
                response: {
                    data: {
                        error: {
                            code: 400,
                            message: 'Sharing outside of your organization is disabled by policy.',
                        },
                    },
                },
            },
        ));

        const error = await addPermission();

        expect(error.message).toContain('Failed to add permission');
        expect(error.message).toContain('Sharing outside of your organization is disabled by policy.');
        // The validated field crosses the boundary; the raw thrown text does not.
        expect(error.message).not.toContain(LEAKY_PATH);
        expect(error.message).not.toContain('Bad Request while reading client secret');
    });

    it('falls through to an internal error when Drive sends no structured detail', async () => {
        permissionsCreate.mockRejectedValue(Object.assign(
            new Error(`connect ECONNREFUSED via proxy configured in ${LEAKY_PATH}`),
            { code: 500 },
        ));

        const error = await addPermission();

        expect(error.message).toBe('The add Drive permission operation failed.');
        expect(error.message).not.toContain(LEAKY_PATH);
        expect(error.message).not.toContain('ECONNREFUSED');
    });
});

describe('Slides tools keep raw API failures internal', () => {
    it('does not leak the caught text out of getPresentation', async () => {
        presentationsGet.mockRejectedValue(
            new Error(`ENOENT: no such file or directory, open '${LEAKY_PATH}'`),
        );
        await getSlidesClient();
        const server = createServer();
        registerGetPresentation(server);

        const error = await capture(
            server.getTool('getPresentation').execute({ presentationId: 'pres-1' }, { log }),
        );

        expect(error.message).toBe('The read presentation operation failed.');
        expect(error.message).not.toContain(LEAKY_PATH);
    });
});
