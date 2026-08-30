import { describe, expect, it } from '@jest/globals';
import expectedInventory from './fixtures/mcp-migration-inventory.json' with { type: 'json' };
import { collectMigrationInventory } from '../scripts/inventory-mcp-migration.mjs';

describe('MCP migration inventory baseline', () => {
    // Registering the full runtime catalog can exceed Jest's default timeout under parallel CI load.
    it('matches the tracked runtime/test dependency and registration baseline', async () => {
        const actualInventory = await collectMigrationInventory();
        const inventoryTestPath = 'tests/mcpMigrationInventory.test.js';
        const comparableActual = {
            ...actualInventory,
            files: {
                ...actualInventory.files,
                // The observer becomes tracked only when this test is committed.
                // Exclude that one self-reference, but retain the test-file
                // inventory guard for every other tracked test source file.
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
    }, 120_000);
});
