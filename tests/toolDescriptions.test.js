// Tests for tool description cross-references (issue #12) and filePath parameter (issue #19).
import { describe, it, expect, beforeAll } from '@jest/globals';

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
