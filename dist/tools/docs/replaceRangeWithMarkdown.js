// Section-scoped markdown replace (issue #107, canonical for #104).
//
// The gap this closes: every existing write path is at one of two extremes.
// `replaceDocumentWithMarkdown` builds real list/heading structure but only for
// the whole body; `appendMarkdown` only at the end; `modifyText` works at any
// range but is text-only by construction (one insertText plus one
// updateParagraphStyle over the whole blob), which is why a multi-line
// replacement there flattens nesting. The markdown importer is already
// index-parameterized (`insertMarkdown({ startIndex })`), so what was missing is
// a tool that accepts a caller-chosen range.
//
// --- Ordering: insert, then delete (deliberate deviation from the plan) ------
//
// docs/plans/issue-107-section-scoped-markdown-replace.md specifies
// delete -> survivor cleanup -> insert, generalizing replaceDocumentWithMarkdown.
// That order is correct for a whole-body replace and wrong for a scoped range:
//
//   * Paragraph properties in the Docs data model live on the paragraph mark
//     (the trailing newline). After deleting a scoped range [start, end), the
//     paragraph that now begins at `start` is the FOLLOWING paragraph, which is
//     content OUTSIDE the range. The plan's "clean the survivor" step would
//     therefore strip bullets and styles from a paragraph the caller never
//     asked us to touch, and inserting at `start` would make the new content
//     inherit that outside paragraph's style (the common #107 case: a section
//     followed by the next heading, so every inserted paragraph comes out as a
//     HEADING_2).
//   * A failure between the two writes loses the section outright.
//
// Inserting first fixes both. The insertion point is the range's OWN first
// paragraph, so the boundary cleanup (bullets, text style, paragraph style)
// targets content we are about to delete anyway, never outside content. The old
// range is then deleted from its shifted position [start + L, end + L), where L
// is the net growth of the body measured across the insert -- measured rather
// than computed, because `createParagraphBullets` consumes the leading tab
// characters the converter emits for nesting, so the inserted length is not the
// sum of the insertText payloads. And a failure after the insert leaves the
// document with BOTH copies (recoverable, reported with the exact range to
// delete) instead of a hole.
//
// Revision safety: one `beginDocsMutation` lease authorizes the operation and a
// `createWriteControlChain` carries requiredRevisionId across every batch,
// exactly as replaceDocumentWithMarkdown does. Since #108 the lease is also
// range-scoped: `lease.guardTargets` classifies whether a concurrent edit could
// have touched the resolved range, re-resolves `heading`/`textToFind` targets
// against the same snapshot it classified, and re-arms the lease onto that
// snapshot's revision — so the chain below starts from the revision the guard
// authorized, never a stale one. Explicit start/end indices keep the strict
// behavior: a change anywhere before the end of the range is a conflict.
import * as fs from 'fs/promises';
import { z } from 'zod';
import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { getDocsClient } from '../../clients.js';
import { DocumentIdParameter, MarkdownConversionError } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import {
    insertMarkdown,
    formatInsertResult,
    docsJsonToMarkdown,
    checkMarkdownFidelity,
} from '../../markdown-transformer/index.js';
import { guardMutation } from '../../readTracker.js';
import { ReadHandleParameter, beginDocsMutation } from '../../docsHandles.js';
import { walkTabFilter } from '../../docsChangePrecision.js';
import { NODE_KINDS, walkDocument } from '../../docsStructure.js';

const INDEX_HINT = "Call readDocument with format='index' to get current element indices.";

// --- structural model -------------------------------------------------------

/** Same rule docsIndex.js / docsToMarkdown.js use, so the three never disagree. */
function headingLevelOf(paragraph) {
    const styleType = paragraph?.paragraphStyle?.namedStyleType;
    if (!styleType) return null;
    if (styleType === 'TITLE') return 1;
    if (styleType === 'SUBTITLE') return 2;
    const match = /^HEADING_(\d)$/.exec(styleType);
    return match ? parseInt(match[1], 10) : null;
}

/**
 * Top-level structural elements of one body, with FULL heading text.
 *
 * Deliberately not `buildDocumentIndex`: its `preview` is truncated to 80
 * characters, and heading resolution here matches on the whole heading, so a
 * long heading must not silently mis-match (plan, "Range resolution").
 */
