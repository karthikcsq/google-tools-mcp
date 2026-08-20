// Atomic multi-location text editing (issue #88, canonical for #89).
//
// --- The gap ----------------------------------------------------------------
//
// Ten scattered edits used to mean one of two bad options. `modifyText` is
// single-operation, so ten edits are ten round trips: each one shifts the
// indices the next was computed against, and each one is its own conflict
// window, so a collaborator can land between edits 4 and 5 and leave the
// document half-edited with no way to tell. The alternative,
// `replaceDocumentWithMarkdown`, rebuilds the whole body, which the Docs API
// treats as new content — every comment anchor orphans and every headingId is
// regenerated, for ten one-line changes.
//
// This is the middle layer: N validated operations against the existing body,
// in ONE guarded batchUpdate.
//
// --- Atomicity and ordering contract ----------------------------------------
//
// 1. ONE SNAPSHOT. Every target — explicit ranges, insertion points and
//    `textToFind` searches alike — is resolved against a single
//    `documents.get`, so no operation is resolved against a document that an
//    earlier operation in the same call already changed. (`findTextRange`
//    fetches per call; `findTextRangeInDoc` is the snapshot form added for
//    this.)
// 2. NO OVERLAPS. Two operations whose resolved ranges intersect are rejected
//    up front, naming both operations, because their combined result depends on
//    application order and no ordering is more correct than another. An
//    insertion point strictly inside another operation's range, and two
//    insertions at the same index, are rejected for the same reason.
// 3. DESCENDING APPLICATION. Requests are emitted highest-index-first, so an
//    edit never shifts the indices of an edit that has not been applied yet.
//    This is what makes the caller's indices, all read from one document state,
//    simultaneously valid.
// 4. ALL OR NOTHING. Every request goes in a single `documents.batchUpdate`,
//    which the Docs API applies atomically — one invalid request means none of
//    them apply. The batch is therefore never split: when the request count
//    exceeds the cap the call is REFUSED rather than silently split into two
//    non-atomic batches, since atomicity is the contract this tool sells.
// 5. ONE GUARD. One lease authorizes the whole batch and one
//    `WriteControl.requiredRevisionId` (from the validated read handle, never
//    from caller input) covers it, so a concurrent edit is a conflict rather
//    than a write against shifted indices.
//
// --- dryRun -----------------------------------------------------------------
//
// The preview is two parts, because either alone lies. The unified diff shows
// text changes; a formatting-only operation produces NO text change, so a bare
// empty diff would read as "this call does nothing". The structured summary
// carries the resolved range, the exact text being removed, and the style
// fields being set, for every operation including the formatting-only ones.
//
// The diff is computed from the snapshot rather than from a second fetch: the
// snapshot already carries every text run with its document index, and the
// proposed side is exactly computable by applying the same resolved operations
// to that text. A real write returns the same diff, labelled as applied.
import { z } from 'zod';
import { createPatch } from 'diff';
import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { getDocsClient } from '../../clients.js';
import { DocumentIdParameter, TextFindParameter, TextStyleParameters, ParagraphStyleParameters } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import { docsJsonToMarkdown } from '../../markdown-transformer/index.js';
import { guardMutation } from '../../readTracker.js';
import { ReadHandleParameter, beginDocsMutation } from '../../docsHandles.js';
import { buildModifyTextRequests } from './modifyText.js';

/**
 * Ceiling on operations.
 *
 * The plan wrote 1-50 here. 50 makes the request cap below unreachable dead
 * code: one operation emits at most five requests (delete, insert,
 * default-colour paint, text style, paragraph style), so 50 operations can
 * never exceed 400 requests. The binding constraint is the API's per-batch
 * request ceiling, not the operation count, so the operation cap is set where
 * the two actually meet and both limits are real.
 */
export const MAX_OPERATIONS = 200;

/**
 * Ceiling on emitted API requests. The Docs API rejects oversized batches; 400
 * sits safely under that. Exceeding it is a refusal, never a silent split (see
 * the atomicity contract above).
 */
export const MAX_REQUESTS = 400;

/** Chars of removed/inserted text echoed back per operation. */
const TEXT_PREVIEW_CHARS = 60;

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

