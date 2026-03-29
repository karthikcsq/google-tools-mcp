import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDocsClient } from '../../clients.js';
import { DocumentIdParameter, TextFindParameter, TextStyleParameters, ParagraphStyleParameters } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
const RangeTarget = z
    .object({
    startIndex: z.number().int().min(1).describe('Start of range (inclusive, 1-based).'),
    endIndex: z.number().int().min(1).describe('End of range (exclusive).'),
})
    .refine((d) => d.endIndex > d.startIndex, {
    message: 'endIndex must be greater than startIndex',
    path: ['endIndex'],
});
const InsertionTarget = z.object({
    insertionIndex: z.number().int().min(1).describe('Index to insert at (1-based).'),
});
const ModifyTextParameters = DocumentIdParameter.extend({
    target: z
        .union([RangeTarget, TextFindParameter, InsertionTarget])
        .describe('Target by range indices, text search, or insertion index.'),
    text: z.string().optional().describe('New text to insert or replace with.'),
    style: TextStyleParameters.optional().describe('Text formatting to apply (bold, italic, font size, etc.).'),
    paragraphStyle: ParagraphStyleParameters.optional().describe('Paragraph formatting to apply (alignment, indentation, headings, spacing, etc.).'),
    tabId: z
        .string()
        .optional()
        .describe('The ID of the specific tab to operate on. If not specified, operates on the first tab.'),
})
    .refine((args) => args.text !== undefined || args.style !== undefined || args.paragraphStyle !== undefined, {
    message: 'At least one of text, style, or paragraphStyle must be provided.',
})
    .refine((args) => {
    if ('insertionIndex' in args.target && args.text === undefined)
        return false;
    return true;
}, { message: 'text is required when using insertionIndex target (no existing range to format).' });
/**
 * Pure, sync function that builds the array of Google Docs API requests for a
 * modifyText operation. Indices must already be resolved (no text-search here).
 */
export function buildModifyTextRequests(opts) {
    const { startIndex, endIndex, text, style, paragraphStyle, tabId } = opts;
    const requests = [];
    if (!text && !style && !paragraphStyle)
        return requests;
    // 1. Delete existing content (only when replacing, not insert-only)
    if (endIndex !== undefined && text !== undefined) {
        const range = { startIndex, endIndex };
        if (tabId)
            range.tabId = tabId;
        requests.push({ deleteContentRange: { range } });
    }
    // 2. Insert new text
    if (text !== undefined) {
        const location = { index: startIndex };
        if (tabId)
            location.tabId = tabId;
        requests.push({ insertText: { location, text } });
    }
    // 3. Apply text formatting
    if (style) {
        const formatStart = startIndex;
        const formatEnd = text !== undefined
            ? startIndex + text.length
            : endIndex !== undefined
                ? endIndex
                : startIndex;
        if (formatEnd > formatStart) {
            const requestInfo = GDocsHelpers.buildUpdateTextStyleRequest(formatStart, formatEnd, style, tabId);
            if (requestInfo) {
                requests.push(requestInfo.request);
            }
        }
    }
    // 4. Apply paragraph formatting
    if (paragraphStyle) {
        const formatStart = startIndex;
        const formatEnd = text !== undefined
            ? startIndex + text.length
            : endIndex !== undefined
                ? endIndex
                : startIndex;
        if (formatEnd > formatStart) {
            const requestInfo = GDocsHelpers.buildUpdateParagraphStyleRequest(formatStart, formatEnd, paragraphStyle, tabId);
            if (requestInfo) {
                requests.push(requestInfo.request);
            }
        }
    }
    return requests;
}
export function register(server) {
    server.addTool({
        name: 'modifyText',
        description: 'Combines text replacement/insertion and formatting in one atomic operation. ' +
            'Can insert text at a position, replace a range or found text, apply text styling (bold, italic, etc.), ' +
            "apply paragraph styling (alignment, headings, spacing, etc.), or any combination. Use readGoogleDoc with format='json' to determine indices.",
        parameters: ModifyTextParameters,
        execute: async (args, { log }) => {
            const docs = await getDocsClient();
            log.info(`modifyText on doc ${args.documentId}: target=${JSON.stringify(args.target)}` +
                `${args.text !== undefined ? `, text="${args.text.substring(0, 50)}"` : ''}` +
                `${args.style ? `, style=${JSON.stringify(args.style)}` : ''}` +
                `${args.paragraphStyle ? `, paragraphStyle=${JSON.stringify(args.paragraphStyle)}` : ''}` +
                `${args.tabId ? `, tab=${args.tabId}` : ''}`);
            try {
                // Verify tab exists if specified
                if (args.tabId) {
                    const docInfo = await docs.documents.get({
                        documentId: args.documentId,
                        includeTabsContent: true,
                        fields: 'tabs(tabProperties,documentTab)',
                    });
                    const targetTab = GDocsHelpers.findTabById(docInfo.data, args.tabId);
                    if (!targetTab) {
                        throw new UserError(`Tab with ID "${args.tabId}" not found in document.`);
                    }
                    if (!targetTab.documentTab) {
                        throw new UserError(`Tab "${args.tabId}" does not have content (may not be a document tab).`);
                    }
                }
                // Resolve target to numeric indices
                let startIndex;
                let endIndex;
                if ('insertionIndex' in args.target) {
                    startIndex = args.target.insertionIndex;
                    endIndex = undefined;
                }
                else if ('textToFind' in args.target) {
                    const range = await GDocsHelpers.findTextRange(docs, args.documentId, args.target.textToFind, args.target.matchInstance, args.tabId);
                    if (!range) {
                        throw new UserError(`Could not find instance ${args.target.matchInstance ?? 1} of text "${args.target.textToFind}"${args.tabId ? ` in tab ${args.tabId}` : ''}.`);
                    }
                    startIndex = range.startIndex;
                    endIndex = range.endIndex;
                    log.info(`Found text "${args.target.textToFind}" at range ${startIndex}-${endIndex}`);
                }
                else {
                    startIndex = args.target.startIndex;
                    endIndex = args.target.endIndex;
                }
                // Clamp to minimum 1 (index 0 is the document section break)
                if (startIndex < 1)
                    startIndex = 1;
                const requests = buildModifyTextRequests({
                    startIndex,
                    endIndex,
                    text: args.text,
                    style: args.style,
                    paragraphStyle: args.paragraphStyle,
                    tabId: args.tabId,
                });
                if (requests.length === 0) {
                    return 'No operations to perform.';
                }
                await GDocsHelpers.executeBatchUpdate(docs, args.documentId, requests);
                // Build descriptive result
                const actions = [];
                if (endIndex !== undefined && args.text !== undefined)
                    actions.push('replaced text');
                else if (args.text !== undefined)
                    actions.push('inserted text');
                if (args.style)
                    actions.push('applied text formatting');
                if (args.paragraphStyle)
                    actions.push('applied paragraph formatting');
                return `Successfully ${actions.join(' and ')} at range ${startIndex}-${endIndex ?? startIndex + (args.text?.length ?? 0)}${args.tabId ? ` in tab ${args.tabId}` : ''}.`;
            }
            catch (error) {
                log.error(`Error in modifyText for doc ${args.documentId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                throw new UserError(`Failed to modify text: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
