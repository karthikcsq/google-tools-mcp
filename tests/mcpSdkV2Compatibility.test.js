import { describe, expect, it, jest } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { registerAllTools } from '../dist/tools/index.js';
import {
    FIXTURE_INSTRUCTIONS,
    MODERN_PROTOCOL_VERSION,
    createCompatibilityFixtureHandler,
    createOfficialSdkRegistrationAdapter,
    legacyRequest,
    modernRequest,
    parseLegacySseResponse,
} from './fixtures/mcpSdkV2Fixture.js';

jest.setTimeout(30_000);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function responseJson(response) {
    expect(response.headers.get('content-type')).toContain('application/json');
    return response.json();
}

function defaultAliasEnvironment() {
    const previous = process.env.GOOGLE_MCP_ENABLE_LEGACY_ALIASES;
    delete process.env.GOOGLE_MCP_ENABLE_LEGACY_ALIASES;
    return () => {
        if (previous === undefined) delete process.env.GOOGLE_MCP_ENABLE_LEGACY_ALIASES;
        else process.env.GOOGLE_MCP_ENABLE_LEGACY_ALIASES = previous;
    };
}

describe('MCP SDK v2 compatibility spike', () => {
    it('pins the Phase 1 platform and direct dependency floor', async () => {
        const [packageJson, lockfile, rootZodManifest] = await Promise.all([
            readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
            readFile(new URL('../package-lock.json', import.meta.url), 'utf8').then(JSON.parse),
            readFile(new URL('../node_modules/zod/package.json', import.meta.url), 'utf8').then(JSON.parse),
        ]);

        expect(packageJson.engines.node).toBe('>=20');
        expect(packageJson.dependencies['@modelcontextprotocol/server']).toBe('2.0.0');
        expect(packageJson.dependencies['@modelcontextprotocol/node']).toBe('2.0.0');
        expect(packageJson.dependencies.hono).toBe('^4.11.4');
        expect(packageJson.dependencies.zod).toBe('^4.2.0');
        expect(lockfile.packages[''].dependencies['@modelcontextprotocol/server']).toBe('2.0.0');
        expect(lockfile.packages[''].dependencies['@modelcontextprotocol/node']).toBe('2.0.0');

        // PR 4 cutover: the official SDK is the only runtime. fastmcp is gone
        // from the manifest, and with it mcp-proxy and the raw v1 SDK it pulled
        // in transitively — so no v1 SDK can be resolved by accident either.
        expect(packageJson.dependencies.fastmcp).toBeUndefined();
        expect(packageJson.devDependencies?.fastmcp).toBeUndefined();
        expect(lockfile.packages['node_modules/fastmcp']).toBeUndefined();
        expect(lockfile.packages['node_modules/mcp-proxy']).toBeUndefined();
        expect(lockfile.packages['node_modules/@modelcontextprotocol/sdk']).toBeUndefined();

        const [major, minor] = rootZodManifest.version.split('.').map(Number);
        expect(major > 4 || (major === 4 && minor >= 2)).toBe(true);
    });

    // The Phase 1 decision gate was a DUAL-runtime proof: all 156 schemas
    // registering through real FastMCP@3.34.0 AND the official SDK under one
    // root Zod v4 process, which is what authorized the temporary
    // GOOGLE_MCP_USE_SDK_V2 flag path. That result is historical and is
    // recorded in
    // docs/decisions/2026-08-16-mcp-sdk-v2-compatibility-spike.md; PR 4 removed
    // fastmcp from the dependency tree, so its half cannot be re-run here and
    // this test keeps the half that still describes shipping behavior.
    it('registers all 156 default schemas through the official SDK with root Zod v4', async () => {
        const restoreAliases = defaultAliasEnvironment();
        const { adapter, definitions: officialDefinitions, officialServer } = createOfficialSdkRegistrationAdapter();

        try {
            await registerAllTools(adapter);

            const officialNames = officialDefinitions.map(({ name }) => name);
            expect(officialNames).toHaveLength(156);
            expect(new Set(officialNames).size).toBe(156);
        } finally {
            await officialServer.close();
            restoreAliases();
        }
    });

    it('serves deterministic modern discover, list, and call traffic with private cache hints', async () => {
        const handler = createCompatibilityFixtureHandler();

        try {
            const discoverResponse = await handler.fetch(modernRequest({
                id: 1,
                method: 'server/discover',
            }));
            const discover = await responseJson(discoverResponse);
            expect(discoverResponse.headers.get('mcp-session-id')).toBeNull();
            expect(discover.result.supportedVersions).toContain(MODERN_PROTOCOL_VERSION);
            expect(discover.result.instructions).toBe(FIXTURE_INSTRUCTIONS);
            expect(discover.result.capabilities.tools.listChanged).toBe(false);
            expect(discover.result.ttlMs).toBe(60_000);
            expect(discover.result.cacheScope).toBe('private');

            const listResponses = await Promise.all([2, 3].map((id) => handler.fetch(modernRequest({
                id,
                method: 'tools/list',
            }))));
            const lists = await Promise.all(listResponses.map(responseJson));
            const expectedNames = ['alphaEcho', 'zetaEcho'];
            expect(lists.map(({ result }) => result.tools.map(({ name }) => name))).toEqual([
                expectedNames,
                expectedNames,
            ]);
            for (const { result } of lists) {
                expect(result.ttlMs).toBe(60_000);
                expect(result.cacheScope).toBe('private');
            }

            const callResponse = await handler.fetch(modernRequest({
                id: 4,
                method: 'tools/call',
                headers: { 'mcp-name': 'alphaEcho' },
                params: { name: 'alphaEcho', arguments: { text: 'modern' } },
            }));
            const call = await responseJson(callResponse);
            expect(call.result.content).toEqual([{ type: 'text', text: 'alpha:modern' }]);
        } finally {
            await handler.close();
        }
    });

    it('keeps the official handler statelessly compatible with supported legacy HTTP traffic', async () => {
        const handler = createCompatibilityFixtureHandler();

        try {
            const initializeResponse = await handler.fetch(legacyRequest({
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-11-25',
                    capabilities: {},
                    clientInfo: { name: 'compatibility-test', version: '0.0.0' },
                },
            }));
            expect(initializeResponse.headers.get('mcp-session-id')).toBeNull();
            const initialize = parseLegacySseResponse(await initializeResponse.text());
            expect(initialize.result.protocolVersion).toBe('2025-11-25');

            const listResponse = await handler.fetch(legacyRequest({
                id: 2,
                method: 'tools/list',
            }));
            const list = parseLegacySseResponse(await listResponse.text());
            expect(list.result.tools.map(({ name }) => name)).toEqual(['alphaEcho', 'zetaEcho']);

            const callResponse = await handler.fetch(legacyRequest({
                id: 3,
                method: 'tools/call',
                params: { name: 'zetaEcho', arguments: { text: 'legacy' } },
            }));
            const call = parseLegacySseResponse(await callResponse.text());
            expect(call.result.content).toEqual([{ type: 'text', text: 'zeta:legacy' }]);
        } finally {
            await handler.close();
        }
    });

    it('records the current missing modern protocol-header defect rather than assuming it is enforced', async () => {
        const handler = createCompatibilityFixtureHandler();

        try {
            const response = await handler.fetch(modernRequest({
                id: 1,
                method: 'tools/list',
                includeProtocolHeader: false,
            }));
            const body = await responseJson(response);

            // @modelcontextprotocol/server 2.0.0 accepts this modern envelope.
            // This is an observed upstream defect baseline, not intended product behavior.
            expect(response.status).toBe(200);
            expect(body.result.tools.map(({ name }) => name)).toEqual(['alphaEcho', 'zetaEcho']);
        } finally {
            await handler.close();
        }
    });

    it('proves the empty subscriptions/listen stream needs a narrow Phase 2 close wrapper', async () => {
        const handler = createCompatibilityFixtureHandler();
        let reader;

        try {
            const response = await handler.fetch(modernRequest({
                id: 1,
                method: 'subscriptions/listen',
                params: { notifications: {} },
            }));
            expect(response.headers.get('content-type')).toContain('text/event-stream');
            reader = response.body.getReader();

            const firstFrame = await reader.read();
            expect(new TextDecoder().decode(firstFrame.value)).toContain('notifications/subscriptions/acknowledged');

            const secondFrame = await Promise.race([
                reader.read(),
                delay(50).then(() => 'still-open'),
            ]);
            expect(secondFrame).toBe('still-open');
        } finally {
            await reader?.cancel();
            await handler.close();
        }
    });

    it('records explicit stdio shutdown as the available primitive and stdin EOF as not closing the transport', async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        const transport = new StdioServerTransport(input, output);
        let closeCount = 0;
        transport.onclose = () => { closeCount += 1; };

        await transport.start();
        input.end();
        await delay(50);
        expect(closeCount).toBe(0);

        await transport.close();
        expect(closeCount).toBe(1);
    });
});