const Operation = z
    .object({
        target: z
            .union([RangeTarget, TextFindParameter, InsertionTarget])
            .describe('Target by range indices, text search, or insertion index. Every target in the batch is resolved against ONE document snapshot.'),
        text: z.string().optional().describe('New text to insert or replace with. Pass "" to delete the target range. Supports \\n and \\t escapes, exactly like modifyText.'),
        style: TextStyleParameters.optional().describe('Text formatting to apply (bold, italic, font size, etc.).'),
        paragraphStyle: ParagraphStyleParameters.optional().describe('Paragraph formatting to apply (alignment, indentation, headings, spacing, etc.).'),
        label: z.string().optional().describe('Optional caller-supplied name for this operation, echoed in previews and error messages.'),
    })
    .refine((op) => op.text !== undefined || op.style !== undefined || op.paragraphStyle !== undefined, {
        message: 'Each operation needs at least one of text, style, or paragraphStyle.',
    })
    .refine((op) => !('insertionIndex' in op.target && op.text === undefined), {
        message: 'text is required when an operation uses an insertionIndex target (there is no existing range to format).',
    });

const BatchModifyTextParameters = DocumentIdParameter.extend({
    operations: z
        .array(Operation)
        .min(1)
        .max(MAX_OPERATIONS)
        .describe(`The edits to apply, 1-${MAX_OPERATIONS}. Order does not matter: targets are resolved against one snapshot and applied highest-index-first, so the indices you read stay valid for every operation.`),
    tabId: z
        .string()
        .optional()
        .describe('The ID of the specific tab to operate on. Applies to every operation in the batch. If not specified, operates on the first tab.'),
    dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe('Resolve and validate every operation, return the unified diff and the per-operation summary, and make no writes at all.'),
    expectedRevisionId: z
        .string()
        .optional()
        .describe('Optional compare-and-write assertion: the write is refused unless the read handle was issued for this revision. It is an assertion only, never authorization.'),
    readHandle: ReadHandleParameter,
});

// --- text image -------------------------------------------------------------

/**
 * The document's text as an array of `{ index, ch }`, where `index` is the
 * character's real Docs index (null for characters this call would insert).
 *
 * The Docs index space is not contiguous — structural elements occupy indices
 * that carry no text run — so this is a projection, not a substring of the
 * document. It is exactly the same projection `findTextRange` searches in,
 * which is what makes the resolved ranges and this image agree.
 */
export function buildTextImage(segments) {
    const chars = [];
    for (const segment of segments ?? []) {
        const text = segment.text ?? '';
        for (let offset = 0; offset < text.length; offset += 1) {
            chars.push({ index: segment.start + offset, ch: text[offset] });
        }
    }
    return chars;
}

/** Array position of the first real character at or after `docIndex`. */
function positionAtOrAfter(chars, docIndex) {
    for (let position = 0; position < chars.length; position += 1) {
        const entry = chars[position];
        if (entry.index !== null && entry.index >= docIndex) return position;
    }
    return chars.length;
}

const renderImage = (chars) => chars.map((entry) => entry.ch).join('');

/** The document text an operation's range currently covers. */
export function textInRange(chars, startIndex, endIndex) {
    if (endIndex === undefined) return '';
    let text = '';
    for (const entry of chars) {
        if (entry.index !== null && entry.index >= startIndex && entry.index < endIndex) text += entry.ch;
    }
    return text;
}

/**
 * Apply the resolved operations to the text image. `operations` must already be
 * in descending document order — the same order the requests go out in, so the
 * preview and the write can never describe different results.
 */
export function applyTextOperations(chars, operations) {
    let next = chars;
    for (const op of operations) {
        if (op.text === undefined) continue; // formatting only: no text change
        const inserted = [...op.text].map((ch) => ({ index: null, ch }));
        const from = positionAtOrAfter(next, op.startIndex);
        const to = op.endIndex === undefined ? from : positionAtOrAfter(next, op.endIndex);
        next = next.slice(0, from).concat(inserted, next.slice(to));
    }
    return next;
}

// --- overlap detection ------------------------------------------------------