export function collectRangeElements(contentSource) {
    const elements = [];
    let textTarget = null;
    for (const node of walkDocument(contentSource, { includeTabNodes: false })) {
        switch (node.kind) {
            case NODE_KINDS.PARAGRAPH: {
                if (node.depth !== 0) { textTarget = null; break; }
                const paragraph = node.node?.paragraph;
                const level = headingLevelOf(paragraph);
                const entry = {
                    start: node.startIndex,
                    end: node.endIndex,
                    node: node.node,
                    type: paragraph?.bullet ? 'listItem' : (level !== null ? 'heading' : 'paragraph'),
                    level,
                    headingId: paragraph?.paragraphStyle?.headingId ?? null,
                    text: '',
                };
                elements.push(entry);
                textTarget = entry;
                break;
            }
            case NODE_KINDS.TEXT_RUN: {
                if (textTarget && node.depth === 1) textTarget.text += node.node?.content ?? '';
                break;
            }
            case NODE_KINDS.TABLE: {
                if (node.depth !== 0) break;
                elements.push({
                    start: node.startIndex,
                    end: node.endIndex,
                    node: node.node,
                    type: 'table',
                    level: null,
                    headingId: null,
                    text: '',
                    rows: node.node?.table?.rows ?? node.node?.table?.tableRows?.length ?? 0,
                    columns: node.node?.table?.columns ?? node.node?.table?.tableRows?.[0]?.tableCells?.length ?? 0,
                });
                textTarget = null;
                break;
            }
            case NODE_KINDS.SECTION_BREAK:
            case NODE_KINDS.TABLE_OF_CONTENTS: {
                if (node.depth !== 0) break;
                elements.push({
                    start: node.startIndex,
                    end: node.endIndex,
                    node: node.node,
                    type: node.kind === NODE_KINDS.SECTION_BREAK ? 'sectionBreak' : 'tableOfContents',
                    level: null,
                    headingId: null,
                    text: '',
                });
                textTarget = null;
                break;
            }
            default:
                break;
        }
    }
    return elements;
}

const normalizeHeading = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function describeElement(element) {
    const label = element.type === 'heading'
        ? `heading (level ${element.level})`
        : element.type;
    const text = element.text.replace(/\s+/g, ' ').trim();
    return `${label} at ${element.start}-${element.end}${text ? `: "${text.slice(0, 60)}"` : ''}`;
}

// --- range resolution -------------------------------------------------------

/**
 * Turn the caller's `target` into `{ start, end, mode }` against the CURRENT
 * document. Pure apart from the text-search mode, which needs the API client.
 */
export async function resolveTargetRange({ docs, documentId, tabId, target, preserveHeading, elements, maxIndex }) {
    if ('startIndex' in target) {
        return { start: target.startIndex, end: target.endIndex, mode: 'indices' };
    }
    if ('textToFind' in target) {
        const found = await GDocsHelpers.findTextRange(docs, documentId, target.textToFind, target.matchInstance, tabId);
        if (!found || found.found === false || found.startIndex === -1) {
            throw publicError(found?.message
                ?? `Could not find text "${target.textToFind}"${tabId ? ` in tab ${tabId}` : ''}. ${INDEX_HINT}`);
        }
        return { start: found.startIndex, end: found.endIndex, mode: 'textToFind' };
    }
    // Heading mode.
    const headings = elements.filter((element) => element.type === 'heading');
    const selector = target.headingId
        ? (element) => element.headingId === target.headingId
        : (element) => normalizeHeading(element.text) === normalizeHeading(target.afterHeading);
    const matches = headings.filter(selector);
    const wanted = target.headingId ? `headingId "${target.headingId}"` : `heading "${target.afterHeading}"`;
    if (matches.length === 0) {
        const available = headings.length
            ? headings.slice(0, 20).map((h) => `  level ${h.level} at ${h.start}-${h.end}: "${h.text.trim()}"`).join('\n')
            : '  (this document has no headings)';
        throw publicError(`No ${wanted} found in this document${tabId ? ` (tab ${tabId})` : ''}. Headings present:\n${available}\n${INDEX_HINT}`);
    }
    if (matches.length > 1) {
        const listing = matches.map((h, i) => `  ${i + 1}. level ${h.level} at index ${h.start}-${h.end}: "${h.text.trim()}"`).join('\n');
        throw publicError(`Found ${matches.length} headings matching ${wanted}. ` +
            `Disambiguate with headingId, or address the section by explicit startIndex/endIndex:\n${listing}`);
    }
    const heading = matches[0];
    const stopLevel = target.untilNextHeadingOfLevel ?? heading.level;
    const following = elements.find((element) => element.start >= heading.end
        && element.type === 'heading'
        && element.level !== null
        && element.level <= stopLevel);
    // A heading that is itself the document's last paragraph has no section
    // below it; `heading.end` is then one past the last addressable index, so
    // clamp it back to an insertion at the end of the body rather than emitting
    // a backwards range.
    const start = Math.min(preserveHeading ? heading.end : heading.start, maxIndex);
    const end = Math.max(following ? following.start : maxIndex, start);
    return { start, end, mode: 'heading', heading };
}

