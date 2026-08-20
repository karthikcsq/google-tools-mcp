// Pre-write collateral detection for destructive Docs edits (issues #93, #95).
//
// `replaceDocumentWithMarkdown` deletes the body and re-inserts it. The Docs
// API treats the result as new content, so two things die silently today:
//
//   * every unresolved comment anchored inside the deleted range orphans (the
//     comment survives in Drive, its anchor does not), and
//   * every `headingId` is regenerated, so every in-document link that pointed
//     at a heading now points at nothing.
//
// Neither is visible in a text diff, which is exactly why they go unnoticed.
// This module enumerates both BEFORE the delete so the caller can see the blast
// radius (`warn`) or refuse it (`block`).
//
// Honest limitation, restated in the caller-facing wording: the Drive comments
// surface exposes each comment's quoted text, not its live document range. So
// attribution is exact for a whole-body replace (everything is removed, so
// every unresolved anchor is affected) and APPROXIMATE for a partial one
// (`preserveTitle`), where a quote that also occurs in the preserved region can
// only be reported as "may be affected".

import { logger } from './logger.js';
import * as GDocsHelpers from './googleDocsApiHelpers.js';
import {
    HEADING_BODY_FIELDS,
    HEADING_TABS_FIELDS,
    HEADING_LINK_BODY_FIELDS,
    HEADING_LINK_TABS_FIELDS,
    collectHeadings,
    collectHeadingLinks,
} from './docsIndex.js';
import { publicError } from './errors.js';

/** Chars of a comment's quoted text echoed back in a warning. */
const QUOTE_PREVIEW_CHARS = 40;

/** Hard stop on comment pagination, so a pathological document cannot hang a write. */
const MAX_COMMENT_PAGES = 20;
const COMMENT_PAGE_SIZE = 100;

const normalizeQuote = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function preview(text, max = QUOTE_PREVIEW_CHARS) {
    const collapsed = normalizeQuote(text);
    if (collapsed.length <= max) return collapsed;
    return `${collapsed.slice(0, max)}…`;
}

/**
 * Pick the tab-scoped body out of a fetched document, or throw the same public
 * errors every other tab-aware path throws.
 */
function scopeToTab(data, tabId) {
    if (!tabId) return data;
    const tab = GDocsHelpers.findTabById(data, tabId);
    if (!tab) throw publicError(`Tab with ID "${tabId}" not found in document.`);
    if (!tab.documentTab) throw publicError(`Tab "${tabId}" does not have content (may not be a document tab).`);
    return { body: tab.documentTab.body };
}

/**
 * Narrow-mask heading read. This is the post-write heading map's source:
 * `insertMarkdown` returns request/timing metadata only, so the new heading ids
 * genuinely have to be read back — but at a fraction of a full JSON read.
 *
 * @returns {Promise<{headings: Array, revisionId: string|null}>}
 */
export async function fetchHeadingMap(docs, documentId, tabId = null) {
    const response = await docs.documents.get({
        documentId,
        includeTabsContent: !!tabId,
        fields: tabId ? HEADING_TABS_FIELDS : HEADING_BODY_FIELDS,
    });
    const scoped = scopeToTab(response.data, tabId);
    return {
        headings: collectHeadings(scoped, { tabId }),
        revisionId: response.data?.revisionId ?? null,
    };
}

/**
 * Narrow-mask read carrying both the in-document heading links and enough text
 * to say which comment quotes are about to be deleted. One fetch, two answers:
 * the link scan and the comment-anchor scan need the same body.
 *
 * @returns {Promise<{links: Array, fullText: string, segments: Array, revisionId: string|null}>}
 */
export async function fetchLinkAndTextSnapshot(docs, documentId, tabId = null) {
    const response = await docs.documents.get({
        documentId,
        includeTabsContent: !!tabId,
        fields: tabId ? HEADING_LINK_TABS_FIELDS : HEADING_LINK_BODY_FIELDS,
    });
    const scoped = scopeToTab(response.data, tabId);
    const text = GDocsHelpers.extractTextAndSegments(scoped, null) ?? { fullText: '', segments: [] };
    return {
        links: collectHeadingLinks(scoped, { tabId }),
        fullText: text.fullText,
        segments: text.segments,
        revisionId: response.data?.revisionId ?? null,
    };
}

/**
 * Every comment on the file, following `nextPageToken` to the end.
 *
 * `listComments` deliberately exposes one page at a time (it is an interactive
 * listing tool). A safety check cannot: a promise to enumerate every affected
 * comment is false on a document with more than one page of them, so this
 * paginates and says so explicitly when it hits its own ceiling.
 *
 * @returns {Promise<{comments: Array, truncated: boolean, pages: number}>}
 */
export async function listAllComments(drive, fileId) {
    const comments = [];
    let pageToken;
    let pages = 0;
    let truncated = false;
    do {
        const response = await drive.comments.list({
            fileId,
            fields: 'nextPageToken,comments(id,resolved,content,author(displayName),quotedFileContent(value))',
            pageSize: COMMENT_PAGE_SIZE,
            ...(pageToken ? { pageToken } : {}),
        });
        comments.push(...(response.data?.comments ?? []));
        pageToken = response.data?.nextPageToken || undefined;
        pages += 1;
        if (pageToken && pages >= MAX_COMMENT_PAGES) {
            truncated = true;
            break;
        }
    } while (pageToken);
    return { comments, truncated, pages };
}

