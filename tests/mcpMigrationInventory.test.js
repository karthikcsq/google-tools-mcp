import { describe, expect, it } from '@jest/globals';
import expectedInventory from './fixtures/mcp-migration-inventory.json' with { type: 'json' };
import { collectMigrationInventory } from '../scripts/inventory-mcp-migration.mjs';

describe('MCP migration inventory baseline', () => {
    // Loading every production tool registration is intentionally comprehensive.
    // Under the parallel full suite it can exceed Jest's five-second default
    // without indicating a mismatch in the deterministic inventory itself.
    it('matches the repository runtime/test dependency and registration baseline', async () => {
        const actualInventory = await collectMigrationInventory();
        const inventoryTestPath = 'tests/mcpMigrationInventory.test.js';
        const comparableActual = {
            ...actualInventory,
            files: {
                ...actualInventory.files,
                // Exclude the observer's self-reference, but retain the test-file
                // inventory guard for every other tracked or pending test source.
                tests: actualInventory.files.tests.filter(({ file }) => file !== inventoryTestPath),
            },
        };
        const comparableExpected = {
            ...expectedInventory,
            files: {
                ...expectedInventory.files,
                tests: expectedInventory.files.tests.filter(({ file }) => file !== inventoryTestPath),
            },
        };

        expect(comparableActual).toEqual(comparableExpected);
    }, 15_000);
});
