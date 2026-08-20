import { z } from 'zod';
import { publicError, isPublicError, wrapOperationError } from '../../../errors.js';
import { getDocsClient } from '../../../clients.js';
import { ApplyParagraphStyleToolParameters, ParagraphStyleParameters, NotImplementedError, } from '../../../types.js';
import * as GDocsHelpers from '../../../googleDocsApiHelpers.js';
import { ReadHandleParameter, beginDocsMutation } from '../../../docsHandles.js';

// --- bulletNestingLevel (issue #107 plan, step 3) ---------------------------
//
// `createParagraphBullets` has no field that sets nesting directly (confirmed
// against how `markdown-transformer/markdownToDocs.js` builds nested lists:
// `handleListItemOpen` inserts `'\t'.repeat(level)` as literal document text
// at the start of a list-item paragraph, `:687`, then a single
// `createParagraphBullets` request is issued over the merged range, `:1272` —
// the API infers each item's depth from its own leading-tab count, not from a
// request parameter). So setting an explicit level here means: read the
// paragraph(s), delete any existing bullet, insert/delete leading tab
// characters to match the requested depth, then recreate the bullet. That is
// the "documented API mechanism" the plan asks to verify against the
// importer's working encoding — this mirrors it exactly, including applying
// per-paragraph requests bottom-to-top so an earlier paragraph's tab
// insert/delete never shifts the range of one not yet processed.

const NUMBERED_GLYPH_HINT = /DECIMAL|ALPHA|ROMAN/;

function countLeadingTabs(text) {
    let count = 0;
    while (count < text.length && text[count] === '\t') count += 1;
    return count;
}

function firstRunText(paragraph) {
    const firstElement = (paragraph?.elements ?? [])[0];
    return firstElement?.textRun?.content ?? '';
}

/** Preset inferred from the list the paragraph already belongs to (plan: "preset inferred from the existing list"). */
function inferBulletPresetFromList(bullet, lists) {
    if (!bullet?.listId) return null;
    const list = lists?.[bullet.listId];
    const nestingLevels = list?.listProperties?.nestingLevels ?? [];
    const level = bullet.nestingLevel ?? 0;
    const glyphType = nestingLevels[level]?.glyphType ?? nestingLevels[0]?.glyphType;
    if (glyphType && NUMBERED_GLYPH_HINT.test(glyphType)) return 'NUMBERED_DECIMAL_ALPHA_ROMAN';
    return 'BULLET_DISC_CIRCLE_SQUARE';
}

async function fetchParagraphStructure(docs, documentId, tabId) {
    const fields = tabId
        ? 'tabs(tabProperties(tabId),documentTab(body(content(startIndex,endIndex,paragraph(bullet,elements(startIndex,endIndex,textRun(content))))),lists))'
        : 'body(content(startIndex,endIndex,paragraph(bullet,elements(startIndex,endIndex,textRun(content))))),lists';
    const response = await docs.documents.get({
        documentId,
        ...(tabId ? { includeTabsContent: true } : {}),
        fields,
    });
    if (tabId) {
        const tab = GDocsHelpers.findTabById(response.data, tabId);
        if (!tab) throw publicError(`Tab with ID "${tabId}" not found in document.`);
        if (!tab.documentTab) throw publicError(`Tab "${tabId}" does not have content (may not be a document tab).`);
        return { content: tab.documentTab.body?.content ?? [], lists: tab.documentTab.lists ?? {} };
    }
    return { content: response.data.body?.content ?? [], lists: response.data.lists ?? {} };
}

/**
 * Resolves [startIndex, endIndex) to the whole paragraphs it covers and
 * builds the delete-bullets / adjust-tabs / create-bullets requests for each,
 * applied bottom-to-top in a single array (one batchUpdate, per the plan).
 */