/**
 * Map the flat text offsets of the region about to be deleted.
 *
 * `segments` carry document indices, so the deleted range [startIndex,
 * endIndex) is projected onto the concatenated text: everything covered is
 * "removed", everything else "preserved".
 */
// Separator joining non-contiguous preserved runs. Real document text cannot
// contain a NUL byte, so this can never collide with a genuine quote and
// always breaks an includes() match across a gap.
const PRESERVED_SEPARATOR = '\u0000';

export function splitTextByRange(fullText, segments, startIndex, endIndex) {
    let removed = '';
    let preserved = '';
    // A removed span sits BETWEEN two document indices that are themselves
    // still numerically adjacent (deleting text does not renumber the
    // characters around it), so a gap check based only on "does this
    // character's docIndex immediately follow the last one" never fires
    // across a deletion — the indices on either side of a removed span are
    // still consecutive integers. `crossedGap` tracks it explicitly instead:
    // it is set whenever a removed character is skipped, or whenever the
    // next preserved character's docIndex does not immediately follow the
    // last PRESERVED character's docIndex (covering a gap between segments
    // that isn't a removal at all, e.g. two unrelated text runs). Either way
    // forces a separator before the next preserved character.
    //
    // Concatenating every preserved character with no separator made a quote
    // that straddles the deletion boundary (part before startIndex, part
    // after endIndex) — or any two preserved runs separated by a removed
    // span — match `preserved` as if still contiguous, under-reporting it as
    // surviving when it does not. The separator makes such a quote fail
    // includes() and get reported instead of silently dropped.
    let lastPreservedDocIndex = null;
    let crossedGap = false;
    for (const segment of segments ?? []) {
        const text = segment.text ?? '';
        for (let offset = 0; offset < text.length; offset += 1) {
            const docIndex = segment.start + offset;
            if (docIndex >= startIndex && docIndex < endIndex) {
                removed += text[offset];
                crossedGap = true;
                continue;
            }
            const isGap = crossedGap
                || (lastPreservedDocIndex !== null && docIndex !== lastPreservedDocIndex + 1);
            if (preserved !== '' && isGap) {
                preserved += PRESERVED_SEPARATOR;
            }
            preserved += text[offset];
            lastPreservedDocIndex = docIndex;
            crossedGap = false;
        }
    }
    return { removed, preserved };
}

/**
 * Classify unresolved comments against the region being deleted.
 *
 * Three buckets, because the Drive surface cannot support two:
 *   * `affected`   — the quote occurs in the removed region and nowhere else.
 *   * `maybe`      — the quote occurs in BOTH regions, so which occurrence the
 *                    anchor points at is unknowable from here (over-reporting
 *                    is the safe direction).
 *   * `unknown`    — the comment has no quoted text at all (a deleted or
 *                    document-level comment); it cannot be located either way.
 * Resolved comments are excluded entirely.
 *
 * Only `affected` and `maybe` count as collateral for the block policy.
 * `unknown` is reported but does not block: a comment we cannot locate in the
 * current text is as likely to be already orphaned as to be about to orphan,
 * and blocking on it would make every document with one stale comment
 * permanently unreplaceable.
 */
export function classifyCommentAnchors(comments, { removed, preserved }) {
    const removedNorm = normalizeQuote(removed);
    const preservedNorm = normalizeQuote(preserved);
    const affected = [];
    const maybe = [];
    const unknown = [];
    for (const comment of comments ?? []) {
        if (comment?.resolved) continue;
        const quote = normalizeQuote(comment?.quotedFileContent?.value);
        const entry = {
            id: comment?.id ?? null,
            author: comment?.author?.displayName ?? null,
            quote: preview(comment?.quotedFileContent?.value),
            comment: preview(comment?.content, 60),
        };
        if (!quote) {
            unknown.push(entry);
            continue;
        }
        const inRemoved = removedNorm.includes(quote);
        const inPreserved = preservedNorm.includes(quote);
        if (inRemoved && inPreserved) maybe.push(entry);
        else if (inRemoved) affected.push(entry);
        else if (!inPreserved) unknown.push(entry);
        // A quote found only in the preserved region survives; not reported.
    }
    return { affected, maybe, unknown };
}

/** Chars-in-a-response budget: every affected item is COUNTED, the first 25 are named. */
const MAX_LISTED = 25;

const listLines = (entries, render) => {
    const shown = entries.slice(0, MAX_LISTED).map((entry) => `  - ${render(entry)}`);
    if (entries.length > MAX_LISTED) {
        shown.push(`  … and ${entries.length - MAX_LISTED} more (all counted above; call listComments for the full list).`);
    }
    return shown.join('\n');
};