// --- range validation -------------------------------------------------------

/**
 * Structural sanity for the resolved range, before anything destructive runs.
 * Every failure names an alternative, because the overwhelmingly likely cause
 * of a bad range is indices read before a concurrent edit.
 */
export function validateRange({ start, end, mode, elements, maxIndex, tabId }) {
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw publicError('The replacement range must resolve to integer indices.');
    }
    if (start < 1) {
        throw publicError(`startIndex must be at least 1 (index 0 is the document's section break). Got ${start}.`);
    }
    if (end < start) {
        throw publicError(`endIndex (${end}) must not be before startIndex (${start}).`);
    }
    if (end > maxIndex) {
        throw publicError(`The range ${start}-${end} runs past the end of the ` +
            `${tabId ? `tab "${tabId}"` : 'document body'}, whose last addressable index is ${maxIndex}. ` +
            `The document may have changed since the indices were read. ${INDEX_HINT}`);
    }
    for (const element of elements) {
        if (element.type !== 'table') continue;
        const startsInside = start > element.start && start < element.end;
        const endsInside = end > element.start && end < element.end;
        if (startsInside || endsInside) {
            throw publicError(`The range ${start}-${end} ${startsInside ? 'starts' : 'ends'} inside the ` +
                `${element.rows}x${element.columns} table at ${element.start}-${element.end}. ` +
                'A partial table or single-cell range cannot be replaced with markdown; ' +
                'either cover the whole table or target the cell content with modifyText.');
        }
    }
    const startAligned = elements.some((element) => element.start === start);
    const endAligned = end === maxIndex || elements.some((element) => element.end === end);
    // An insertion (start === end) never splits anything: it joins whatever
    // paragraph encloses the index, which is legitimate in every mode.
    if (start !== end && (!startAligned || !endAligned) && mode !== 'indices') {
        const enclosing = elements.find((element) => start >= element.start && start < element.end)
            ?? elements.find((element) => end > element.start && end <= element.end);
        throw publicError(`The resolved range ${start}-${end} splits a paragraph, which is only allowed when you ` +
            'pass startIndex/endIndex explicitly (markdown blocks cannot be built inside half a paragraph). ' +
            (enclosing ? `The enclosing ${describeElement(enclosing)} — pass its indices to replace it whole. ` : '') +
            INDEX_HINT);
    }
    return { startAligned, endAligned };
}

// --- fidelity ---------------------------------------------------------------

/**
 * `checkMarkdownFidelity` restricted to the range. Fully covered elements are
 * scanned as-is; a partially covered paragraph is reduced to the inline
 * elements that actually fall inside the range, so an image just outside the
 * boundary is not reported and one just inside is not silently included.
 */
export function scanRangeFidelity(elements, start, end) {
    const scanned = [];
    for (const element of elements) {
        if (element.end <= start || element.start >= end) continue;
        if (element.start >= start && element.end <= end) {
            scanned.push(element.node);
            continue;
        }
        const paragraph = element.node?.paragraph;
        if (!paragraph) continue;
        const covered = (paragraph.elements ?? []).filter((pe) => typeof pe.startIndex === 'number'
            && typeof pe.endIndex === 'number'
            && pe.startIndex >= start
            && pe.endIndex <= end);
        if (covered.length > 0) scanned.push({ paragraph: { elements: covered } });
    }
    return checkMarkdownFidelity(scanned);
}

