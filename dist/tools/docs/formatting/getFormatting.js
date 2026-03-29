import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDocsClient } from '../../../clients.js';
import { DocumentIdParameter, TextFindParameter } from '../../../types.js';
import * as GDocsHelpers from '../../../googleDocsApiHelpers.js';

const RangeTarget = z.object({
    startIndex: z.number().int().min(1).describe('Start of range (inclusive, 1-based).'),
    endIndex: z.number().int().min(1).describe('End of range (exclusive).'),
}).refine((d) => d.endIndex > d.startIndex, {
    message: 'endIndex must be greater than startIndex',
    path: ['endIndex'],
});

const GetFormattingParameters = DocumentIdParameter.extend({
    target: z
        .union([RangeTarget, TextFindParameter])
        .describe('Target by range indices or text search.'),
    tabId: z
        .string()
        .optional()
        .describe('The ID of the specific tab to read from. If not specified, reads from the first tab.'),
});

/**
 * Extracts text style and paragraph style info from document elements
 * that overlap the given range.
 */
function extractFormattingFromContent(bodyContent, startIndex, endIndex) {
    const textStyles = [];
    const paragraphStyles = [];

    for (const element of bodyContent) {
        if (!element.paragraph) continue;

        const para = element.paragraph;
        // Check if this paragraph overlaps our range
        const paraElements = para.elements || [];
        let paragraphOverlaps = false;

        for (const pe of paraElements) {
            const elStart = pe.startIndex ?? 0;
            const elEnd = pe.endIndex ?? 0;

            // Check overlap with our target range
            if (elEnd > startIndex && elStart < endIndex) {
                paragraphOverlaps = true;
                if (pe.textRun) {
                    const text = pe.textRun.content || '';
                    const style = pe.textRun.textStyle || {};
                    // Only include non-empty style properties
                    const cleanStyle = {};
                    if (style.bold) cleanStyle.bold = true;
                    if (style.italic) cleanStyle.italic = true;
                    if (style.underline) cleanStyle.underline = true;
                    if (style.strikethrough) cleanStyle.strikethrough = true;
                    if (style.fontSize) cleanStyle.fontSize = style.fontSize;
                    if (style.foregroundColor?.color?.rgbColor) cleanStyle.foregroundColor = style.foregroundColor.color.rgbColor;
                    if (style.backgroundColor?.color?.rgbColor) cleanStyle.backgroundColor = style.backgroundColor.color.rgbColor;
                    if (style.weightedFontFamily) cleanStyle.fontFamily = style.weightedFontFamily.fontFamily;
                    if (style.link) cleanStyle.link = style.link;
                    if (style.baselineOffset && style.baselineOffset !== 'BASELINE_OFFSET_UNSPECIFIED') cleanStyle.baselineOffset = style.baselineOffset;

                    textStyles.push({
                        startIndex: elStart,
                        endIndex: elEnd,
                        text: text.replace(/\n$/, ''),
                        style: cleanStyle,
                    });
                }
            }
        }

        if (paragraphOverlaps && para.paragraphStyle) {
            const ps = para.paragraphStyle;
            const cleanStyle = {};
            if (ps.namedStyleType && ps.namedStyleType !== 'NORMAL_TEXT') cleanStyle.namedStyleType = ps.namedStyleType;
            if (ps.alignment && ps.alignment !== 'START') cleanStyle.alignment = ps.alignment;
            if (ps.indentStart?.magnitude) cleanStyle.indentStart = ps.indentStart.magnitude;
            if (ps.indentEnd?.magnitude) cleanStyle.indentEnd = ps.indentEnd.magnitude;
            if (ps.spaceAbove?.magnitude) cleanStyle.spaceAbove = ps.spaceAbove.magnitude;
            if (ps.spaceBelow?.magnitude) cleanStyle.spaceBelow = ps.spaceBelow.magnitude;
            if (ps.keepWithNext) cleanStyle.keepWithNext = true;
            if (ps.lineSpacing) cleanStyle.lineSpacing = ps.lineSpacing;
            if (ps.direction && ps.direction !== 'LEFT_TO_RIGHT') cleanStyle.direction = ps.direction;

            // Always include namedStyleType even if NORMAL_TEXT for clarity
            if (!cleanStyle.namedStyleType) cleanStyle.namedStyleType = 'NORMAL_TEXT';

            paragraphStyles.push({
                paragraphStartIndex: element.startIndex,
                paragraphEndIndex: element.endIndex,
                style: cleanStyle,
            });
        }
    }

    return { textStyles, paragraphStyles };
}

export function register(server) {
    server.addTool({
        name: 'getFormatting',
        description: 'Returns the text styling (bold, italic, font, colors, etc.) and paragraph styling ' +
            '(alignment, headings, spacing, indentation) for a specific range or found text in a Google Doc.',
        parameters: GetFormattingParameters,
        execute: async (args, { log }) => {
            const docs = await getDocsClient();
            log.info(`getFormatting on doc ${args.documentId}: target=${JSON.stringify(args.target)}` +
                `${args.tabId ? `, tab=${args.tabId}` : ''}`);
            try {
                // Resolve target to numeric indices
                let startIndex;
                let endIndex;

                if ('textToFind' in args.target) {
                    const range = await GDocsHelpers.findTextRange(
                        docs, args.documentId, args.target.textToFind,
                        args.target.matchInstance, args.tabId
                    );
                    if (!range) {
                        throw new UserError(
                            `Could not find instance ${args.target.matchInstance ?? 1} of text "${args.target.textToFind}"${args.tabId ? ` in tab ${args.tabId}` : ''}.`
                        );
                    }
                    startIndex = range.startIndex;
                    endIndex = range.endIndex;
                } else {
                    startIndex = args.target.startIndex;
                    endIndex = args.target.endIndex;
                }

                // Fetch document with full content
                const needsTabsContent = !!args.tabId;
                const res = await docs.documents.get({
                    documentId: args.documentId,
                    ...(needsTabsContent && { includeTabsContent: true }),
                    fields: needsTabsContent ? '*' : 'body(content)',
                });

                let bodyContent;
                if (args.tabId) {
                    const targetTab = GDocsHelpers.findTabById(res.data, args.tabId);
                    if (!targetTab) {
                        throw new UserError(`Tab with ID "${args.tabId}" not found in document.`);
                    }
                    bodyContent = targetTab.documentTab?.body?.content;
                } else {
                    bodyContent = res.data.body?.content;
                }

                if (!bodyContent) {
                    throw new UserError('Document has no content.');
                }

                const result = extractFormattingFromContent(bodyContent, startIndex, endIndex);

                return JSON.stringify({
                    range: { startIndex, endIndex },
                    textStyles: result.textStyles,
                    paragraphStyles: result.paragraphStyles,
                }, null, 2);
            } catch (error) {
                log.error(`Error in getFormatting for doc ${args.documentId}: ${error.message || error}`);
                if (error instanceof UserError) throw error;
                throw new UserError(`Failed to get formatting: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
