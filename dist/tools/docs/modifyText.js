import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDocsClient } from '../../clients.js';
import { DocumentIdParameter, TextFindParameter, TextStyleParameters, ParagraphStyleParameters } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import { docsJsonToMarkdown } from '../../markdown-transformer/index.js';
import { guardMutation } from '../../readTracker.js';
import { ReadHandleParameter, beginDocsMutation } from '../../docsHandles.js';
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
    readHandle: ReadHandleParameter,
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
 *
 * `defaultColor` (an rgbColor object from getDefaultTextColor) is optional.
 * When present and this call actually inserts new text (not a style-only or
 * delete-only op), a request painting the newly inserted range with that
 * color is emitted right after the insertText request and before any
 * caller-supplied style/paragraphStyle requests — so caller-requested
 * formatting (including an explicit foregroundColor) still wins; it's the
 * last request touching the range (issue #14).
 */
export function buildModifyTextRequests(opts) {
    const { startIndex, endIndex, text, style, paragraphStyle, tabId, defaultColor } = opts;
    const requests = [];
    if (text === undefined && !style && !paragraphStyle)
        return requests;
    // 1. Delete existing content (when replacing or deleting)
    if (endIndex !== undefined && text !== undefined) {
        const range = { startIndex, endIndex };
        if (tabId)
            range.tabId = tabId;
        requests.push({ deleteContentRange: { range } });
    }
    // 2. Insert new text (skip if empty string — that means "delete only")
    if (text !== undefined && text !== '') {
        const location = { index: startIndex };
        if (tabId)
            location.tabId = tabId;
        requests.push({ insertText: { location, text } });
        // 2b. Paint the freshly-created range with the document default
        // foreground color, if one was resolved (issue #14). Only for text
        // that was actually just inserted — never touches existing content.
        const defaultColorRequest = GDocsHelpers.buildDefaultColorStyleRequest(startIndex, startIndex + text.length, defaultColor, tabId);
        if (defaultColorRequest) {
            requests.push(defaultColorRequest);
        }
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
        description: 'Best for small, targeted, single-location changes within a line or paragraph. ' +
            'Can insert text at a position, replace a range or found text, delete text (replace with empty string ""), ' +
            'apply text styling (bold, italic, etc.), apply paragraph styling (alignment, headings, spacing, etc.), or any combination. ' +
            "Use readDocument with format='index' to determine indices — it returns a compact structural map (headings, list items, tables with per-cell indices) instead of the full raw document. " +
            'Supports \\n for line breaks and \\t for tabs in replacement text. ' +
            'When using textToFind, if multiple matches exist the tool returns all instances with context so you can specify matchInstance. ' +
            "textToFind tolerates markdown list markers copied from readDocument(format='markdown'), because Google Docs stores bullets outside text runs. " +
            'This tool is TEXT-ONLY: a multi-line replacement is inserted as one blob with a single paragraph style, so markdown syntax stays literal and list nesting is flattened. ' +
            'For multi-line, list, or section-level content at a range, use replaceRangeWithMarkdown; to rewrite a whole document, use replaceDocumentWithMarkdown. ' +
            'To add content to the end of a doc, use appendMarkdown or appendText. ' +
            "Newly inserted text carries the document's default text color explicitly, when the document defines one.",
        parameters: ModifyTextParameters,
        execute: async (args, { log }) => {
            const docs = await getDocsClient();
            const lease = await beginDocsMutation(args.documentId, {
                tabId: args.tabId ?? null,
                readHandle: args.readHandle,
                legacyGuard: () => guardMutation(args.documentId, {
                    contentFetcher: async () => {
                        const current = await docs.documents.get({ documentId: args.documentId });
                        // Return the revision this content came from alongside the
                        // content itself so guardMutation can refresh both together
                        // instead of leaving revisionId stale after a diff (see
                        // readTracker.js guardMutation for why that matters).
                        return { content: docsJsonToMarkdown(current.data), revisionId: current.data.revisionId };
                    },
                }),
            });
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
                        throw publicError(`Tab with ID "${args.tabId}" not found in document.`);
                    }
                    if (!targetTab.documentTab) {
                        throw publicError(`Tab "${args.tabId}" does not have content (may not be a document tab).`);
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
                    // findTextRange returns a structured failure describing where
                    // matching diverged (issue #105); render it rather than
                    // collapsing it back to "could not find it".
                    if (!range || range.found === false) {
                        throw publicError(range?.message
                            ?? `Could not find text "${args.target.textToFind}"${args.target.matchInstance ? ` (instance ${args.target.matchInstance})` : ''}${args.tabId ? ` in tab ${args.tabId}` : ''}.`);
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
                // Normalize escape sequences so literal \n / \t in the input
                // are converted to real newline / tab characters (issue #9).
                const normalizedText = args.text
                    ?.replace(/\\n/g, '\n')
                    .replace(/\\t/g, '\t');
                // Resolve the document's default text color so freshly
                // inserted text carries an explicit foreground color instead
                // of leaving it undefined (issue #14). Only needed when we're
                // actually inserting new text.
                let defaultColor;
                if (normalizedText !== undefined && normalizedText !== '') {
                    const { color, error: defaultColorError } = await GDocsHelpers.getDefaultTextColor(docs, args.documentId);
                    defaultColor = color;
                    if (defaultColorError) {
                        log.warn(`modifyText: could not fetch document default text color for ${args.documentId}: ${defaultColorError.message}`);
                    }
                }
                const requests = buildModifyTextRequests({
                    startIndex,
                    endIndex,
                    text: normalizedText,
                    style: args.style,
                    paragraphStyle: args.paragraphStyle,
                    tabId: args.tabId,
                    defaultColor,
                });
                if (requests.length === 0) {
                    return 'No operations to perform.';
                }
                await lease.write(
                    (writeControl) => GDocsHelpers.executeBatchUpdate(
                        docs,
                        args.documentId,
                        requests,
                        writeControl
                    ),
                    (response) => response?.writeControl?.requiredRevisionId,
                );
                // Build descriptive result
                const actions = [];
                if (endIndex !== undefined && normalizedText === '')
                    actions.push('deleted text');
                else if (endIndex !== undefined && args.text !== undefined)
                    actions.push('replaced text');
                else if (args.text !== undefined)
                    actions.push('inserted text');
                if (args.style)
                    actions.push('applied text formatting');
                if (args.paragraphStyle)
                    actions.push('applied paragraph formatting');
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                return `${docUrl}\nSuccessfully ${actions.join(' and ')} at range ${startIndex}-${endIndex ?? startIndex + (args.text?.length ?? 0)}${args.tabId ? ` in tab ${args.tabId}` : ''}.`;
            }
            catch (error) {
                log.error(`Error in modifyText for doc ${args.documentId}: ${error.message || error}`);
                if (isPublicError(error))
                    throw error;
throw wrapOperationError('modify document text', error, { status: error?.code });
            }
        },
    });
}