// --- write helpers ----------------------------------------------------------

function rangeFor(startIndex, endIndex, tabId) {
    return { startIndex, endIndex, ...(tabId ? { tabId } : {}) };
}

/**
 * Strip the boundary paragraph back to a neutral paragraph. Applied to the
 * FIRST paragraph of the range (content we are about to delete), so the
 * markdown inserted at that point inherits nothing from the old content — no
 * list membership, no heading style, no leftover bold/colour.
 */
export function buildBoundaryCleanupRequests(startIndex, endIndex, tabId) {
    const range = rangeFor(startIndex, endIndex, tabId);
    return [
        { deleteParagraphBullets: { range } },
        {
            updateTextStyle: {
                range,
                textStyle: {
                    underline: false,
                    bold: false,
                    italic: false,
                    strikethrough: false,
                    foregroundColor: {},
                    backgroundColor: {},
                },
                fields: 'underline,bold,italic,strikethrough,foregroundColor,backgroundColor',
            },
        },
        {
            updateParagraphStyle: {
                range,
                paragraphStyle: {
                    namedStyleType: 'NORMAL_TEXT',
                    alignment: 'START',
                    indentStart: { magnitude: 0, unit: 'PT' },
                    indentFirstLine: { magnitude: 0, unit: 'PT' },
                },
                fields: 'namedStyleType,alignment,indentStart,indentFirstLine',
            },
        },
    ];
}

async function fetchBody(docs, documentId, tabId, fields) {
    const response = await docs.documents.get({
        documentId,
        includeTabsContent: !!tabId,
        fields,
    });
    if (!tabId) {
        return { contentSource: response.data, content: response.data.body?.content, revisionId: response.data.revisionId };
    }
    const tab = GDocsHelpers.findTabById(response.data, tabId);
    if (!tab) throw publicError(`Tab with ID "${tabId}" not found in document.`);
    if (!tab.documentTab) throw publicError(`Tab "${tabId}" does not have content (may not be a document tab).`);
    return {
        contentSource: { body: tab.documentTab.body, lists: tab.documentTab.lists },
        content: tab.documentTab.body?.content,
        revisionId: response.data.revisionId,
    };
}

async function fetchBodyEnd(docs, documentId, tabId) {
    const { content } = await fetchBody(docs, documentId, tabId, tabId ? 'tabs' : 'body(content(endIndex))');
    if (!content || content.length === 0) throw publicError('No content found in document/tab.');
    return content[content.length - 1].endIndex;
}

// --- schema -----------------------------------------------------------------

const ExplicitRangeTarget = z.object({
    startIndex: z.number().int().min(1).describe('Start of the range to replace (inclusive, 1-based).'),
    endIndex: z.number().int().min(1).describe('End of the range to replace (exclusive). Equal to startIndex means "insert here without deleting anything".'),
});

const HeadingTarget = z.object({
    afterHeading: z.string().min(1).optional().describe('Full text of the heading whose section is being replaced. Matched on the WHOLE heading (whitespace-normalized, case-insensitive), not a preview.'),
    headingId: z.string().min(1).optional().describe('Exact Docs headingId, as an unambiguous alternative to afterHeading.'),
    untilNextHeadingOfLevel: z.number().int().min(1).max(6).optional().describe('The section ends at the next heading of this level or shallower. Defaults to the matched heading\'s own level, so deeper sub-headings are part of the section.'),
}).refine((target) => Boolean(target.afterHeading || target.headingId), {
    message: 'Provide afterHeading or headingId.',
});

const TextTarget = z.object({
    textToFind: z.string().min(1).describe('Exact text marking the content to replace. Must cover whole paragraphs — use startIndex/endIndex for a mid-paragraph range.'),
    matchInstance: z.number().int().min(1).optional().describe('Which occurrence to target when the text appears more than once.'),
});

