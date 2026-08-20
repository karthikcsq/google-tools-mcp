// Tests for tool description cross-references (issue #12) and filePath parameter (issue #19).
import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

function createMockServer() {
    const tools = new Map();
    return {
        addTool(toolDef) {
            tools.set(toolDef.name, toolDef);
        },
        getTools() {
            return tools;
        },
    };
}

// Collect all editing tools
let allTools;
beforeAll(async () => {
    const server = createMockServer();
    const { registerDocsTools } = await import('../dist/tools/docs/index.js');
    const { registerUtilsTools } = await import('../dist/tools/utils/index.js');
    registerDocsTools(server);
    registerUtilsTools(server);
    allTools = server.getTools();
});

// ---------------------------------------------------------------------------
// Issue #12: Cross-references between editing tools
// ---------------------------------------------------------------------------
describe('Tool description cross-references (issue #12)', () => {
    it('modifyText description references replaceDocumentWithMarkdown', () => {
        const tool = allTools.get('modifyText');
        expect(tool.description).toContain('replaceDocumentWithMarkdown');
    });

    it('modifyText description references appendMarkdown', () => {
        const tool = allTools.get('modifyText');
        expect(tool.description).toContain('appendMarkdown');
    });

    it('modifyText description mentions it is for small/targeted changes', () => {
        const tool = allTools.get('modifyText');
        expect(tool.description).toMatch(/small|targeted|single/i);
    });

    it('replaceDocumentWithMarkdown description references modifyText', () => {
        const tool = allTools.get('replaceDocumentWithMarkdown');
        expect(tool.description).toContain('modifyText');
    });

    it('replaceDocumentWithMarkdown description references appendMarkdown', () => {
        const tool = allTools.get('replaceDocumentWithMarkdown');
        expect(tool.description).toContain('appendMarkdown');
    });

    it('replaceDocumentWithMarkdown description mentions full document rewrite', () => {
        const tool = allTools.get('replaceDocumentWithMarkdown');
        expect(tool.description).toMatch(/section|full|entire|rewrite/i);
    });

    it('appendMarkdown description references modifyText', () => {
        const tool = allTools.get('appendMarkdown');
        expect(tool.description).toContain('modifyText');
    });

    it('appendMarkdown description references replaceDocumentWithMarkdown', () => {
        const tool = allTools.get('appendMarkdown');
        expect(tool.description).toContain('replaceDocumentWithMarkdown');
    });

    it('appendText description references modifyText', () => {
        const tool = allTools.get('appendText');
        expect(tool.description).toContain('modifyText');
    });

    it('appendText description references replaceDocumentWithMarkdown', () => {
        const tool = allTools.get('appendText');
        expect(tool.description).toContain('replaceDocumentWithMarkdown');
    });
});

// ---------------------------------------------------------------------------
// Issue #105: the documented way to discover indices must be one that completes
// ---------------------------------------------------------------------------
describe("index discovery points at format='index' (issue #105)", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

    // dist/tools/docs/insertImage.js is excluded here only because it is being
    // rewritten in a parallel change that owns its description text; the
    // pointer in it is retargeted there, not duplicated here.
    const EXCLUDED = new Set([path.join('dist', 'tools', 'docs', 'insertImage.js')]);

    function docsSourceFiles() {
        const roots = [path.join(repoRoot, 'dist', 'tools', 'docs')];
        const found = [path.join(repoRoot, 'dist', 'googleDocsApiHelpers.js')];
        while (roots.length > 0) {
            const dir = roots.pop();
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) roots.push(full);
                else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) found.push(full);
            }
        }
        return found.filter((file) => !EXCLUDED.has(path.relative(repoRoot, file)));
    }

    it('no docs tool description or error string recommends format=json for indices', () => {
        const offenders = docsSourceFiles().filter((file) =>
            /format='json'/.test(fs.readFileSync(file, 'utf8')) &&
            path.basename(file) !== 'readGoogleDoc.js');
        expect(offenders.map((file) => path.relative(repoRoot, file))).toEqual([]);
    });

    it('every index-addressed tool names format=index in its parameter or description text', () => {
        const expected = [
            'modifyText.js', 'deleteRange.js', 'insertTable.js',
            'insertPageBreak.js', 'insertTableWithData.js',
        ];
        for (const name of expected) {
            const source = fs.readFileSync(path.join(repoRoot, 'dist', 'tools', 'docs', name), 'utf8');
            expect({ name, hasPointer: /format='index'/.test(source) }).toEqual({ name, hasPointer: true });
        }
        const helpers = fs.readFileSync(path.join(repoRoot, 'dist', 'googleDocsApiHelpers.js'), 'utf8');
        expect(helpers).toContain("Use readDocument with format='index' to find the correct table startIndex");
    });

    it("readDocument advertises format='index' as the way to find indices", () => {
        const tool = allTools.get('readDocument');
        expect(tool.description).toContain("format='index'");
        expect(tool.parameters.safeParse({ documentId: 'd', format: 'index' }).success).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Issue #13: modifyText supports delete (empty string)
// ---------------------------------------------------------------------------
describe('modifyText delete capability in description (issue #13)', () => {
    it('modifyText description mentions delete/empty string', () => {
        const tool = allTools.get('modifyText');
        expect(tool.description).toMatch(/delete|empty string/i);
    });
});

// ---------------------------------------------------------------------------
// Issue #19: filePath parameter on large-content tools
// ---------------------------------------------------------------------------
describe('filePath parameter support (issue #19)', () => {
    it('replaceDocumentWithMarkdown has filePath parameter', () => {
        const tool = allTools.get('replaceDocumentWithMarkdown');
        // Zod schema — check the shape description mentions filePath
        const schema = tool.parameters;
        // Parse with a filePath to verify it's accepted
        const result = schema.safeParse({
            documentId: 'test-id',
            filePath: '/tmp/test.md',
        });
        expect(result.success).toBe(true);
    });

    it('replaceDocumentWithMarkdown accepts markdown OR filePath', () => {
        const tool = allTools.get('replaceDocumentWithMarkdown');
        // Both should parse fine
        const withMarkdown = tool.parameters.safeParse({
            documentId: 'test-id',
            markdown: '# Hello',
        });
        const withFilePath = tool.parameters.safeParse({
            documentId: 'test-id',
            filePath: '/tmp/test.md',
        });
        expect(withMarkdown.success).toBe(true);
        expect(withFilePath.success).toBe(true);
    });

    it('appendMarkdown has filePath parameter', () => {
        const tool = allTools.get('appendMarkdown');
        const result = tool.parameters.safeParse({
            documentId: 'test-id',
            filePath: '/tmp/test.md',
        });
        expect(result.success).toBe(true);
    });

    it('appendText has filePath parameter', () => {
        const tool = allTools.get('appendText');
        const result = tool.parameters.safeParse({
            documentId: 'test-id',
            filePath: '/tmp/test.txt',
        });
        expect(result.success).toBe(true);
    });
});
