import { afterEach, describe, expect, it } from '@jest/globals';

const ORIGINAL_PORT = process.env.GOOGLE_MCP_OAUTH_PORT;

function restorePort() {
    if (ORIGINAL_PORT === undefined) delete process.env.GOOGLE_MCP_OAUTH_PORT;
    else process.env.GOOGLE_MCP_OAUTH_PORT = ORIGINAL_PORT;
}

afterEach(restorePort);

describe('getOAuthCallbackPort', () => {
    it('uses an ephemeral port when no callback port is configured', async () => {
        delete process.env.GOOGLE_MCP_OAUTH_PORT;
        const { getOAuthCallbackPort } = await import('../dist/auth.js');

        expect(getOAuthCallbackPort()).toBe(0);
    });

    it('uses a configured fixed callback port for tunnel-friendly OAuth', async () => {
        process.env.GOOGLE_MCP_OAUTH_PORT = '37547';
        const { getOAuthCallbackPort } = await import('../dist/auth.js');

        expect(getOAuthCallbackPort()).toBe(37547);
    });

    it.each(['abc', '0', '-1', '65536', '37547.5'])('rejects invalid configured callback port %s', async (value) => {
        process.env.GOOGLE_MCP_OAUTH_PORT = value;
        const { getOAuthCallbackPort } = await import('../dist/auth.js');

        expect(() => getOAuthCallbackPort()).toThrow(/GOOGLE_MCP_OAUTH_PORT/);
    });
});