const describeTarget = (op) => {
    if ('textToFind' in op.source.target) {
        return `textToFind "${op.source.target.textToFind}"${op.source.target.matchInstance ? ` (instance ${op.source.target.matchInstance})` : ''}`;
    }
    if ('insertionIndex' in op.source.target) return `insertionIndex ${op.source.target.insertionIndex}`;
    return `range ${op.source.target.startIndex}-${op.source.target.endIndex}`;
};

const opName = (op) => `operation ${op.position}${op.source.label ? ` ("${op.source.label}")` : ''}`;

/**
 * Reject any pair of operations whose resolved targets interact.
 *
 * Half-open ranges [start, end) do not overlap when they merely touch, so
 * back-to-back edits are legal. Insertion points are zero-width: they conflict
 * only when strictly inside another range (where the insert would land in text
 * that operation is deleting) or when two insertions share an index (where the
 * resulting order of the two texts would be arbitrary).
 */
export function findOverlap(operations) {
    // Pairwise and exhaustive rather than a sweep: the operation cap is 50, so
    // this is at most ~1200 comparisons, and a sweep's early exit is the kind of
    // cleverness that quietly stops catching the zero-width cases.
    const sorted = [...operations].sort((a, b) => (a.startIndex - b.startIndex) || (a.position - b.position));
    for (let i = 0; i < sorted.length; i += 1) {
        for (let j = i + 1; j < sorted.length; j += 1) {
            const a = sorted[i];
            const b = sorted[j];
            const aEnd = a.endIndex ?? a.startIndex;
            const bEnd = b.endIndex ?? b.startIndex;
            const aIsPoint = a.endIndex === undefined;
            const bIsPoint = b.endIndex === undefined;
            if (aIsPoint && bIsPoint) {
                if (a.startIndex === b.startIndex) return { a, b, reason: 'both insert at the same index, so the order of the two inserted texts would be arbitrary' };
                continue;
            }
            if (aIsPoint || bIsPoint) {
                const point = aIsPoint ? a : b;
                const range = aIsPoint ? b : a;
                if (point.startIndex > range.startIndex && point.startIndex < range.endIndex) {
                    return { a, b, reason: 'one inserts text inside the range the other replaces or deletes' };
                }
                continue;
            }
            if (a.startIndex < bEnd && b.startIndex < aEnd) {
                return { a, b, reason: 'their ranges overlap' };
            }
        }
    }
    return null;
}

// --- summaries --------------------------------------------------------------

const preview = (text, max = TEXT_PREVIEW_CHARS) => {
    const shown = String(text ?? '').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
    return shown.length <= max ? shown : `${shown.slice(0, max)}…`;
};

function kindOf(op) {
    if (op.endIndex === undefined) return op.text ? 'insert' : 'style';
    if (op.text === '') return 'delete';
    if (op.text !== undefined) return 'replace';
    if (op.style && op.paragraphStyle) return 'style+paragraphStyle';
    return op.paragraphStyle ? 'paragraphStyle' : 'style';
}

/**
 * Per-operation structured summary. This is the half of the preview that
 * survives when the diff is empty, which is exactly the formatting-only case.
 */
export function summarizeOperations(operations) {
    return operations.map((op) => {
        const lines = [
            `${opName(op)} — ${kindOf(op)} at ${op.endIndex === undefined ? `index ${op.startIndex}` : `${op.startIndex}-${op.endIndex}`}` +
            ` (resolved from ${describeTarget(op)})`,
        ];
        if (op.removedText) {
            lines.push(`    removes ${op.removedText.length} char(s): "${preview(op.removedText)}"`);
        }
        if (op.text) {
            lines.push(`    inserts ${op.text.length} char(s): "${preview(op.text)}"`);
        }
        if (op.text === '' && op.endIndex !== undefined) {
            lines.push('    inserts nothing (delete only)');
        }
        if (op.style) {
            lines.push(`    text style: ${Object.entries(op.style).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`);
        }
        if (op.paragraphStyle) {
            lines.push(`    paragraph style: ${Object.entries(op.paragraphStyle).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`);
        }
        return lines.join('\n');
    });
}

/** Aggregate deletion summary — the number the caller actually wants before saying yes. */
export function deletionSummary(operations) {
    const deleting = operations.filter((op) => op.removedText && op.removedText.length > 0);
    const totalRemoved = deleting.reduce((sum, op) => sum + op.removedText.length, 0);
    const totalInserted = operations.reduce((sum, op) => sum + (op.text?.length ?? 0), 0);
    return { deleting, totalRemoved, totalInserted };
}