const ReplaceRangeParameters = DocumentIdParameter.extend({
    target: z.union([ExplicitRangeTarget, HeadingTarget, TextTarget])
        .describe("The range to replace: explicit {startIndex,endIndex} (from readDocument format='index'), {afterHeading|headingId} for a whole section, or {textToFind} for content located by text."),
    markdown: z.string().optional().describe('Inline markdown to put in the range. Prefer filePath for content longer than ~2000 characters.'),
    filePath: z.string().optional().describe('Path to a local markdown file to use as the replacement content. Takes precedence over markdown.'),
    preserveHeading: z.boolean().optional().default(true).describe('Heading targets only. True (default) replaces the content BELOW the heading and keeps the heading itself; false moves the range start to the heading paragraph so the heading is replaced too.'),
    onFidelityLoss: z.enum(['block', 'warn']).optional().default('block').describe("What to do when the range contains content markdown cannot represent (images, footnotes, a generated table of contents). 'block' (default) refuses and names what would be lost; 'warn' proceeds and reports it. Content OUTSIDE the range is never inspected and never at risk."),
    dryRun: z.boolean().optional().default(false).describe('Resolve and validate the range, report what would change, and make no writes.'),
    tabId: z.string().optional().describe('The ID of the specific tab to edit. If not specified, edits the first tab.'),
    expectedRevisionId: z.string().optional().describe('Optional compare-and-write assertion: the write is refused unless the read handle was issued for this revision. It is an assertion only, never authorization.'),
    readHandle: ReadHandleParameter,
});