export async function buildBulletNestingRequests({ docs, documentId, tabId, startIndex, endIndex, bulletNestingLevel, bulletPreset, }) {
    const { content, lists } = await fetchParagraphStructure(docs, documentId, tabId);
    const overlapping = content.filter((element) => typeof element.startIndex === 'number'
        && typeof element.endIndex === 'number'
        && element.endIndex > startIndex && element.startIndex < endIndex);
    const nonParagraph = overlapping.find((element) => !element.paragraph);
    if (nonParagraph) {
        throw publicError(`The range ${startIndex}-${endIndex} overlaps a non-paragraph element at ` +
            `${nonParagraph.startIndex}-${nonParagraph.endIndex} (e.g. a table). bulletNestingLevel can only be ` +
            'applied to a range of whole paragraphs.');
    }
    const first = overlapping[0];
    const last = overlapping[overlapping.length - 1];
    if (!first || !last || first.startIndex !== startIndex || last.endIndex !== endIndex) {
        throw publicError(`The range ${startIndex}-${endIndex} does not align to whole paragraph boundaries ` +
            '(it starts or ends inside a paragraph). bulletNestingLevel requires a whole-paragraph range — pass ' +
            'indices that match paragraph boundaries, e.g. from readDocument with format=\'index\'.');
    }
    const paragraphs = overlapping.map((element) => ({
        startIndex: element.startIndex,
        endIndex: element.endIndex,
        bullet: element.paragraph.bullet ?? null,
        currentTabs: countLeadingTabs(firstRunText(element.paragraph)),
    }));
    const distinctListIds = new Set(paragraphs.map((p) => p.bullet?.listId).filter(Boolean));
    if (distinctListIds.size > 1) {
        throw publicError(`The range ${startIndex}-${endIndex} covers paragraphs from more than one list ` +
            `(listIds: ${[...distinctListIds].join(', ')}). Mixed-list ranges are rejected rather than silently merged — ` +
            'target one list at a time.');
    }
    let presetToUse = bulletPreset ?? null;
    if (!presetToUse) {
        const withBullet = paragraphs.find((p) => p.bullet?.listId);
        presetToUse = withBullet ? inferBulletPresetFromList(withBullet.bullet, lists) : null;
    }
    if (!presetToUse) {
        throw publicError('None of the targeted paragraphs are currently list items, so a bullet style cannot be ' +
            'inferred. Pass bulletPreset (e.g. "BULLET_DISC_CIRCLE_SQUARE" or "NUMBERED_DECIMAL_ALPHA_ROMAN") to set one explicitly.');
    }
    const requests = [];
    const bottomToTop = [...paragraphs].sort((a, b) => b.startIndex - a.startIndex);
    for (const paragraph of bottomToTop) {
        const range = { startIndex: paragraph.startIndex, endIndex: paragraph.endIndex, ...(tabId ? { tabId } : {}) };
        requests.push({ deleteParagraphBullets: { range } });
        const delta = bulletNestingLevel - paragraph.currentTabs;
        let newEnd = paragraph.endIndex;
        if (delta > 0) {
            requests.push({
                insertText: {
                    location: { index: paragraph.startIndex, ...(tabId ? { tabId } : {}) },
                    text: '\t'.repeat(delta),
                },
            });
            newEnd += delta;
        }
        else if (delta < 0) {
            requests.push({
                deleteContentRange: {
                    range: { startIndex: paragraph.startIndex, endIndex: paragraph.startIndex + (-delta), ...(tabId ? { tabId } : {}) },
                },
            });
            newEnd += delta;
        }
        requests.push({
            createParagraphBullets: {
                range: { startIndex: paragraph.startIndex, endIndex: newEnd, ...(tabId ? { tabId } : {}) },
                bulletPreset: presetToUse,
            },
        });
    }
    return requests;
}

