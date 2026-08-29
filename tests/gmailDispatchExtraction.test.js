// Structural guard for the format-dispatch extraction (issue #74). The six
// call sites in dist/tools/gmail/{messages,threads}.js used to each inline
// the same three-line clean/metadata/full dispatch:
//
//   if (params.format === 'clean')    return formatMessageClean(...);
//   if (params.format === 'metadata') return formatMessageMetadata(...);
//   ...processMessagePart(...)
//
// All six now call the shared dist/helpers.js#formatMessageForOutput
// instead. A unit test on formatMessageForOutput alone cannot catch a copy
// that quietly lingers at one of the old call sites, so this reads the
// source text directly and asserts the pattern is gone everywhere except
// its one remaining definition in helpers.js.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const DISPATCH_PATTERN = /params\.format === 'clean'[\s\S]{0,200}?params\.format === 'metadata'/;

describe('Gmail format dispatch is extracted to a single shared definition', () => {
    it('no longer inlines the clean/metadata dispatch in gmail/messages.js', () => {
        const src = readFileSync(resolve(repoRoot, 'dist/tools/gmail/messages.js'), 'utf8');
        expect(src).not.toMatch(DISPATCH_PATTERN);
    });

    it('no longer inlines the clean/metadata dispatch in gmail/threads.js', () => {
        const src = readFileSync(resolve(repoRoot, 'dist/tools/gmail/threads.js'), 'utf8');
        expect(src).not.toMatch(DISPATCH_PATTERN);
    });

    it('both tool files call the shared formatMessageForOutput helper', () => {
        const messagesSrc = readFileSync(resolve(repoRoot, 'dist/tools/gmail/messages.js'), 'utf8');
        const threadsSrc = readFileSync(resolve(repoRoot, 'dist/tools/gmail/threads.js'), 'utf8');
        expect(messagesSrc).toContain('formatMessageForOutput');
        expect(threadsSrc).toContain('formatMessageForOutput');
    });

    it('the dispatch pattern exists exactly once repo-wide: its definition in dist/helpers.js', () => {
        const helpersSrc = readFileSync(resolve(repoRoot, 'dist/helpers.js'), 'utf8');
        expect(helpersSrc).toMatch(DISPATCH_PATTERN);
    });
});
