// Coverage for `bulletNestingLevel` on applyParagraphStyle — issue #107 plan,
// step 3. `createParagraphBullets` has no field for nesting depth; depth is
// read off the paragraph's own leading tab characters (confirmed against
// `markdown-transformer/markdownToDocs.js`, which inserts `'\t'.repeat(level)`
// before a list-item paragraph and then issues one `createParagraphBullets`
// over the merged range — the API infers depth from those tabs, never from a
// request parameter). So applyParagraphStyle's bulletNestingLevel resolves
// the target to whole paragraphs, deletes any existing bullet, adjusts the
// paragraph's leading tabs to the requested depth, and recreates the bullet —
// all in the same batchUpdate as any other style fields, under the existing
// guard/WriteControl chain.
import { describe, it, expect, jest } from '@jest/globals';

let fakeDocs;
jest.unstable_mockModule('../dist/clients.js', () => ({
    getDocsClient: async () => fakeDocs,
    getDriveClient: async () => { throw new Error('not used'); },
    getSheetsClient: async () => { throw new Error('not used'); },
    getCalendarClient: async () => { throw new Error('not used'); },
    getScriptClient: async () => { throw new Error('not used'); },
}));

const { trackRead } = await import('../dist/readTracker.js');
const { register: registerApplyParagraphStyle } = await import('../dist/tools/docs/formatting/applyParagraphStyle.js');

function createMockServer() {
    const tools = new Map();
    return {
        addTool(def) { tools.set(def.name, def); },
        getTool(name) { return tools.get(name); },
    };
}

const noopLog = { info() {}, error() {}, warn() {}, debug() {} };

function setUpDocs({ content, lists = {} }) {
    const get = jest.fn(async () => ({ data: { body: { content }, lists } }));
    const batchUpdate = jest.fn(async ({ requestBody }) => ({
        data: { writeControl: requestBody.writeControl },
    }));
    fakeDocs = { documents: { get, batchUpdate } };
    return { get, batchUpdate };
}

function getTool() {
    const server = createMockServer();
    registerApplyParagraphStyle(server);
    return server.getTool('applyParagraphStyle');
}

function paragraph(startIndex, endIndex, text, bullet = null) {
    return {
        startIndex,
        endIndex,
        paragraph: {
            ...(bullet ? { bullet } : {}),
            elements: [{ startIndex, endIndex: endIndex - 1, textRun: { content: text } }],
        },
    };
}

