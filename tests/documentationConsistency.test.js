import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAllTools } from '../dist/tools/index.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('published documentation', () => {
    it('states the current default tool count and all registered categories', async () => {
        const readme = await fs.readFile(path.join(repoRoot, 'README.md'), 'utf8');
        const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
        const tools = new Map();
        await registerAllTools({
            addTool(tool) {
                tools.set(tool.name, tool);
            },
        });
        const count = tools.size;

        expect(readme).toContain(`**${count} tools** for Drive, Docs, Sheets, Gmail, Calendar, Forms, Slides, Tasks, and Maps`);
        expect(packageJson.description).toContain(`${count} tools`);
        expect(packageJson.description).toContain('Slides, and Tasks');

        for (const category of [
            'files', 'documents', 'spreadsheets', 'email', 'email_threads',
            'email_labels', 'email_settings', 'calendar', 'forms', 'slides',
            'tasks', 'maps',
        ]) {
            expect(readme).toContain(`### \`${category}\``);
        }
    });

    it('documents every API the guided setup enables', async () => {
        const readme = await fs.readFile(path.join(repoRoot, 'README.md'), 'utf8');
        for (const apiName of [
            'Google Docs API', 'Google Sheets API', 'Google Drive API', 'Gmail API',
            'Google Calendar API', 'Google Forms API', 'Google Slides API', 'Google Tasks API',
        ]) {
            expect(readme).toContain(apiName);
        }
    });
});
