import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { getDocsClient } from '../../clients.js';
import { DocumentIdParameter, TextFindParameter, TextStyleParameters, ParagraphStyleParameters } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import { docsJsonToMarkdown } from '../../markdown-transformer/index.js';
import { guardMutation } from '../../readTracker.js';
import { ReadHandleParameter, beginDocsMutation, docsSnapshotFetchers } from '../../docsHandles.js';
import { BULLET_GLYPH_PRESETS } from './formatting/applyParagraphStyle.js';
// modifyText-only extension of the shared ParagraphStyleParameters (issue
// #120): a bullet/numbered-list control that createParagraphBullets /
// deleteParagraphBullets maps onto directly. Deliberately NOT added to the
// shared ParagraphStyleParameters in types.js -- that schema is also used by
// batchModifyText and applyParagraphStyle, neither of which builds a request
// for it, so exposing the field there would silently accept and drop it.
// applyParagraphStyle already has its own richer bulletNestingLevel/
// bulletPreset pair for changing an EXISTING list item's depth; this field
// solves the narrower, more common modifyText case -- a mid-document
// insert/replace that should become (or stop being) a top-level list item in
// the same call that writes the text, without a second tool round-trip that
// has to recompute indices against a document other editors may be touching.
const ModifyTextParagraphStyle = ParagraphStyleParameters.extend({
    bulletPreset: z
        .enum(BULLET_GLYPH_PRESETS)
        .nullable()
        .optional()
        .describe('Turn the target paragraph(s) into a list item using this Docs API bullet glyph preset (e.g. ' +
            '"BULLET_DISC_CIRCLE_SQUARE" for a bulleted list, "NUMBERED_DECIMAL_ALPHA_ROMAN" for a numbered list), ' +
            'or pass null to remove an existing list item\'s bullet. Maps directly onto createParagraphBullets / ' +
            'deleteParagraphBullets over the same range the text/style edit touches, so a mid-document insert can ' +
            'become a real list item in the same call instead of landing as a bare paragraph that visibly does not ' +
            'match a parallel bulleted/numbered section elsewhere in the document. Applies to whichever paragraph(s) ' +
            'the target range covers; to change the nesting DEPTH of an existing list item, use applyParagraphStyle\'s ' +
            'bulletNestingLevel instead.'),
});
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
    clearStyle: z
        .boolean()
        .optional()
        .describe('If true, inserted text lands as plain body text instead of inheriting the character formatting of the run it replaced. ' +
        'Google Docs gives inserted text the formatting of the surrounding run, so replacing a one-line italic placeholder with a long section silently makes the whole section italic. ' +
        'Set this whenever the replacement is new content rather than an in-place edit of an existing phrase. Any `style` you also pass is applied after the clear, so it still wins. ' +
        'Ignored when the call inserts no text. When you do not set it, the result reports any non-default formatting the new text inherited.'),
    paragraphStyle: ModifyTextParagraphStyle.optional().describe('Paragraph formatting to apply (alignment, indentation, headings, spacing, list bullets, etc.).'),
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
    const { startIndex, endIndex, text, style, paragraphStyle, tabId, defaultColor, clearStyle } = opts;
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
        // 2a. Strip the character formatting the insertion inherited from its
        // surrounding run (issue #121). Emitted BEFORE the default-color and
        // caller-style requests below so neither is undone by the clear.
        if (clearStyle) {
            const clearRequest = GDocsHelpers.buildClearTextStyleRequest(startIndex, startIndex + text.length, tabId);
            if (clearRequest) {
                requests.push(clearRequest);
            }
        }
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
            // bulletPreset (issue #120) is not a updateParagraphStyle field at
            // all -- it maps onto the Docs API's separate createParagraphBullets
            // / deleteParagraphBullets requests, so it is pulled out before the
            // rest of paragraphStyle is handed to the ordinary paragraph-style
            // builder (which only reads the fields it knows and would otherwise
            // just silently ignore it).
            const { bulletPreset, ...restParagraphStyle } = paragraphStyle;
            const hasOtherParagraphStyle = Object.values(restParagraphStyle).some((v) => v !== undefined);
            if (hasOtherParagraphStyle) {
                const requestInfo = GDocsHelpers.buildUpdateParagraphStyleRequest(formatStart, formatEnd, restParagraphStyle, tabId);
                if (requestInfo) {
                    requests.push(requestInfo.request);
                }
            }
            if (bulletPreset !== undefined) {
                const range = { startIndex: formatStart, endIndex: formatEnd };
                if (tabId)
                    range.tabId = tabId;
                requests.push(bulletPreset === null
                    ? { deleteParagraphBullets: { range } }
                    : { createParagraphBullets: { range, bulletPreset } });
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
            'apply text styling (bold, italic, etc.), apply paragraph styling (alignment, headings, spacing, list bullets via paragraphStyle.bulletPreset, etc.), or any combination. ' +
            "Use readDocument with format='index' to determine indices — it returns a compact structural map (headings, list items, tables with per-cell indices) instead of the full raw document. " +
            'Supports \\n for line breaks and \\t for tabs in replacement text. ' +
            'When using textToFind, if multiple matches exist the tool returns all instances with context so you can specify matchInstance. ' +
            "textToFind tolerates markdown list markers copied from readDocument(format='markdown'), because Google Docs stores bullets outside text runs. " +
            'For MULTIPLE edits in the same document, use batchModifyText instead: it applies them in one atomic batchUpdate against a single snapshot, so you do not have to recompute indices between edits and a collaborator cannot land halfway through. ' +
            'This tool is TEXT-ONLY: a multi-line replacement is inserted as one blob with a single paragraph style, so markdown syntax (e.g. a literal "- " or "1. " prefix) stays literal and is never parsed into a real list. ' +
            "paragraphStyle.bulletPreset is the one structural exception: it applies a REAL top-level bullet/number (createParagraphBullets) to every paragraph the target range covers — useful for a single inserted line that must match a bulleted/numbered section elsewhere in the document — but it is still one flat preset over the whole range, with no per-line nesting control; for that, or for richer multi-line structure, use replaceRangeWithMarkdown. " +
            'For multi-line, list, or section-level content at a range, use replaceRangeWithMarkdown; to rewrite a whole document, use replaceDocumentWithMarkdown. ' +
            'To add content to the end of a doc, use appendMarkdown or appendText. ' +
            "Newly inserted text carries the document's default text color explicitly, when the document defines one. " +
            'Google Docs also gives inserted text the CHARACTER formatting of the run around it, so replacing an italic placeholder with a long section makes that whole section italic: pass clearStyle:true to insert as plain body text instead. When you do not, the result names any non-default formatting the new text inherited. ' +
            'If the document changed after you read it, a textToFind target is re-resolved against the current document and proceeds when the change did not touch it; an explicit startIndex/endIndex or insertionIndex is refused unless the change landed strictly after the range, because explicit indices have no anchor to re-resolve and an edit before them moves the content they addressed. Prefer textToFind when a document has other editors.',
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
                // --- range-precise conflict check (#108) ---------------------
                // Everything above resolved the target against the document as
                // it was a moment ago. If a collaborator moved the document
                // between the caller's read and now, the guard decides whether
                // that change could have touched THIS range: a textToFind
                // target is re-resolved against the guard's own snapshot (so a
                // change before it shifts the indices harmlessly), while an
                // explicit index is only permitted when every change landed
                // strictly after the end of the range. A permitted write is
                // re-armed onto that snapshot's revision in the same step.
                const isSemantic = 'textToFind' in args.target;
                const guardFetchers = docsSnapshotFetchers(docs, args.documentId, args.tabId ?? null);
                const guarded = await lease.guardTargets({
                    targets: [{
                        kind: isSemantic ? 'semantic' : 'explicit',
                        startIndex,
                        endIndex,
                        describe: isSemantic
                            ? `textToFind "${args.target.textToFind}" (resolved to ${startIndex}-${endIndex})`
                            : (endIndex === undefined ? `index ${startIndex}` : `range ${startIndex}-${endIndex}`),
                    }],
                    ...guardFetchers,
                    reresolve: async ({ document }) => {
                        const found = GDocsHelpers.findTextRangeInDoc(document, args.target.textToFind, args.target.matchInstance, args.tabId);
                        if (!found || found.found === false || found.startIndex === -1) return null;
                        return { startIndex: found.startIndex, endIndex: found.endIndex };
                    },
                });
                if (guarded.changed && guarded.classified) {
                    startIndex = guarded.targets[0].startIndex;
                    endIndex = guarded.targets[0].endIndex;
                    if (startIndex < 1) startIndex = 1;
                    log.info(`modifyText: document changed since the read; target re-resolved to ` +
                        `${startIndex}-${endIndex ?? startIndex} against revision ${guarded.revisionId}`);
                }
                // Normalize escape sequences so literal \n / \t in the input
                // are converted to real newline / tab characters (issue #9).
                const normalizedText = args.text
                    ?.replace(/\\n/g, '\n')
                    .replace(/\\t/g, '\t');
                // Resolve the document's default text color so freshly
                // inserted text carries an explicit foreground color instead
                // of leaving it undefined (issue #14). Only needed when we're
                // actually inserting new text.
                const insertsText = normalizedText !== undefined && normalizedText !== '';
                let defaultColor;
                if (insertsText) {
                    const { color, error: defaultColorError } = await GDocsHelpers.getDefaultTextColor(docs, args.documentId);
                    defaultColor = color;
                    if (defaultColorError) {
                        log.warn(`modifyText: could not fetch document default text color for ${args.documentId}: ${defaultColorError.message}`);
                    }
                }
                // What formatting the new text will inherit (issue #121). Docs
                // gives inserted text the style of the run around it, so for a
                // replacement that is the run being replaced (at startIndex) and
                // for a pure insertion it is the character immediately before
                // the insertion point. Probed only when it can matter: not for a
                // delete, not for a style-only call, and not when clearStyle
                // already guarantees plain text.
                let inheritedStyleNames = [];
                if (insertsText && !args.clearStyle) {
                    const probeIndex = endIndex !== undefined ? startIndex : startIndex - 1;
                    const inheritedStyle = await GDocsHelpers.fetchTextStyleAtIndex(docs, args.documentId, probeIndex, args.tabId);
                    inheritedStyleNames = GDocsHelpers.describeInheritedTextStyle(inheritedStyle);
                }
                const requests = buildModifyTextRequests({
                    startIndex,
                    endIndex,
                    text: normalizedText,
                    style: args.style,
                    paragraphStyle: args.paragraphStyle,
                    tabId: args.tabId,
                    defaultColor,
                    clearStyle: args.clearStyle,
                });
                if (requests.length === 0) {
                    // Nothing was written, so the lease must not stay RESERVED —
                    // release it so the handle is still usable for a follow-up
                    // mutation.
                    await lease.abort();
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
                if (args.paragraphStyle) {
                    const { bulletPreset, ...restParagraphStyle } = args.paragraphStyle;
                    if (Object.values(restParagraphStyle).some((v) => v !== undefined))
                        actions.push('applied paragraph formatting');
                    if (bulletPreset !== undefined)
                        actions.push(bulletPreset === null ? 'removed list bullet' : `applied list formatting (${bulletPreset})`);
                }
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                // Say it in the result, not just in the doc. A silent inherit is
                // how 2,500 characters landed in italic behind a "Successfully
                // replaced text" (issue #121).
                const inheritedNote = inheritedStyleNames.length > 0
                    ? ` The new text inherited ${inheritedStyleNames.join(', ')} from the text around it — ` +
                      'pass clearStyle:true to insert as plain body text instead, or fix it with a follow-up modifyText style call.'
                    : '';
                const clearedNote = args.clearStyle && insertsText
                    ? ' Character formatting was cleared on the new text (clearStyle).'
                    : '';
                return `${docUrl}\nSuccessfully ${actions.join(' and ')} at range ${startIndex}-${endIndex ?? startIndex + (args.text?.length ?? 0)}${args.tabId ? ` in tab ${args.tabId}` : ''}.${clearedNote}${inheritedNote}`;
            }
            catch (error) {
                // A failure before the write (tab not found, text not found, a
                // #108 range rejection) must leave the read handle usable for
                // the corrected retry. After a failed write `lease.write` has
                // already settled the lease with `fail()`, so this is a no-op
                // there and never downgrades a failed write to an abort.
                await lease.abort();
                log.error(`Error in modifyText for doc ${args.documentId}: ${error.message || error}`);
                if (isPublicError(error))
                    throw error;
throw wrapOperationError('modify document text', error, { status: error?.code });
            }
        },
    });
}