describe('applyParagraphStyle — bulletNestingLevel', () => {
    it('whole-paragraph resolution: an explicit range matching one paragraph is accepted and produces the delete/adjust/create sequence', async () => {
        const documentId = `bnl-whole-${Date.now()}`;
        const content = [paragraph(1, 20, 'Item one\n', { listId: 'L1', nestingLevel: 0 })];
        const lists = { L1: { listProperties: { nestingLevels: [{ glyphType: 'DISC' }] } } };
        const { batchUpdate } = setUpDocs({ content, lists });
        trackRead(documentId, null, null, 'rev-read');

        const tool = getTool();
        await tool.execute({
            documentId,
            target: { startIndex: 1, endIndex: 20 },
            bulletNestingLevel: 1,
        }, { log: noopLog });

        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        expect(requests).toEqual([
            { deleteParagraphBullets: { range: { startIndex: 1, endIndex: 20 } } },
            {
                updateParagraphStyle: {
                    range: { startIndex: 1, endIndex: 20 },
                    paragraphStyle: {
                        indentStart: { magnitude: 0, unit: 'PT' },
                        indentFirstLine: { magnitude: 0, unit: 'PT' },
                    },
                    fields: 'indentStart,indentFirstLine',
                },
            },
            { insertText: { location: { index: 1 }, text: '\t' } },
            { createParagraphBullets: { range: { startIndex: 1, endIndex: 21 }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } },
        ]);
    });

    it('zeroes indentStart/indentFirstLine after deleteParagraphBullets so repeated nesting changes do not accumulate indent (#fix2a)', async () => {
        const documentId = `bnl-zero-indent-${Date.now()}`;
        const content = [paragraph(1, 20, 'Item one\n', { listId: 'L1', nestingLevel: 0 })];
        const lists = { L1: { listProperties: { nestingLevels: [{ glyphType: 'DISC' }] } } };
        const { batchUpdate } = setUpDocs({ content, lists });
        trackRead(documentId, null, null, 'rev-read');

        await getTool().execute({
            documentId,
            target: { startIndex: 1, endIndex: 20 },
            bulletNestingLevel: 1,
        }, { log: noopLog });

        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        const deleteIdx = requests.findIndex((r) => r.deleteParagraphBullets);
        const zeroIdx = requests.findIndex((r) => r.updateParagraphStyle
            && r.updateParagraphStyle.fields === 'indentStart,indentFirstLine');
        const createIdx = requests.findIndex((r) => r.createParagraphBullets);
        expect(deleteIdx).toBeGreaterThanOrEqual(0);
        expect(zeroIdx).toBeGreaterThan(deleteIdx);
        expect(zeroIdx).toBeLessThan(createIdx);
        expect(requests[zeroIdx]).toEqual({
            updateParagraphStyle: {
                range: { startIndex: 1, endIndex: 20 },
                paragraphStyle: {
                    indentStart: { magnitude: 0, unit: 'PT' },
                    indentFirstLine: { magnitude: 0, unit: 'PT' },
                },
                fields: 'indentStart,indentFirstLine',
            },
        });
    });

    it('tab adjustment: moving deeper inserts leading tabs, moving shallower deletes them', async () => {
        const documentIdUp = `bnl-up-${Date.now()}`;
        const contentUp = [paragraph(1, 20, 'Item one\n', { listId: 'L1', nestingLevel: 0 })];
        const { batchUpdate: batchUp } = setUpDocs({ content: contentUp, lists: { L1: { listProperties: { nestingLevels: [{ glyphType: 'DISC' }] } } } });
        trackRead(documentIdUp, null, null, 'rev-read');
        await getTool().execute({
            documentId: documentIdUp,
            target: { startIndex: 1, endIndex: 20 },
            bulletNestingLevel: 2,
        }, { log: noopLog });
        const upRequests = batchUp.mock.calls[0][0].requestBody.requests;
        expect(upRequests).toContainEqual({ insertText: { location: { index: 1 }, text: '\t\t' } });
        expect(upRequests).toContainEqual({ createParagraphBullets: { range: { startIndex: 1, endIndex: 22 }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });

        const documentIdDown = `bnl-down-${Date.now()}`;
        const contentDown = [paragraph(1, 22, '\t\tNested item\n', { listId: 'L1', nestingLevel: 2 })];
        const { batchUpdate: batchDown } = setUpDocs({ content: contentDown, lists: { L1: { listProperties: { nestingLevels: [{ glyphType: 'DISC' }] } } } });
        trackRead(documentIdDown, null, null, 'rev-read');
        await getTool().execute({
            documentId: documentIdDown,
            target: { startIndex: 1, endIndex: 22 },
            bulletNestingLevel: 0,
        }, { log: noopLog });
        const downRequests = batchDown.mock.calls[0][0].requestBody.requests;
        expect(downRequests).toContainEqual({ deleteContentRange: { range: { startIndex: 1, endIndex: 3 } } });
        expect(downRequests).toContainEqual({ createParagraphBullets: { range: { startIndex: 1, endIndex: 20 }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });
    });

    it('preset inferred from the existing list when bulletPreset is not passed', async () => {
        const documentId = `bnl-infer-${Date.now()}`;
        const content = [paragraph(1, 20, 'First\n', { listId: 'L2', nestingLevel: 0 })];
        const lists = { L2: { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL' }, { glyphType: 'DECIMAL' }] } } };
        const { batchUpdate } = setUpDocs({ content, lists });
        trackRead(documentId, null, null, 'rev-read');

        await getTool().execute({
            documentId,
            target: { startIndex: 1, endIndex: 20 },
            bulletNestingLevel: 1,
        }, { log: noopLog });

        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        expect(requests).toContainEqual(expect.objectContaining({
            createParagraphBullets: expect.objectContaining({ bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN' }),
        }));
    });

    it('explicit bulletPreset is required, and used, for paragraphs that are not currently list items', async () => {
        const documentId = `bnl-explicit-${Date.now()}`;
        const content = [paragraph(1, 20, 'Plain paragraph\n')];
        const { batchUpdate } = setUpDocs({ content });
        trackRead(documentId, null, null, 'rev-read');

        await getTool().execute({
            documentId,
            target: { startIndex: 1, endIndex: 20 },
            bulletNestingLevel: 0,
            bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN',
        }, { log: noopLog });

        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        expect(requests).toContainEqual(expect.objectContaining({
            createParagraphBullets: expect.objectContaining({ bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN' }),
        }));

        // Without bulletPreset there is nothing to infer from, and the write is refused.
        const documentId2 = `bnl-explicit-missing-${Date.now()}`;
        setUpDocs({ content });
        trackRead(documentId2, null, null, 'rev-read');
        await expect(getTool().execute({
            documentId: documentId2,
            target: { startIndex: 1, endIndex: 20 },
            bulletNestingLevel: 0,
        }, { log: noopLog })).rejects.toThrow(/bulletPreset/i);
    });

    it('a range that does not align to whole paragraph boundaries is rejected', async () => {
        const documentId = `bnl-partial-${Date.now()}`;
        const content = [
            paragraph(1, 10, 'Hello\n'),
            paragraph(10, 20, 'World\n'),
        ];
        setUpDocs({ content });
        trackRead(documentId, null, null, 'rev-read');

        await expect(getTool().execute({
            documentId,
            target: { startIndex: 5, endIndex: 15 },
            bulletNestingLevel: 0,
            bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        }, { log: noopLog })).rejects.toThrow(/whole paragraph/i);
    });

    it('a range spanning paragraphs that belong to different lists is rejected', async () => {
        const documentId = `bnl-mixed-${Date.now()}`;
        const content = [
            paragraph(1, 10, 'A\n', { listId: 'LA', nestingLevel: 0 }),
            paragraph(10, 20, 'B\n', { listId: 'LB', nestingLevel: 0 }),
        ];
        const lists = {
            LA: { listProperties: { nestingLevels: [{ glyphType: 'DISC' }] } },
            LB: { listProperties: { nestingLevels: [{ glyphType: 'DISC' }] } },
        };
        setUpDocs({ content, lists });
        trackRead(documentId, null, null, 'rev-read');

        await expect(getTool().execute({
            documentId,
            target: { startIndex: 1, endIndex: 20 },
            bulletNestingLevel: 1,
        }, { log: noopLog })).rejects.toThrow(/different lists|mixed/i);
    });

    it('style fields and bulletNestingLevel are combined into a single guarded batchUpdate', async () => {
        const documentId = `bnl-single-batch-${Date.now()}`;
        const content = [paragraph(1, 20, 'Item\n', { listId: 'L1', nestingLevel: 0 })];
        const lists = { L1: { listProperties: { nestingLevels: [{ glyphType: 'DISC' }] } } };
        const { batchUpdate } = setUpDocs({ content, lists });
        trackRead(documentId, null, null, 'rev-read');

        await getTool().execute({
            documentId,
            target: { startIndex: 1, endIndex: 20 },
            style: { alignment: 'CENTER' },
            bulletNestingLevel: 1,
        }, { log: noopLog });

        expect(batchUpdate).toHaveBeenCalledTimes(1);
        const { requests, writeControl } = batchUpdate.mock.calls[0][0].requestBody;
        expect(writeControl).toEqual({ requiredRevisionId: 'rev-read' });
        expect(requests.some((r) => r.createParagraphBullets)).toBe(true);
        // Caller-supplied paragraph style (#fix2b): must be the LAST request
        // in the batch, so it is not clobbered by the bullet-nesting
        // sequence's own zero-indent cleanup request — caller intent wins.
        expect(requests[requests.length - 1]).toEqual({
            updateParagraphStyle: {
                range: { startIndex: 1, endIndex: 20 },
                paragraphStyle: { alignment: 'CENTER' },
                fields: 'alignment',
            },
        });
    });

    it('treats a non-list paragraph\'s leading literal tabs as its current nesting level (#fix2c)', async () => {
        // Two leading tabs the user actually typed, on a paragraph that is
        // NOT a list item. currentTabs must read as 2 (not 0), so raising to
        // level 3 inserts exactly one more tab (delta = 3 - 2 = 1) rather
        // than three, and does not delete any of the user's real tabs.
        const documentId = `bnl-plain-tabs-up-${Date.now()}`;
        const content = [paragraph(1, 22, '\t\tPlain but indented\n')];
        const { batchUpdate } = setUpDocs({ content });
        trackRead(documentId, null, null, 'rev-read');

        await getTool().execute({
            documentId,
            target: { startIndex: 1, endIndex: 22 },
            bulletNestingLevel: 3,
            bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        }, { log: noopLog });

        const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
        expect(requests).toContainEqual({ insertText: { location: { index: 1 }, text: '\t' } });
        expect(requests.some((r) => r.deleteContentRange)).toBe(false);
        expect(requests).toContainEqual({
            createParagraphBullets: { range: { startIndex: 1, endIndex: 23 }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' },
        });

        // Lowering to level 1 (delta = 1 - 2 = -1) removes exactly one of the
        // two real leading tabs, not the whole paragraph's worth.
        const documentId2 = `bnl-plain-tabs-down-${Date.now()}`;
        const { batchUpdate: batchUpdate2 } = setUpDocs({ content });
        trackRead(documentId2, null, null, 'rev-read');
        await getTool().execute({
            documentId: documentId2,
            target: { startIndex: 1, endIndex: 22 },
            bulletNestingLevel: 1,
            bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        }, { log: noopLog });
        const requests2 = batchUpdate2.mock.calls[0][0].requestBody.requests;
        expect(requests2).toContainEqual({ deleteContentRange: { range: { startIndex: 1, endIndex: 2 } } });
        expect(requests2).toContainEqual({
            createParagraphBullets: { range: { startIndex: 1, endIndex: 21 }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' },
        });
    });

    it('bulletPreset schema rejects an unknown value and names the valid ones (#fix6)', () => {
        // The mock server's getTool().execute() calls the tool's raw execute
        // function directly, bypassing the framework's schema-validation
        // layer, so schema rejection is exercised against the tool's own
        // `parameters` zod schema here, exactly as the real server does
        // before execute() ever runs.
        const tool = getTool();
        const result = tool.parameters.safeParse({
            documentId: 'doc-1',
            target: { startIndex: 1, endIndex: 20 },
            bulletNestingLevel: 0,
            bulletPreset: 'NOT_A_REAL_PRESET',
        });
        expect(result.success).toBe(false);
        const message = JSON.stringify(result.error.issues);
        expect(message).toContain('BULLET_DISC_CIRCLE_SQUARE');
        expect(message).toContain('NUMBERED_DECIMAL_ALPHA_ROMAN');
    });
});
