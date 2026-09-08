// Test-only child entrypoint. It builds the production MCP facade after the
// offline loader has been installed by createInstrumentedFactory.
import { createInstrumentedFactory } from './instrumented-server.mjs';

const rawConfig = process.env.GOOGLE_MCP_AGENT_TEST_CONFIG;
if (!rawConfig) throw new Error('GOOGLE_MCP_AGENT_TEST_CONFIG is required.');
const config = JSON.parse(rawConfig);
if (config.backend !== 'offline') throw new Error('offline-stdio-server only supports the offline backend.');

const { factory } = await createInstrumentedFactory(config);
const { startV2Stdio } = await import('../../dist/mcpServer.js');
startV2Stdio(factory, { profile: 'offline-test' });
process.stdin.resume();