// --- registration -----------------------------------------------------------

export function register(server) {
    server.addTool({
        name: 'batchModifyText',
        description: 'Best for MANY small, scattered text edits in one document — the multi-location form of modifyText. ' +
            `Applies up to ${MAX_OPERATIONS} operations (replace a range or found text, insert at an index, delete, apply text or paragraph styling) in ONE atomic batchUpdate. ` +
            'Every target is resolved against one document snapshot and applied highest-index-first, so the indices you read stay valid for all of them and you do not have to recompute offsets between edits. ' +
            'All-or-nothing: if one operation is invalid, none are applied, and the whole batch is guarded by a single revision check, so a concurrent edit is reported as a conflict rather than written against shifted indices. ' +
            'If the document changed after you read it, every operation is classified against that change: textToFind operations are re-resolved against the current document and proceed when the change did not touch them, while explicit index operations are refused unless the change landed strictly after their range. Any operation that is refused refuses the whole batch, naming what changed and where. ' +
            'Operations whose resolved ranges overlap are rejected up front, naming both. ' +
            'Pass dryRun to get the proposed-vs-current unified diff, an explicit deletion summary, and a per-operation breakdown without writing; a real call returns the same diff for what it applied. ' +
            'This tool is TEXT-ONLY, like modifyText: a multi-line replacement is inserted as one blob with a single paragraph style, so markdown syntax stays literal and list nesting is flattened. ' +
            'For structured content (lists, headings, tables) at a range use replaceRangeWithMarkdown; to rewrite a whole document use replaceDocumentWithMarkdown — but prefer this tool over that one for local edits, because a full-body rewrite orphans comment anchors and regenerates every headingId. ' +
            "Use readDocument with format='index' for indices, or listHeadings for the outline. " +
            "Newly inserted text carries the document's default text color explicitly, when the document defines one.",
        parameters: BatchModifyTextParameters,
        execute: async (args, { log }) => {
            const tabId = args.tabId ?? null;
            const dryRun = args.dryRun ?? false;
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

            // Everything up to the batchUpdate is resolution and validation.
            // Those failures release the lease with abort(), leaving the read
            // handle usable for the corrected retry; only a failure that may
            // have touched the document settles it as a failed write.
            let wroteSomething = false;
            try {
                // --- one snapshot, for every target and for the diff --------
                const snapshot = await docs.documents.get({
                    documentId: args.documentId,
                    includeTabsContent: !!tabId,
                    fields: `revisionId,${GDocsHelpers.textSearchFields(tabId)}`,
                });
                const extracted = GDocsHelpers.extractTextAndSegments(snapshot.data, tabId);
                if (!extracted) throw publicError('No content found in document/tab.');

                // --- resolve every target against that snapshot -------------
                const resolved = [];
                for (let position = 0; position < args.operations.length; position += 1) {
                    const source = args.operations[position];
                    let startIndex;
                    let endIndex;
                    if ('insertionIndex' in source.target) {
                        startIndex = source.target.insertionIndex;
                        endIndex = undefined;
                    } else if ('textToFind' in source.target) {
                        const found = GDocsHelpers.findTextRangeInDoc(
                            snapshot.data, source.target.textToFind, source.target.matchInstance, tabId,
                        );
                        if (!found || found.found === false || found.startIndex === -1) {
                            throw publicError(`Operation ${position + 1}${source.label ? ` ("${source.label}")` : ''}: ` +
                                (found?.message ?? `could not find text "${source.target.textToFind}"${tabId ? ` in tab ${tabId}` : ''}.`));
                        }
                        startIndex = found.startIndex;
                        endIndex = found.endIndex;
                    } else {
                        startIndex = source.target.startIndex;
                        endIndex = source.target.endIndex;
                    }
                    if (startIndex < 1) startIndex = 1;
                    // Same escape normalization modifyText applies before
                    // building requests (issue #9). Reusing the builder without
                    // it would silently produce different requests than the tool
                    // this one claims parity with.
                    const text = source.text?.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
                    resolved.push({
                        position: position + 1,
                        source,
                        startIndex,
                        endIndex,
                        text,
                        style: source.style,
                        paragraphStyle: source.paragraphStyle,
                    });
                }

                // --- range-precise conflict check (#108) --------------------
                // The snapshot above is BOTH the resolution source and the
                // guard's classification source, which is the whole reason this
                // tool is the natural home for the interface: every target is
                // already resolved against the exact document state the guard
                // classifies, so `reresolve` hands the same ranges straight
                // back rather than recomputing them against a second fetch.
                // A permitted changed-document batch re-arms the lease onto
                // this snapshot's revision, so the single WriteControl below
                // carries it instead of the stale handle revision.
                const guarded = await lease.guardTargets({
                    snapshot: { document: snapshot.data, revisionId: snapshot.data?.revisionId ?? null },
                    targets: resolved.map((op) => ({
                        kind: 'textToFind' in op.source.target ? 'semantic' : 'explicit',
                        startIndex: op.startIndex,
                        endIndex: op.endIndex,
                        describe: `${opName(op)} — ${describeTarget(op)}, resolved to ` +
                            `${op.endIndex === undefined ? `index ${op.startIndex}` : `${op.startIndex}-${op.endIndex}`}`,
                    })),
                    reresolve: () => resolved.map((op) => ({ startIndex: op.startIndex, endIndex: op.endIndex })),
                });
                if (guarded.changed && guarded.classified) {
                    log.info(`batchModifyText: document changed since the read; ${resolved.length} target(s) ` +
                        `re-resolved against revision ${guarded.revisionId}`);
                }

                // --- overlap rejection, before anything is built ------------
                const overlap = findOverlap(resolved);
                if (overlap) {
                    const range = (op) => (op.endIndex === undefined ? `index ${op.startIndex}` : `${op.startIndex}-${op.endIndex}`);
                    throw publicError(`${opName(overlap.a)} (${describeTarget(overlap.a)}, resolved to ${range(overlap.a)}) and ` +
                        `${opName(overlap.b)} (${describeTarget(overlap.b)}, resolved to ${range(overlap.b)}) conflict: ${overlap.reason}. ` +
                        'Combine them into a single operation covering the whole span, or split them across two calls with a re-read in between.');
                }

                // --- descending application order ---------------------------
                // Highest index first, so no applied edit shifts the indices of
                // an edit still to be applied. Ties (impossible after the
                // overlap check, but cheap to make deterministic) keep the
                // caller's order.
                const ordered = [...resolved].sort((a, b) => (b.startIndex - a.startIndex) || (a.position - b.position));

                // Record what each operation removes, for the deletion summary.
                const image = buildTextImage(extracted.segments);
                for (const op of ordered) {
                    op.removedText = op.text === undefined ? '' : textInRange(image, op.startIndex, op.endIndex);
                }

                // --- build requests -----------------------------------------
                let defaultColor;
                if (ordered.some((op) => op.text !== undefined && op.text !== '')) {
                    const { color, error: colorError } = await GDocsHelpers.getDefaultTextColor(docs, args.documentId);
                    defaultColor = color;
                    if (colorError) {
                        log.warn(`batchModifyText: could not fetch document default text color for ${args.documentId}: ${colorError.message}`);
                    }
                }
                const requests = [];
                for (const op of ordered) {
                    requests.push(...buildModifyTextRequests({
                        startIndex: op.startIndex,
                        endIndex: op.endIndex,
                        text: op.text,
                        style: op.style,
                        paragraphStyle: op.paragraphStyle,
                        tabId: tabId ?? undefined,
                        defaultColor,
                    }));
                }
                if (requests.length === 0) {
                    throw publicError('These operations produce no changes. Check that each one supplies text, style, or paragraphStyle for a non-empty range.');
                }
                if (requests.length > MAX_REQUESTS) {
                    // Refuse rather than split: splitting would break the
                    // all-or-nothing contract this tool exists to provide.
                    throw publicError(`These ${args.operations.length} operations produce ${requests.length} Google Docs API requests, ` +
                        `above this tool's limit of ${MAX_REQUESTS}. The batch is never split, because splitting would give up the ` +
                        'all-or-nothing guarantee. Split the work across several calls yourself, re-reading the document between them. ' +
                        '(Each operation emits up to four requests: delete, insert, default-colour paint, and style.)');
                }

                // --- diff ---------------------------------------------------
                const currentText = renderImage(image);
                const proposedText = renderImage(applyTextOperations(image, ordered));
                const textChanged = currentText !== proposedText;
                const patch = textChanged
                    ? createPatch(
                        `${args.documentId}${tabId ? ` (tab ${tabId})` : ''}`,
                        currentText,
                        proposedText,
                        'current',
                        'proposed',
                        { context: 3 },
                    )
                    : null;
                const { deleting, totalRemoved, totalInserted } = deletionSummary(ordered);
                const summary = summarizeOperations(ordered);
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;

                const deletionLine = totalRemoved === 0
                    ? 'Deletion summary: nothing is removed.'
                    : `Deletion summary: ${totalRemoved} character(s) removed across ${deleting.length} operation(s); ` +
                      `${totalInserted} character(s) inserted.`;
                const diffBlock = patch
                    ? `--- DIFF (current → proposed) ---\n${patch}--- END DIFF ---`
                    : 'No text changes: every operation in this batch is formatting-only, so the text diff is empty by ' +
                      'design. The per-operation summary above is the real preview.';

                if (dryRun) {
                    await lease.abort();
                    return [
                        docUrl,
                        'DRY RUN — nothing was written.',
                        `${ordered.length} operation(s) resolved against revision ${snapshot.data?.revisionId ?? '(unknown)'}` +
                        `${tabId ? ` in tab ${tabId}` : ''}, producing ${requests.length} API request(s) in one atomic batch.`,
                        '',
                        'Operations (application order, highest index first):',
                        ...summary,
                        '',
                        deletionLine,
                        '',
                        diffBlock,
                    ].join('\n');
                }

                log.info(`batchModifyText on doc ${args.documentId}: ${ordered.length} operation(s), ` +
                    `${requests.length} request(s)${tabId ? ` in tab ${tabId}` : ''}`);

                // --- the single guarded write -------------------------------
                // Deliberately not lease.write(): that helper folds the write
                // and lease.complete() into one try, so a successor-workspace
                // failure inside complete() would surface as a failed write even
                // though Google already applied the batch. Splitting them keeps
                // "the document changed" and "your next handle is missing"
                // distinguishable, which is the difference between retrying
                // (safe) and re-applying (a double edit).
                const writeControl = lease.writeControlFor();
                let response;
                try {
                    wroteSomething = true;
                    response = await GDocsHelpers.executeBatchUpdate(docs, args.documentId, requests, writeControl);
                } catch (error) {
                    await lease.fail();
                    throw error;
                }
                let successorWarning = null;
                try {
                    await lease.complete(response?.writeControl?.requiredRevisionId);
                } catch (error) {
                    successorWarning = 'The edits were applied, but a follow-on read handle could not be issued for the new ' +
                        'revision. Do NOT retry this call — it would apply the edits a second time. Call readDocument again ' +
                        'to get a fresh handle before your next edit.';
                    log.error(`batchModifyText: lease.complete failed after a successful write on ${args.documentId}: ` +
                        `${error?.message ?? error}`);
                }

                return [
                    docUrl,
                    `Applied ${ordered.length} operation(s) in one atomic batchUpdate (${requests.length} request(s))` +
                    `${tabId ? ` in tab ${tabId}` : ''}.`,
                    ...(successorWarning ? ['', `WARNING: ${successorWarning}`] : []),
                    '',
                    'Operations (application order, highest index first):',
                    ...summary,
                    '',
                    deletionLine,
                    '',
                    patch
                        ? `--- APPLIED DIFF (before → after) ---\n${patch}--- END DIFF ---`
                        : 'No text changes: this batch was formatting-only, so there is no text diff. ' +
                          'The per-operation summary above lists the style fields that were set.',
                ].join('\n');
            }
            catch (error) {
                if (!wroteSomething) {
                    // Nothing reached Google, so the handle is still good for a
                    // corrected retry.
                    await lease.abort();
                }
                log.error(`Error in batchModifyText for doc ${args.documentId}: ${error.message || error}`);
                if (isPublicError(error)) throw error;
                throw wrapOperationError('apply batched document text edits', error, { status: error?.code });
            }
        },
    });
}