export function register(server) {
    server.addTool({
        name: 'replaceRangeWithMarkdown',
        description: 'Best for rewriting ONE section of a document with real structure. Replaces a caller-chosen range with content parsed from markdown, ' +
            'building true headings, nested bullet/numbered lists, tables, links, and the rich markdown HTML extensions — everything replaceDocumentWithMarkdown builds, scoped to a range. ' +
            "Address the range three ways: explicit {startIndex,endIndex} from readDocument with format='index'; {afterHeading} (or {headingId}) to replace everything under a heading, up to the next heading of the same or shallower level; or {textToFind}. " +
            'Set startIndex == endIndex to INSERT markdown at an index without deleting anything. ' +
            'Use this instead of modifyText whenever the replacement is multi-line or contains lists — modifyText is text-only and flattens list nesting. ' +
            'Use replaceDocumentWithMarkdown when you are rewriting the whole body, and appendMarkdown to add to the end. ' +
            'Content outside the range is left untouched, including images, horizontal rules, and other sections; only content inside the range is checked for markdown fidelity, and by default a range holding an image or footnote is refused rather than silently flattened (onFidelityLoss). ' +
            'Pass dryRun to see the resolved range and what would be lost without writing. ' +
            'The write is guarded by the revision the read saw. If the document changed since you read it, an afterHeading/headingId or textToFind target is re-resolved against the current document and proceeds when the change did not touch the section; an explicit startIndex/endIndex is refused unless the change landed strictly after the range, since explicit indices have no anchor to re-resolve. Refusals name what changed and where.',
        parameters: ReplaceRangeParameters,
        execute: async (args, { log }) => {
            const tabId = args.tabId ?? null;
            // Schema defaults are applied by the transport's parse step; repeat
            // them here so a direct internal call cannot silently get
            // `preserveHeading: undefined` (which would swallow the heading) or
            // skip the fidelity block.
            const preserveHeading = args.preserveHeading ?? true;
            const onFidelityLoss = args.onFidelityLoss ?? 'block';
            // Resolve the replacement content BEFORE taking the lease: a missing
            // or empty payload is a pure input error and must not reserve (and
            // therefore burn) the caller's read handle.
            let markdown = args.markdown;
            if (args.filePath) {
                try {
                    markdown = await fs.readFile(args.filePath, 'utf-8');
                    log.info(`Read ${markdown.length} chars from file: ${args.filePath}`);
                } catch (err) {
                    // A local fs error message carries server-side absolute paths,
                    // so it stays an internal cause (matching appendMarkdown).
                    throw wrapOperationError('read local markdown file', err, { code: err?.code });
                }
            }
            if (!markdown || markdown.trim().length === 0) {
                throw publicError('Either markdown or filePath must be provided with non-empty content. ' +
                    'To remove a range without inserting anything, use deleteRange.');
            }

            const docs = await getDocsClient();
            const lease = await beginDocsMutation(args.documentId, {
                tabId,
                readHandle: args.readHandle,
                expectedRevisionId: args.expectedRevisionId ?? null,
                legacyGuard: () => guardMutation(args.documentId, {
                    contentFetcher: async () => {
                        const current = await docs.documents.get({ documentId: args.documentId });
                        return { content: docsJsonToMarkdown(current.data), revisionId: current.data.revisionId };
                    },
                }),
            });

            // Everything from here to the first write is resolution and
            // validation. Those failures release the lease with `abort()` so the
            // read handle stays usable for the corrected retry; only a failure
            // that may have touched the document settles it as a failed write.
            let wroteSomething = false;
            // Set once the new content is in the document and the old content is
            // still there; cleared as soon as the old content is gone. Non-null
            // in the catch means the failure left both copies behind.
            let pendingOldRange = null;
            try {
                const { contentSource, content, revisionId: snapshotRevisionId } = await fetchBody(
                    docs,
                    args.documentId,
                    tabId,
                    tabId ? 'revisionId,tabs' : 'revisionId,body,lists',
                );
                if (!content || content.length === 0) throw publicError('No content found in document/tab.');
                const elements = collectRangeElements(contentSource);
                if (elements.length === 0) throw publicError('No structural content found in document/tab.');
                const bodyEnd = content[content.length - 1].endIndex;
                // The final paragraph mark cannot be deleted, so it is the last
                // addressable index — the same bound replaceDocumentWithMarkdown uses.
                const maxIndex = bodyEnd - 1;

                const resolved = await resolveTargetRange({
                    docs,
                    documentId: args.documentId,
                    tabId,
                    target: args.target,
                    preserveHeading,
                    elements,
                    maxIndex,
                });
                const { mode } = resolved;

                // --- range-precise conflict check (#108) --------------------
                // This runs BEFORE validateRange and everything derived from
                // the range, because a permitted-despite-change write must use
                // re-resolved indices and every downstream check (alignment,
                // fidelity, covered elements) has to be computed from THOSE.
                // The snapshot handed to the guard is the body already fetched
                // above, so classification, re-resolution and the write all
                // describe one document state. `heading` and `textToFind` are
                // semantic anchors and can be resolved again; explicit
                // start/end indices cannot, so a change before them blocks.
                const guarded = await lease.guardTargets({
                    snapshot: { document: contentSource, revisionId: snapshotRevisionId ?? null },
                    targets: [{
                        kind: mode === 'indices' ? 'explicit' : 'semantic',
                        startIndex: resolved.start,
                        endIndex: resolved.end,
                        describe: `${mode} target, resolved to range ${resolved.start}-${resolved.end}`,
                    }],
                    reresolve: async ({ document }) => {
                        try {
                            if (mode === 'textToFind') {
                                const found = GDocsHelpers.findTextRangeInDoc(
                                    document, args.target.textToFind, args.target.matchInstance,
                                    walkTabFilter(document, tabId),
                                );
                                if (!found || found.found === false || found.startIndex === -1) return null;
                                return { startIndex: found.startIndex, endIndex: found.endIndex };
                            }
                            const again = await resolveTargetRange({
                                docs,
                                documentId: args.documentId,
                                tabId,
                                target: args.target,
                                preserveHeading,
                                elements: collectRangeElements(document),
                                maxIndex,
                            });
                            return { startIndex: again.start, endIndex: again.end };
                        } catch {
                            // A heading that no longer resolves (gone, or now
                            // ambiguous) is exactly the "no unique anchor" case
                            // the guard rejects with its own explanation.
                            return null;
                        }
                    },
                });
                const start = guarded.targets[0].startIndex;
                const end = guarded.targets[0].endIndex;
                if (guarded.changed && guarded.classified) {
                    log.info(`replaceRangeWithMarkdown: document changed since the read; ${mode} target re-resolved ` +
                        `to ${start}-${end} against revision ${guarded.revisionId}`);
                }
                const { startAligned } = validateRange({ start, end, mode, elements, maxIndex, tabId });

                const fidelityWarnings = scanRangeFidelity(elements, start, end);
                if (fidelityWarnings.length > 0 && onFidelityLoss === 'block') {
                    throw publicError(`The range ${start}-${end} contains content that markdown cannot represent, so replacing it ` +
                        `would permanently lose:\n${fidelityWarnings.map((w) => `  - ${w}`).join('\n')}\n` +
                        "Narrow the range, or pass onFidelityLoss='warn' to accept the loss. " +
                        'Content outside the range is unaffected either way.');
                }

                const covered = elements.filter((element) => element.end > start && element.start < end);
                const wholeBody = start === 1 && end === maxIndex;
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                const notes = [];
                if (fidelityWarnings.length > 0) {
                    notes.push(`Fidelity warnings (content inside the range that will be lost):\n${fidelityWarnings.map((w) => `  - ${w}`).join('\n')}`);
                }
                if (wholeBody) {
                    notes.push('This range covers the entire body — replaceDocumentWithMarkdown does the same job in fewer API calls.');
                }
                if (!startAligned) {
                    notes.push('The range starts mid-paragraph, so the inserted content joins that paragraph and inherits its style. ' +
                        'Use whole-paragraph indices if you want the new content to carry only its own markdown structure.');
                }

                if (args.dryRun) {
                    await lease.abort();
                    const plan = [
                        `${docUrl}`,
                        `DRY RUN — nothing was written.`,
                        `Resolved range: ${start}-${end} (${mode} target${tabId ? `, tab ${tabId}` : ''})`,
                        start === end
                            ? `Would INSERT ${markdown.length} characters of markdown at index ${start}.`
                            : `Would replace ${end - start} character(s) spanning ${covered.length} element(s) with ${markdown.length} characters of markdown.`,
                        covered.length ? `Covered elements:\n${covered.slice(0, 25).map((element) => `  - ${describeElement(element)}`).join('\n')}` : '',
                        ...notes,
                    ].filter(Boolean);
                    return plan.join('\n');
                }

                log.info(`replaceRangeWithMarkdown on doc ${args.documentId}: range ${start}-${end} (${mode})` +
                    `${tabId ? ` in tab ${tabId}` : ''}, ${markdown.length} chars of markdown`);

                // The guard's authorized revision: the validated read handle's on
                // the v2 runtime, the tracked read's on the legacy one. Chained
                // across every batch below so a collaborator edit landing between
                // two of our own writes is a conflict, not a silent overwrite.
                const writeControlChain = GDocsHelpers.createWriteControlChain(lease.revisionId);

                // 1. Prepare a clean insertion seam we own.
                //    - Pure insertion at an element boundary: create an empty
                //      paragraph to insert into, so the new content does not
                //      inherit the following paragraph's bullets/heading style.
                //    - Range replace starting at an element boundary: neutralize
                //      the range's own first paragraph (deleted in step 3).
                //    - Mid-paragraph explicit range: no cleanup at all, since the
                //      enclosing paragraph is partly outside the range.
                const seam = start === end && startAligned;
                let deleteStart = start;
                let deleteEnd = end;
                let bodyEndBeforeInsert = bodyEnd;
                const preRequests = [];
                if (seam) {
                    preRequests.push({ insertText: { location: { index: start, ...(tabId ? { tabId } : {}) }, text: '\n' } });
                    deleteEnd = start + 1;
                    bodyEndBeforeInsert += 1;
                }
                const firstElement = elements.find((element) => element.start === start);
                const cleanupEnd = seam
                    ? start + 1
                    : (startAligned && firstElement?.type !== 'table' ? Math.min(end, firstElement.end) : null);
                if (cleanupEnd !== null && cleanupEnd > start) {
                    preRequests.push(...buildBoundaryCleanupRequests(start, cleanupEnd, tabId));
                }
                if (preRequests.length > 0) {
                    wroteSomething = true;
                    const preResult = await GDocsHelpers.executeBatchUpdate(
                        docs, args.documentId, preRequests, writeControlChain.current,
                    );
                    writeControlChain.advance(preResult);
                    log.info(`Prepared insertion seam at ${start}${seam ? ' (new empty paragraph)' : ''}.`);
                }

                // 2. Insert the markdown at the range start.
                wroteSomething = true;
                const result = await insertMarkdown(docs, args.documentId, markdown, {
                    startIndex: start,
                    tabId: tabId ?? undefined,
                    writeControl: writeControlChain.current,
                });
                writeControlChain.advance({ writeControl: result.batchUpdate?.finalWriteControl });
                const debugSummary = formatInsertResult(result);
                log.info(debugSummary);

                // 3. Delete the old content from its shifted position. The net
                //    body growth is measured, not summed from the insert
                //    requests: createParagraphBullets consumes the leading tabs
                //    that encode list nesting, so the document grows by less
                //    than the inserted text.
                const bodyEndAfterInsert = await fetchBodyEnd(docs, args.documentId, tabId);
                const insertedLength = bodyEndAfterInsert - bodyEndBeforeInsert;
                if (insertedLength < 0) {
                    throw publicError('The document shrank unexpectedly during the insert; aborting before deleting the old content. ' +
                        'Re-read the document and inspect it before retrying.');
                }
                if (deleteEnd > deleteStart) {
                    pendingOldRange = { start: deleteStart + insertedLength, end: deleteEnd + insertedLength };
                    const deleteResult = await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [
                        { deleteContentRange: { range: rangeFor(pendingOldRange.start, pendingOldRange.end, tabId) } },
                    ], writeControlChain.current);
                    writeControlChain.advance(deleteResult);
                    log.info(`Deleted replaced content at ${pendingOldRange.start}-${pendingOldRange.end}.`);
                    pendingOldRange = null;
                }

                // 4. A range that ran to the end of the body leaves the document's
                //    final paragraph mark behind (it cannot be deleted), carrying
                //    the old last paragraph's bullets and style. That mark is
                //    inside the replaced range, so cleaning it touches nothing the
                //    caller kept. Best-effort, exactly like the whole-body tool.
                if (end === maxIndex && deleteEnd > deleteStart) {
                    const survivorStart = start + insertedLength;
                    const survivorWriteControl = writeControlChain.current;
                    try {
                        const survivorResult = await GDocsHelpers.executeBatchUpdate(
                            docs,
                            args.documentId,
                            buildBoundaryCleanupRequests(survivorStart, survivorStart + 1, tabId),
                            survivorWriteControl,
                        );
                        writeControlChain.advance(survivorResult);
                    } catch (e) {
                        if (survivorWriteControl && isPublicError(e) && /changed since you last read/i.test(e.message)) {
                            throw e;
                        }
                        log.info(`Trailing-paragraph cleanup skipped: ${e.message}`);
                    }
                }

                await lease.complete(writeControlChain.current?.requiredRevisionId);

                const warningNote = result.warnings?.length
                    ? ` with ${result.warnings.length} conversion warning${result.warnings.length === 1 ? '' : 's'} (content dropped — see below)`
                    : '';
                const action = start === end
                    ? `Inserted ${markdown.length} characters of markdown at index ${start}`
                    : `Replaced range ${start}-${end} with ${markdown.length} characters of markdown`;
                return [
                    docUrl,
                    `${action}${tabId ? ` in tab ${tabId}` : ''}${warningNote}.`,
                    ...notes,
                    '',
                    debugSummary,
                ].join('\n');
            } catch (error) {
                if (wroteSomething) {
                    // Settle as a failed write so a dirty per-handle workspace is
                    // retained for recovery rather than silently reclaimed.
                    await lease.fail();
                } else {
                    // Nothing was written, so the handle is still good for a retry
                    // with a corrected range.
                    await lease.abort();
                }
                log.error(`Error in replaceRangeWithMarkdown for doc ${args.documentId}: ${error.message || error}`);
                if (pendingOldRange) {
                    // The insert landed and the delete did not: the document now
                    // holds BOTH copies. No content was lost, but the caller needs
                    // the exact leftover range to finish the job.
                    throw publicError('The new markdown was inserted, but removing the old content failed: ' +
                        `${isPublicError(error) ? error.message : 'the delete request did not complete'}. ` +
                        'Nothing was lost — the document now contains BOTH copies. The old content is at ' +
                        `${pendingOldRange.start}-${pendingOldRange.end}; re-read the document and delete that range ` +
                        '(deleteRange) to finish. ' +
                        `https://docs.google.com/document/d/${args.documentId}/edit`);
                }
                if (isPublicError(error) || error instanceof MarkdownConversionError) throw error;
                throw wrapOperationError('replace document range with markdown', error, { status: error?.code });
            }
        },
    });
}
