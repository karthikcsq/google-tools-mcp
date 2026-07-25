// Regression test for the merge-blocking update-path finding on dist/setup.js:
// switching MCP clients from `npx` (which always re-resolves to the latest
// published version) to a fixed global-install path means nothing else ever
// re-runs `npm install -g` to pick up a new release. setup.js now exports the
// exact command it tells users to run, and prints it whenever it writes a
// fixed-path launch command (the 'global' and 'running-copy' branches in
// buildLaunchCommand — see tests/setupFastLaunch.test.js for those branches).
// This test locks the exported command itself so it can't silently drift
// from what the README's "Updating" section documents.
import { describe, it, expect } from '@jest/globals';
import { UPDATE_COMMAND } from '../dist/setup.js';

describe('UPDATE_COMMAND', () => {
    it('is the documented npm command for updating a global install', () => {
        expect(UPDATE_COMMAND).toBe('npm install -g google-tools-mcp@latest');
    });

    it('matches the command documented in the README Updating section', async () => {
        const fs = await import('fs/promises');
        const path = await import('path');
        const { fileURLToPath } = await import('url');
        const readmePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'README.md');
        const readme = await fs.readFile(readmePath, 'utf8');
        expect(readme).toContain(UPDATE_COMMAND);
    });
});
