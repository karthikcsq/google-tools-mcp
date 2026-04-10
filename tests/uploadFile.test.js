// Tests for the uploadFile tool registration and parameter validation (issue #15).
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

let uploadTool;
beforeAll(async () => {
    const server = createMockServer();
    const { register } = await import('../dist/tools/drive/uploadFile.js');
    register(server);
    uploadTool = server.getTools().get('uploadFile');
});

describe('uploadFile tool (issue #15)', () => {
    it('is registered with correct name', () => {
        expect(uploadTool).toBeDefined();
        expect(uploadTool.name).toBe('uploadFile');
    });

    it('has a description', () => {
        expect(typeof uploadTool.description).toBe('string');
        expect(uploadTool.description.length).toBeGreaterThan(0);
    });

    it('has an execute function', () => {
        expect(typeof uploadTool.execute).toBe('function');
    });

    it('requires localPath parameter', () => {
        const result = uploadTool.parameters.safeParse({});
        expect(result.success).toBe(false);
    });

    it('accepts localPath only', () => {
        const result = uploadTool.parameters.safeParse({
            localPath: '/tmp/test.pdf',
        });
        expect(result.success).toBe(true);
    });

    it('accepts all optional parameters', () => {
        const result = uploadTool.parameters.safeParse({
            localPath: '/tmp/test.pdf',
            name: 'My Report.pdf',
            parentFolderId: 'folder-id-123',
            mimeType: 'application/pdf',
        });
        expect(result.success).toBe(true);
    });
});