/**
 * Render the collateral findings as the caller-facing warning block.
 *
 * @param {object} input
 * @param {object|null} input.comments Result of classifyCommentAnchors, or null when the scan failed.
 * @param {string|null} input.commentScanError Why the comment scan produced nothing.
 * @param {boolean} input.commentsTruncated
 * @param {Array} input.links Result of collectHeadingLinks.
 * @param {boolean} input.wholeBody Whether the whole body is being replaced.
 * @returns {{lines: string[], hasCollateral: boolean, counts: object}}
 */
export function formatCollateral({ comments, commentScanError, commentsTruncated, links, wholeBody }) {
    const lines = [];
    const counts = {
        commentsAffected: comments?.affected.length ?? 0,
        commentsMaybeAffected: comments?.maybe.length ?? 0,
        commentsUnlocatable: comments?.unknown.length ?? 0,
        headingLinks: links?.length ?? 0,
    };

    if (commentScanError) {
        lines.push(`Comment-anchor check UNAVAILABLE: ${commentScanError} ` +
            'Unresolved comments anchored in the replaced content may orphan silently.');
    } else if (comments) {
        if (counts.commentsAffected > 0) {
            lines.push(`${counts.commentsAffected} unresolved comment anchor(s) will be removed by this replace ` +
                '(the comments survive in Drive, but stop pointing at any text):\n' +
                listLines(comments.affected, (c) => `comment ${c.id}${c.author ? ` by ${c.author}` : ''} on "${c.quote}"`));
        }
        if (counts.commentsMaybeAffected > 0) {
            lines.push(`${counts.commentsMaybeAffected} unresolved comment anchor(s) MAY be removed. Their quoted text ` +
                'occurs both inside and outside the replaced region, and the Drive API exposes the quote rather than ' +
                'the live anchor range, so this is an over-report by design:\n' +
                listLines(comments.maybe, (c) => `comment ${c.id}${c.author ? ` by ${c.author}` : ''} on "${c.quote}"`));
        }
        if (counts.commentsUnlocatable > 0) {
            lines.push(`${counts.commentsUnlocatable} unresolved comment(s) could not be located in the document text ` +
                '(no quoted anchor text, or the anchor no longer matches):\n' +
                listLines(comments.unknown, (c) => `comment ${c.id}${c.author ? ` by ${c.author}` : ''}${c.comment ? `: "${c.comment}"` : ''}`));
        }
        if (commentsTruncated) {
            lines.push(`Comment enumeration stopped after ${MAX_COMMENT_PAGES * COMMENT_PAGE_SIZE} comments; ` +
                'there are more, and they were NOT checked.');
        }
    }

    if (counts.headingLinks > 0) {
        lines.push(`${counts.headingLinks} in-document link(s) point at heading ids that ` +
            `${wholeBody ? 'will all be regenerated by this replace' : 'may be regenerated by this replace'}, ` +
            'so they will scroll nowhere until they are repointed at the new ids ' +
            '(the post-write heading map below gives you those ids):\n' +
            listLines(links, (l) => `"${preview(l.text, 60)}" -> ${l.headingId}${l.inTable ? ' (inside a table)' : ''}`));
    }

    const hasCollateral = counts.commentsAffected > 0
        || counts.commentsMaybeAffected > 0
        || counts.headingLinks > 0;
    return { lines, hasCollateral, counts };
}

/**
 * Gather everything, tolerating a failure of either half.
 *
 * A failure is NOT fatal on its own: the caller decides. Under
 * `onCollateral:'warn'` an unavailable scan degrades to a stated warning (a
 * Drive permission quirk must not block a Docs write the user is entitled to
 * make); under `'block'` the caller treats an unavailable scan as a refusal,
 * because a safety check that could not run cannot clear anything.
 */
export async function gatherCollateral(docs, drive, documentId, { tabId = null, startIndex, endIndex }) {
    let links = [];
    let comments = null;
    let commentScanError = null;
    let commentsTruncated = false;
    let structureScanError = null;
    let snapshot = null;

    try {
        snapshot = await fetchLinkAndTextSnapshot(docs, documentId, tabId);
        links = snapshot.links;
    } catch (error) {
        structureScanError = 'the document structure could not be re-read for the link scan.';
        logger.warn(`Heading-link collateral scan failed for ${documentId}: ${error?.message ?? error}`);
    }

    try {
        const listed = await listAllComments(drive, documentId);
        commentsTruncated = listed.truncated;
        const split = snapshot
            ? splitTextByRange(snapshot.fullText, snapshot.segments, startIndex, endIndex)
            : { removed: '', preserved: '' };
        comments = snapshot
            ? classifyCommentAnchors(listed.comments, split)
            // With no text snapshot there is nothing to match quotes against, so
            // every unresolved comment is reported as unlocatable rather than
            // silently cleared.
            : classifyCommentAnchors(listed.comments, { removed: '', preserved: '' });
    } catch (error) {
        commentScanError = 'the document\'s comments could not be listed.';
        logger.warn(`Comment-anchor collateral scan failed for ${documentId}: ${error?.message ?? error}`);
    }

    return { links, comments, commentScanError, commentsTruncated, structureScanError, snapshot };
}