export function register(server) {
    server.addTool({
        name: 'applyParagraphStyle',
        description: 'Applies paragraph-level formatting (alignment, spacing, heading styles) to paragraphs identified by a character range or by searching for text. Use namedStyleType to set heading levels (HEADING_1 through HEADING_6). ' +
            'Pass bulletNestingLevel (0-8) to set a paragraph\'s list depth explicitly — the target must resolve to whole paragraphs; the bullet style is inferred from the existing list, or set it with bulletPreset for paragraphs that are not yet list items.',
        parameters: ApplyParagraphStyleToolParameters.extend({
            readHandle: ReadHandleParameter,
            // Overrides the base `style` field: the base schema requires at least
            // one style option via `.refine`, which would reject a call that only
            // wants to set bulletNestingLevel. The "at least one option overall"
            // rule is enforced in execute() instead, across style + bulletNestingLevel.
            style: ParagraphStyleParameters.optional().describe('The paragraph styling to apply. Optional when bulletNestingLevel is provided.'),
            bulletNestingLevel: z
                .number()
                .int()
                .min(0)
                .max(8)
                .optional()
                .describe('Sets the target paragraph(s) list nesting depth explicitly (0 = top level). The target must resolve to whole paragraphs and, if it spans more than one, they must all belong to the same list (or none). Emits deleteParagraphBullets, leading-tab adjustment, and createParagraphBullets in one batchUpdate.'),
            bulletPreset: z
                .string()
                .min(1)
                .optional()
                .describe('Bullet glyph preset to use when setting bulletNestingLevel on paragraphs that are not already list items (e.g. "BULLET_DISC_CIRCLE_SQUARE", "NUMBERED_DECIMAL_ALPHA_ROMAN"). Ignored without bulletNestingLevel. When the paragraphs already belong to a list, the existing list\'s style is reused unless this is set.'),
        }),
        execute: async (args, { log }) => {
            const docs = await getDocsClient();
            let startIndex;
            let endIndex;
            log.info(`Applying paragraph style to document ${args.documentId}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);
            log.info(`Style options: ${JSON.stringify(args.style)}`);
            log.info(`Target specification: ${JSON.stringify(args.target)}`);
            try {
                // STEP 1: Determine the target paragraph's range based on the targeting method
                if ('textToFind' in args.target) {
                    // Find the text first
                    log.info(`Finding text "${args.target.textToFind}" (instance ${args.target.matchInstance ?? 'auto'})${args.tabId ? ` in tab ${args.tabId}` : ''}`);
                    const textRange = await GDocsHelpers.findTextRange(docs, args.documentId, args.target.textToFind, args.target.matchInstance, args.tabId);
                    if (!textRange || textRange.found === false) {
                        throw publicError(textRange?.message
                            ?? `Could not find "${args.target.textToFind}" in the document${args.tabId ? ` (tab: ${args.tabId})` : ''}.`);
                    }
                    log.info(`Found text at range ${textRange.startIndex}-${textRange.endIndex}, now locating containing paragraph`);
                    // Then find the paragraph containing this text
                    const paragraphRange = await GDocsHelpers.getParagraphRange(docs, args.documentId, textRange.startIndex, args.tabId);
                    if (!paragraphRange) {
                        throw publicError(`Found the text but could not determine the paragraph boundaries.`);
                    }
                    startIndex = paragraphRange.startIndex;
                    endIndex = paragraphRange.endIndex;
                    log.info(`Text is contained within paragraph at range ${startIndex}-${endIndex}`);
                }
                else if ('indexWithinParagraph' in args.target) {
                    // Find paragraph containing the specified index
                    log.info(`Finding paragraph containing index ${args.target.indexWithinParagraph}${args.tabId ? ` in tab ${args.tabId}` : ''}`);
                    const paragraphRange = await GDocsHelpers.getParagraphRange(docs, args.documentId, args.target.indexWithinParagraph, args.tabId);
                    if (!paragraphRange) {
                        throw publicError(`Could not find paragraph containing index ${args.target.indexWithinParagraph}${args.tabId ? ` in tab ${args.tabId}` : ''}.`);
                    }
                    startIndex = paragraphRange.startIndex;
                    endIndex = paragraphRange.endIndex;
                    log.info(`Located paragraph at range ${startIndex}-${endIndex}`);
                }
                else if ('startIndex' in args.target && 'endIndex' in args.target) {
                    // Use directly provided range
                    startIndex = args.target.startIndex;
                    endIndex = args.target.endIndex;
                    log.info(`Using provided paragraph range ${startIndex}-${endIndex}`);
                }
                // Verify that we have a valid range
                if (startIndex === undefined || endIndex === undefined) {
                    throw publicError('Could not determine target paragraph range from the provided information.');
                }
                if (endIndex <= startIndex) {
                    throw publicError(`Invalid paragraph range: end index (${endIndex}) must be greater than start index (${startIndex}).`);
                }
                // STEP 2: Build the paragraph style request (if any style options were given)
                const style = args.style ?? {};
                const hasStyleOptions = Object.values(style).some((value) => value !== undefined);
                const bulletNestingLevel = args.bulletNestingLevel;
                if (!hasStyleOptions && bulletNestingLevel === undefined) {
                    throw publicError('At least one paragraph style option or bulletNestingLevel must be provided.');
                }
                let requestInfo = null;
                if (hasStyleOptions) {
                    log.info(`Building paragraph style request for range ${startIndex}-${endIndex}`);
                    requestInfo = GDocsHelpers.buildUpdateParagraphStyleRequest(startIndex, endIndex, style, args.tabId);
                    if (requestInfo) log.info(`Applying styles: ${requestInfo.fields.join(', ')}`);
                }
                const lease = await beginDocsMutation(args.documentId, {
                    tabId: args.tabId ?? null,
                    readHandle: args.readHandle,
                });
                // STEP 3: Resolve bulletNestingLevel into delete/adjust/create-bullets
                // requests, if requested. Failures here are pure validation (no write
                // has happened yet), so the lease is released rather than settled as
                // a failed mutation, keeping the caller's read handle usable for a
                // corrected retry.
                let bulletRequests = [];
                if (bulletNestingLevel !== undefined) {
                    try {
                        bulletRequests = await buildBulletNestingRequests({
                            docs,
                            documentId: args.documentId,
                            tabId: args.tabId ?? null,
                            startIndex,
                            endIndex,
                            bulletNestingLevel,
                            bulletPreset: args.bulletPreset ?? null,
                        });
                    }
                    catch (error) {
                        await lease.abort();
                        throw error;
                    }
                    log.info(`Setting bulletNestingLevel=${bulletNestingLevel} on the paragraph(s) in ${startIndex}-${endIndex} (${bulletRequests.length} requests).`);
                }
                const allRequests = [...(requestInfo ? [requestInfo.request] : []), ...bulletRequests];
                await lease.write(
                    (writeControl) => GDocsHelpers.executeBatchUpdate(docs, args.documentId, allRequests, writeControl),
                    (response) => response?.writeControl?.requiredRevisionId,
                );
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                const parts = [];
                if (requestInfo) parts.push(`paragraph styles (${requestInfo.fields.join(', ')})`);
                if (bulletNestingLevel !== undefined) parts.push(`bulletNestingLevel (${bulletNestingLevel})`);
                return `${docUrl}\nSuccessfully applied ${parts.join(' and ')} to the paragraph${args.tabId ? ` in tab ${args.tabId}` : ''}.`;
            }
            catch (error) {
                // Detailed error logging
                log.error(`Error applying paragraph style in doc ${args.documentId}:`);
                log.error(error.stack || error.message || error);
                if (isPublicError(error))
                    throw error;
                if (error instanceof NotImplementedError)
                    throw error;
                // Provide a more helpful error message
throw wrapOperationError('apply document paragraph style', error, { status: error?.code });
            }
        },
    });
}
