import { publicError, isPublicError, wrapOperationError } from './errors.js';
import { hexToRgbColor, NotImplementedError } from './types.js';
import { logger } from './logger.js';
// --- Constants ---
const MAX_BATCH_UPDATE_REQUESTS = 50; // Google API limits batch size
// --- Core Helper to Execute Batch Updates ---
export async function executeBatchUpdate(docs, documentId, requests, writeControl) {
    if (!requests || requests.length === 0) {
        // console.warn("executeBatchUpdate called with no requests.");
        return {}; // Nothing to do
    }
    // TODO: Consider splitting large request arrays into multiple batches if needed
    if (requests.length > MAX_BATCH_UPDATE_REQUESTS) {
        logger.warn(`Attempting batch update with ${requests.length} requests, exceeding typical limits. May fail.`);
    }
    try {
        const response = await docs.documents.batchUpdate({
            documentId: documentId,
            requestBody: { requests, ...(writeControl && { writeControl }) },
        });
        return response.data;
    }
    catch (error) {
        if (isPublicError(error)) throw error;
        logger.error(`Google API batchUpdate Error for doc ${documentId}:`, error.response?.data || error.message);
        // Translate common API errors to UserErrors
        const apiMessage = error.response?.data?.error?.message || error.message || '';
        const apiStatus = error.response?.data?.error?.status;
        // A write sent with writeControl that fails on the revision is a
        // concurrency conflict. Don't rely on message wording alone —
        // FAILED_PRECONDITION is Google's canonical status for this.
        const isRevisionConflict = writeControl && (
            apiStatus === 'FAILED_PRECONDITION' ||
            ((error.code === 400 || error.code === 409) && /revision|write\s*control|updated since/i.test(apiMessage))
        );
        if (isRevisionConflict) {
            throw publicError(`This document (${documentId}) changed since you last read it. Read the document again before editing to ensure you have current content.`);
        }
        if (error.code === 400 && error.message.includes('Invalid requests')) {
            // Try to extract more specific info if available
            const details = error.response?.data?.error?.details;
            let detailMsg = '';
            if (details && Array.isArray(details)) {
                // Only the API's own structured `description` strings are
                // caller-safe. A detail entry without one is an unknown shape,
                // so it is dropped rather than JSON.stringify'd into the public
                // message — the whole error still reaches the server log below.
                detailMsg = details
                    .map((d) => (typeof d?.description === 'string' ? d.description : ''))
                    .filter(Boolean)
                    .join('; ');
            }
            // The raw `error.message` fallback is arbitrary internal text, so it
            // stays an internal cause instead of being promoted to a public message.
            if (!detailMsg) {
                throw wrapOperationError('Google Docs batch update', error, { status: error.code });
            }
            throw publicError(`Invalid request sent to Google Docs API. Details: ${detailMsg}`);
        }
        if (error.code === 404)
            throw publicError(`Document not found (ID: ${documentId}). Check the ID.`);
        if (error.code === 403)
            throw publicError(`Permission denied for document (ID: ${documentId}). Ensure the authenticated user has edit access.`);
        // Generic internal error for others
        throw new Error(`Google API Error (${error.code}): ${error.message}`);
    }
}
/**
 * Creates a small stateful helper for chaining an optimistic-concurrency guard
 * across a sequence of writes that make up a single logical operation (e.g.
 * delete -> cleanup -> insert). The first write carries the revision from the
 * caller's last read; each subsequent write must require the revision the
 * previous write produced (returned as `writeControl` on a successful
 * batchUpdate response), so a collaborator edit landing between any two of
 * our own batches is rejected as a conflict instead of silently applied
 * against (PR #42 review).
 *
 * Guarding is opt-in: when `revisionId` is null/undefined (a legacy read that
 * never captured a revision), `current` stays undefined for the life of the
 * chain and `advance` is a no-op, so the flow remains unguarded.
 *
 * @param revisionId - The revisionId from the caller's last tracked read, or null/undefined
 * @returns { get current(), advance(response) }
 */
export function createWriteControlChain(revisionId) {
    let pendingWriteControl = revisionId ? { requiredRevisionId: revisionId } : undefined;
    return {
        get current() {
            return pendingWriteControl;
        },
        // Advance the chain to the revision produced by a successful write.
        // Only advances when the chain is armed and the response carried a new
        // writeControl — a best-effort write that fails (and is swallowed by the
        // caller) must NOT advance the chain, since the document was not modified.
        advance(response) {
            if (pendingWriteControl && response?.writeControl) {
                pendingWriteControl = response.writeControl;
            }
        },
    };
}
/**
 * Executes batch updates with automatic splitting for large request arrays.
 * Separates insert and format operations, executing inserts first.
 *
 * @param docs - The Google Docs client
 * @param documentId - The document ID
 * @param requests - Array of requests to execute
 * @param log - Optional logger for progress tracking
 * @returns Metadata about the execution (request counts, API calls, timing)
 */
export async function executeBatchUpdateWithSplitting(docs, documentId, requests, log, writeControl) {
    const overallStart = performance.now();
    if (!requests || requests.length === 0) {
        return {
            totalRequests: 0,
            phases: {
                delete: { requests: 0, apiCalls: 0, elapsedMs: 0 },
                insert: { requests: 0, apiCalls: 0, elapsedMs: 0 },
                format: { requests: 0, apiCalls: 0, elapsedMs: 0 },
            },
            totalApiCalls: 0,
            totalElapsedMs: 0,
        };
    }
    const MAX_BATCH = MAX_BATCH_UPDATE_REQUESTS;
    // Separate requests into three categories
    // Order of execution: delete → insert → format
    const deleteRequests = requests.filter((r) => 'deleteContentRange' in r);
    const insertRequests = requests.filter((r) => 'insertText' in r ||
        'insertTable' in r ||
        'insertPageBreak' in r ||
        'insertInlineImage' in r ||
        'insertSectionBreak' in r);
    const formatRequests = requests.filter((r) => !('deleteContentRange' in r) &&
        !('insertText' in r ||
            'insertTable' in r ||
            'insertPageBreak' in r ||
            'insertInlineImage' in r ||
            'insertSectionBreak' in r));
    let totalApiCalls = 0;
    // Chain the optimistic-concurrency guard across every batch this operation
    // sends. When markdown is split into delete/insert/format phases (or a phase
    // exceeds 50 requests), each successful batchUpdate returns the document's new
    // head revision in its writeControl. Requiring that revision on the next batch
    // means a collaborator edit landing between our batches is rejected as a
    // conflict instead of having our precomputed ranges applied to their content
    // (PR #42 review). Only chain when we started guarded, so legacy flows that
    // never captured a revision stay unguarded.
    let chainedWriteControl = writeControl;
    const executeBatch = async (batch) => {
        const data = await executeBatchUpdate(docs, documentId, batch, chainedWriteControl);
        if (chainedWriteControl && data?.writeControl) {
            chainedWriteControl = data.writeControl;
        }
    };
    // Execute delete batches first (must happen before inserts)
    const deleteStart = performance.now();
    if (deleteRequests.length > 0) {
        if (log) {
            log.info(`Executing ${deleteRequests.length} delete requests FIRST (in separate API call)`);
        }
        for (let i = 0; i < deleteRequests.length; i += MAX_BATCH) {
            const batch = deleteRequests.slice(i, i + MAX_BATCH);
            if (log) {
                log.info(`Delete batch content: ${JSON.stringify(batch)}`);
            }
            await executeBatch(batch);
            totalApiCalls++;
            if (log) {
                const batchNum = Math.floor(i / MAX_BATCH) + 1;
                const totalBatches = Math.ceil(deleteRequests.length / MAX_BATCH);
                log.info(`Executed delete batch ${batchNum}/${totalBatches} (${batch.length} requests)`);
            }
        }
        if (log) {
            log.info(`Delete batches complete. Document should now be empty (except section break).`);
        }
    }
    const deleteElapsed = performance.now() - deleteStart;
    // Then execute insert batches
    const insertStart = performance.now();
    if (insertRequests.length > 0) {
        for (let i = 0; i < insertRequests.length; i += MAX_BATCH) {
            const batch = insertRequests.slice(i, i + MAX_BATCH);
            await executeBatch(batch);
            totalApiCalls++;
            if (log) {
                const batchNum = Math.floor(i / MAX_BATCH) + 1;
                const totalBatches = Math.ceil(insertRequests.length / MAX_BATCH);
                log.info(`Executed insert batch ${batchNum}/${totalBatches} (${batch.length} requests)`);
            }
        }
    }
    const insertElapsed = performance.now() - insertStart;
    // Finally execute format batches
    const formatStart = performance.now();
    if (formatRequests.length > 0) {
        for (let i = 0; i < formatRequests.length; i += MAX_BATCH) {
            const batch = formatRequests.slice(i, i + MAX_BATCH);
            await executeBatch(batch);
            totalApiCalls++;
            if (log) {
                const batchNum = Math.floor(i / MAX_BATCH) + 1;
                const totalBatches = Math.ceil(formatRequests.length / MAX_BATCH);
                log.info(`Executed format batch ${batchNum}/${totalBatches} (${batch.length} requests)`);
            }
        }
    }
    const formatElapsed = performance.now() - formatStart;
    const totalElapsedMs = performance.now() - overallStart;
    return {
        totalRequests: requests.length,
        phases: {
            delete: {
                requests: deleteRequests.length,
                apiCalls: Math.ceil(deleteRequests.length / MAX_BATCH) || 0,
                elapsedMs: Math.round(deleteElapsed),
            },
            insert: {
                requests: insertRequests.length,
                apiCalls: Math.ceil(insertRequests.length / MAX_BATCH) || 0,
                elapsedMs: Math.round(insertElapsed),
            },
            format: {
                requests: formatRequests.length,
                apiCalls: Math.ceil(formatRequests.length / MAX_BATCH) || 0,
                elapsedMs: Math.round(formatElapsed),
            },
        },
        totalApiCalls,
        totalElapsedMs: Math.round(totalElapsedMs),
        // The revision guard after the last batch, so a caller that writes again
        // after this call can keep the chain intact.
        finalWriteControl: chainedWriteControl,
    };
}
// --- Text Finding Helper ---
// This improved version is more robust in handling various text structure scenarios
// --- text-search snapshots (issue #88) --------------------------------------
//
// `findTextRange` used to be the only entry point, and it fetched the document
// on every call. `batchModifyText` resolves N text-search targets that must all
// address ONE consistent document state, so the search core is split into a
// pure `findTextRangeInDoc(docJson, ...)` over a caller-supplied snapshot, with
// `findTextRange` becoming fetch-then-delegate. Both share this field mask, so
// a snapshot taken with `textSearchFields()` resolves identically either way.
const TEXT_SEARCH_BODY_SUBTREE =
    'content(paragraph(elements(startIndex,endIndex,textRun(content))),table,sectionBreak,tableOfContents,startIndex,endIndex)';

/** Field mask a snapshot must be fetched with to be usable by findTextRangeInDoc. */
export function textSearchFields(tabId) {
    return tabId
        ? `tabs(tabProperties(tabId),documentTab(body(${TEXT_SEARCH_BODY_SUBTREE})))`
        : `body(${TEXT_SEARCH_BODY_SUBTREE})`;
}

/**
 * Pure form of getDocumentTextAndSegments: flat text plus index segments for an
 * already-fetched document. Tab selection is identical to the fetching form —
 * a snapshot variant that ignored `tabId` would resolve against the default
 * body and silently target the wrong tab.
 */
export function extractTextAndSegments(docJson, tabId) {
    let bodyContent;
    if (tabId) {
        const targetTab = findTabById(docJson, tabId);
        if (!targetTab) {
            throw publicError(`Tab with ID "${tabId}" not found in document.`);
        }
        if (!targetTab.documentTab?.body?.content) {
            throw publicError(`Tab "${tabId}" does not have content (may not be a document tab).`);
        }
        bodyContent = targetTab.documentTab.body.content;
    }
    else {
        bodyContent = docJson?.body?.content;
    }
    if (!bodyContent) {
        return null;
    }
    let fullText = '';
    const segments = [];
    const collectTextFromContent = (content) => {
        content.forEach((element) => {
            if (element.paragraph?.elements) {
                element.paragraph.elements.forEach((pe) => {
                    if (pe.textRun?.content && pe.startIndex !== undefined && pe.endIndex !== undefined) {
                        const content = pe.textRun.content;
                        fullText += content;
                        segments.push({
                            text: content,
                            start: pe.startIndex,
                            end: pe.endIndex,
                        });
                    }
                });
            }
            if (element.table && element.table.tableRows) {
                element.table.tableRows.forEach((row) => {
                    if (row.tableCells) {
                        row.tableCells.forEach((cell) => {
                            if (cell.content) {
                                collectTextFromContent(cell.content);
                            }
                        });
                    }
                });
            }
        });
    };
    collectTextFromContent(bodyContent);
    segments.sort((a, b) => a.start - b.start);
    return { fullText, segments };
}

/**
 * Fetches document content and builds a flat text representation with segment
 * mappings. Thin fetch-then-delegate wrapper over `extractTextAndSegments`.
 */
async function getDocumentTextAndSegments(docs, documentId, tabId) {
    const needsTabsContent = !!tabId;
    const res = await docs.documents.get({
        documentId,
        ...(needsTabsContent && { includeTabsContent: true }),
        fields: textSearchFields(tabId),
    });
    return extractTextAndSegments(res.data, tabId);
}
/**
 * Maps a position in the concatenated fullText back to the actual document index.
 */
function mapFullTextPositionToDocIndex(posInFullText, segments) {
    let currentPos = 0;
    for (const seg of segments) {
        const segStart = currentPos;
        const segEnd = segStart + seg.text.length;
        if (posInFullText >= segStart && posInFullText < segEnd) {
            return seg.start + (posInFullText - segStart);
        }
        // Also handle the position being exactly at segEnd (for end indices)
        if (posInFullText === segEnd) {
            return seg.start + seg.text.length;
        }
        currentPos = segEnd;
    }
    return -1;
}
/**
 * Character-level Unicode normalization rules.
 * Maps typographic characters to their ASCII equivalents.
 */
const NORMALIZE_MAP = {
    '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", '\u2032': "'", '\u2035': "'",  // smart single quotes
    '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"', '\u2033': '"', '\u2036': '"',  // smart double quotes
    '\u2014': '--',  // em dash
    '\u2013': '-',   // en dash
    '\u2026': '...', // ellipsis
    '\u00A0': ' ',   // non-breaking space
    '\u000B': '\n',  // vertical tab (Google Docs soft return)
};
/**
 * Normalizes a string for search, returning both the normalized text
 * and a position map from normalized-index → original-index.
 */
function normalizeWithPositionMap(text) {
    let normalized = '';
    const posMap = []; // posMap[normalizedIdx] = originalIdx
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const replacement = NORMALIZE_MAP[ch];
        if (replacement) {
            for (let j = 0; j < replacement.length; j++) {
                posMap.push(i);
                normalized += replacement[j];
            }
        } else {
            posMap.push(i);
            normalized += ch;
        }
    }
    // Sentinel for end-of-string mapping
    posMap.push(text.length);
    return { normalized, posMap };
}
/**
 * Simple normalization without position map (for normalizing the search query).
 */
function normalizeForSearch(text) {
    let result = '';
    for (let i = 0; i < text.length; i++) {
        const replacement = NORMALIZE_MAP[text[i]];
        result += replacement ?? text[i];
    }
    return result;
}
/**
 * readDocument(format='markdown') includes markdown list markers ("- ",
 * "1. ", etc.), but Google Docs text runs do not include list glyphs. When a
 * caller copies a bullet line from markdown into textToFind, retry without
 * those line-start markers.
 */
export function stripMarkdownListMarkersForSearch(text) {
    return text
        .split('\n')
        .map((line) => line.replace(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)/, '$1'))
        .join('\n');
}
/**
 * Finds all occurrences of textToFind in the document and returns them with
 * surrounding context and mapped document indices.
 */
function findAllOccurrences(fullText, segments, textToFind) {
    const CONTEXT_CHARS = 30;
    const occurrences = [];
    let searchFrom = 0;
    while (true) {
        const idx = fullText.indexOf(textToFind, searchFrom);
        if (idx === -1)
            break;
        const docStart = mapFullTextPositionToDocIndex(idx, segments);
        const docEnd = mapFullTextPositionToDocIndex(idx + textToFind.length, segments);
        // Extract surrounding context
        const contextStart = Math.max(0, idx - CONTEXT_CHARS);
        const contextEnd = Math.min(fullText.length, idx + textToFind.length + CONTEXT_CHARS);
        const before = fullText.slice(contextStart, idx).replace(/\n/g, '\\n');
        const match = fullText.slice(idx, idx + textToFind.length).replace(/\n/g, '\\n');
        const after = fullText.slice(idx + textToFind.length, contextEnd).replace(/\n/g, '\\n');
        const context = `${contextStart > 0 ? '...' : ''}${before}[${match}]${after}${contextEnd < fullText.length ? '...' : ''}`;
        occurrences.push({
            instance: occurrences.length + 1,
            startIndex: docStart,
            endIndex: docEnd,
            context,
        });
        searchFrom = idx + 1;
    }
    return occurrences;
}
const SEARCH_FAILURE_CONTEXT_CHARS = 40;

/**
 * Work out *where* a failed `textToFind` stopped matching (issue #105).
 *
 * Previously a miss produced a bare `null` and each caller turned that into
 * "Could not find X", which tells the caller nothing about which part of their
 * string was wrong — the common real cause being a near-miss on a long
 * multi-line search string.
 *
 * The longest matching prefix is monotonic (if a prefix of length k appears in
 * the document, so does every shorter one), so a binary search finds it in
 * O(log n) `indexOf` calls. Everything is measured on the *normalized* text,
 * the most forgiving of the four match strategies, so the reported divergence
 * is the point past which no strategy could have matched.
 *
 * @returns {{found:false, reason:string, textToFind:string, candidateCount:number,
 *   bestPrefixLength:number, divergenceIndex:number|null, matchedPrefix:string,
 *   contextBefore:string, contextAfter:string, message:string}}
 */
function diagnoseTextSearchFailure(fullText, textToFind, { reason = 'notFound', candidateCount = 0, tabId = null, requestedInstance = null } = {}) {
    const scope = tabId ? ` in tab ${tabId}` : '';
    const failure = {
        found: false,
        reason,
        textToFind,
        candidateCount,
        bestPrefixLength: 0,
        divergenceIndex: null,
        matchedPrefix: '',
        contextBefore: '',
        contextAfter: '',
        message: '',
    };
    const searchText = normalizeForSearch(stripMarkdownListMarkersForSearch(textToFind ?? ''));
    const { normalized: haystack } = normalizeWithPositionMap(fullText ?? '');
    if (searchText.length > 0 && haystack.length > 0) {
        let lo = 0;
        let hi = searchText.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (haystack.indexOf(searchText.slice(0, mid)) !== -1) lo = mid;
            else hi = mid - 1;
        }
        failure.bestPrefixLength = lo;
        if (lo > 0) {
            const prefix = searchText.slice(0, lo);
            const at = haystack.indexOf(prefix);
            let count = 0;
            for (let from = at; from !== -1; from = haystack.indexOf(prefix, from + 1)) count += 1;
            failure.candidateCount = candidateCount || count;
            failure.divergenceIndex = lo < searchText.length ? lo : null;
            failure.matchedPrefix = prefix.slice(-SEARCH_FAILURE_CONTEXT_CHARS).replace(/\n/g, '\\n');
            failure.contextBefore = haystack
                .slice(Math.max(0, at - SEARCH_FAILURE_CONTEXT_CHARS), at)
                .replace(/\n/g, '\\n');
            failure.contextAfter = haystack
                .slice(at + lo, at + lo + SEARCH_FAILURE_CONTEXT_CHARS)
                .replace(/\n/g, '\\n');
        }
    }

    if (reason === 'noContent') {
        failure.message = `The document has no readable text content${scope}, so "${textToFind}" cannot be located.`;
    }
    else if (reason === 'instanceOutOfRange') {
        failure.candidateCount = candidateCount;
        failure.message =
            `Instance ${requestedInstance ?? '?'} of "${textToFind}"${scope} does not exist: only ` +
            `${candidateCount} match${candidateCount === 1 ? '' : 'es'} were found. ` +
            'Pass a matchInstance between 1 and ' + candidateCount + '.';
    }
    else if (failure.bestPrefixLength === 0) {
        failure.message =
            `Could not find "${textToFind}"${scope}. Not even its first character matched anywhere in the document, ` +
            "so the search string likely belongs to a different document or tab. Call readDocument with format='index' " +
            'to see the document structure.';
    }
    else if (failure.divergenceIndex === null) {
        failure.message = `Could not find "${textToFind}"${scope}.`;
    }
    else {
        const expectedTail = searchText
            .slice(failure.divergenceIndex, failure.divergenceIndex + SEARCH_FAILURE_CONTEXT_CHARS)
            .replace(/\n/g, '\\n');
        failure.message =
            `Could not find "${textToFind}"${scope}. The first ${failure.bestPrefixLength} character(s) matched ` +
            `(${failure.candidateCount} place${failure.candidateCount === 1 ? '' : 's'} in the document), then the ` +
            `search diverged at offset ${failure.divergenceIndex}: the document has ` +
            `"…${failure.matchedPrefix}${failure.contextAfter}…" where the search expected ` +
            `"…${failure.matchedPrefix}${expectedTail}…". ` +
            "Copy the exact text from readDocument, or address the edit by index using format='index'.";
    }
    return failure;
}

/**
 * The search itself, over an already-extracted `{ fullText, segments }`.
 * Identical behavior for the fetching and the snapshot entry points: the full
 * four-strategy fallback chain (exact -> list-marker-stripped -> unicode
 * normalized -> both), the multi-instance disambiguation error, and the
 * structured failure diagnostics all live here and nowhere else.
 */
function searchTextSegments(result, textToFind, instance, tabId, documentId = 'snapshot') {
    {
        const { fullText, segments } = result;
        let allOccurrences = findAllOccurrences(fullText, segments, textToFind);
        // Fallback: markdown exports include list markers that are absent from
        // Docs API text runs. Retry after stripping line-start markdown markers.
        if (allOccurrences.length === 0) {
            const listMarkerStrippedSearch = stripMarkdownListMarkersForSearch(textToFind);
            if (listMarkerStrippedSearch !== textToFind) {
                logger.debug(`Exact match failed, trying match without markdown list markers`);
                allOccurrences = findAllOccurrences(fullText, segments, listMarkerStrippedSearch);
            }
        }
        // Fallback: try normalized matching if exact match fails (issue #11)
        if (allOccurrences.length === 0) {
            const normalizedSearch = normalizeForSearch(textToFind);
            const { normalized: normalizedFull, posMap } = normalizeWithPositionMap(fullText);
            if (normalizedSearch !== textToFind || normalizedFull !== fullText) {
                logger.debug(`Exact match failed, trying normalized match`);
                // Find in normalized text, then map positions back to original
                const CONTEXT_CHARS = 30;
                let searchFrom = 0;
                while (true) {
                    const idx = normalizedFull.indexOf(normalizedSearch, searchFrom);
                    if (idx === -1) break;
                    // Map normalized positions back to original fullText positions
                    const origStart = posMap[idx];
                    const origEnd = posMap[idx + normalizedSearch.length];
                    const docStart = mapFullTextPositionToDocIndex(origStart, segments);
                    const docEnd = mapFullTextPositionToDocIndex(origEnd, segments);
                    const contextStart = Math.max(0, origStart - CONTEXT_CHARS);
                    const contextEnd = Math.min(fullText.length, origEnd + CONTEXT_CHARS);
                    const before = fullText.slice(contextStart, origStart).replace(/\n/g, '\\n');
                    const match = fullText.slice(origStart, origEnd).replace(/\n/g, '\\n');
                    const after = fullText.slice(origEnd, contextEnd).replace(/\n/g, '\\n');
                    const context = `${contextStart > 0 ? '...' : ''}${before}[${match}]${after}${contextEnd < fullText.length ? '...' : ''}`;
                    allOccurrences.push({
                        instance: allOccurrences.length + 1,
                        startIndex: docStart,
                        endIndex: docEnd,
                        context,
                    });
                    searchFrom = idx + 1;
                }
            }
        }
        // Fallback: combine both approaches for copied markdown bullets that
        // also contain smart quotes, non-breaking spaces, or typographic dashes.
        if (allOccurrences.length === 0) {
            const listMarkerStrippedSearch = stripMarkdownListMarkersForSearch(textToFind);
            const normalizedSearch = normalizeForSearch(listMarkerStrippedSearch);
            const { normalized: normalizedFull, posMap } = normalizeWithPositionMap(fullText);
            if (normalizedSearch !== textToFind || normalizedFull !== fullText) {
                logger.debug(`Exact match failed, trying normalized match without markdown list markers`);
                const CONTEXT_CHARS = 30;
                let searchFrom = 0;
                while (true) {
                    const idx = normalizedFull.indexOf(normalizedSearch, searchFrom);
                    if (idx === -1) break;
                    const origStart = posMap[idx];
                    const origEnd = posMap[idx + normalizedSearch.length];
                    const docStart = mapFullTextPositionToDocIndex(origStart, segments);
                    const docEnd = mapFullTextPositionToDocIndex(origEnd, segments);
                    const contextStart = Math.max(0, origStart - CONTEXT_CHARS);
                    const contextEnd = Math.min(fullText.length, origEnd + CONTEXT_CHARS);
                    const before = fullText.slice(contextStart, origStart).replace(/\n/g, '\\n');
                    const match = fullText.slice(origStart, origEnd).replace(/\n/g, '\\n');
                    const after = fullText.slice(origEnd, contextEnd).replace(/\n/g, '\\n');
                    const context = `${contextStart > 0 ? '...' : ''}${before}[${match}]${after}${contextEnd < fullText.length ? '...' : ''}`;
                    allOccurrences.push({
                        instance: allOccurrences.length + 1,
                        startIndex: docStart,
                        endIndex: docEnd,
                        context,
                    });
                    searchFrom = idx + 1;
                }
            }
        }
        if (allOccurrences.length === 0) {
            logger.warn(`Text "${textToFind}" not found in document ${documentId}`);
            // Structured failure, not a bare null: the caller renders where the
            // match diverged instead of "could not find it" (issue #105).
            return diagnoseTextSearchFailure(fullText, textToFind, { reason: 'notFound', tabId });
        }
        // If instance is not specified and there are multiple matches, return all of them
        // so the caller can disambiguate
        if (instance === undefined && allOccurrences.length > 1) {
            const listing = allOccurrences.map((o) => `  ${o.instance}. index ${o.startIndex}-${o.endIndex}: ${o.context}`).join('\n');
            throw publicError(`Found ${allOccurrences.length} instances of "${textToFind}". ` +
                `Specify matchInstance to target the correct one:\n${listing}`);
        }
        // Use instance 1 if not specified (single match case)
        const targetInstance = instance ?? 1;
        if (targetInstance > allOccurrences.length) {
            logger.warn(`Requested instance ${targetInstance} but only ${allOccurrences.length} found`);
            return diagnoseTextSearchFailure(fullText, textToFind, {
                reason: 'instanceOutOfRange',
                candidateCount: allOccurrences.length,
                requestedInstance: targetInstance,
                tabId,
            });
        }
        const match = allOccurrences[targetInstance - 1];
        if (match.startIndex === -1 || match.endIndex === -1) {
            logger.warn(`Failed to map text "${textToFind}" instance ${targetInstance} to actual document indices`);
            return { startIndex: match.startIndex, endIndex: match.endIndex };
        }
        logger.debug(`Successfully mapped "${textToFind}" instance ${targetInstance} to document range ${match.startIndex}-${match.endIndex}`);
        return { startIndex: match.startIndex, endIndex: match.endIndex };
    }
}

/**
 * Resolve `textToFind` against an ALREADY-FETCHED document snapshot.
 *
 * Exists so a multi-operation tool can resolve every target against one
 * consistent document state instead of re-fetching per operation (which would
 * let the document shift under successive resolutions). The snapshot must have
 * been fetched with `textSearchFields(tabId)` (a superset mask is fine).
 *
 * Same return contract as `findTextRange`: `{startIndex,endIndex}` on success,
 * a structured `{found:false, message, ...}` diagnosis on a miss, and a thrown
 * publicError when the text is ambiguous and no `instance` was given.
 */
export function findTextRangeInDoc(docJson, textToFind, instance, tabId) {
    const result = extractTextAndSegments(docJson, tabId);
    if (!result) {
        return diagnoseTextSearchFailure('', textToFind, { reason: 'noContent', tabId });
    }
    return searchTextSegments(result, textToFind, instance, tabId);
}

export async function findTextRange(docs, documentId, textToFind, instance, tabId) {
    try {
        const result = await getDocumentTextAndSegments(docs, documentId, tabId);
        if (!result) {
            logger.warn(`No content found in document ${documentId}${tabId ? ` (tab: ${tabId})` : ''}`);
            return diagnoseTextSearchFailure('', textToFind, { reason: 'noContent', tabId });
        }
        logger.debug(`Document ${documentId} contains ${result.segments.length} text segments and ${result.fullText.length} characters in total.`);
        return searchTextSegments(result, textToFind, instance, tabId, documentId);
    }
    catch (error) {
        if (isPublicError(error))
            throw error;
        logger.error(`Error finding text "${textToFind}" in doc ${documentId}: ${error.message || 'Unknown error'}`);
        if (error.code === 404)
            throw publicError(`Document not found while searching text (ID: ${documentId}).`);
        if (error.code === 403)
            throw publicError(`Permission denied while searching text in doc ${documentId}.`);
        throw new Error(`Failed to retrieve doc for text searching: ${error.message || 'Unknown error'}`);
    }
}
// --- Paragraph Boundary Helper ---
// Enhanced version to handle document structural elements more robustly
export async function getParagraphRange(docs, documentId, indexWithin, tabId) {
    try {
        logger.debug(`Finding paragraph containing index ${indexWithin} in document ${documentId}${tabId ? ` (tab: ${tabId})` : ''}`);
        // When tabId is specified, we need to use includeTabsContent to access tab-specific content
        const needsTabsContent = !!tabId;
        // Request more detailed document structure to handle nested elements
        const res = await docs.documents.get({
            documentId,
            ...(needsTabsContent && { includeTabsContent: true }),
            // Request more comprehensive structure information
            fields: needsTabsContent
                ? 'tabs(tabProperties(tabId),documentTab(body(content(startIndex,endIndex,paragraph,table,sectionBreak,tableOfContents))))'
                : 'body(content(startIndex,endIndex,paragraph,table,sectionBreak,tableOfContents))',
        });
        // Get body content from the correct tab or default
        let bodyContent;
        if (tabId) {
            const targetTab = findTabById(res.data, tabId);
            if (!targetTab) {
                throw publicError(`Tab with ID "${tabId}" not found in document.`);
            }
            if (!targetTab.documentTab?.body?.content) {
                throw publicError(`Tab "${tabId}" does not have content (may not be a document tab).`);
            }
            bodyContent = targetTab.documentTab.body.content;
        }
        else {
            bodyContent = res.data.body?.content;
        }
        if (!bodyContent) {
            logger.warn(`No content found in document ${documentId}${tabId ? ` (tab: ${tabId})` : ''}`);
            return null;
        }
        // Find paragraph containing the index
        // We'll look at all structural elements recursively
        const findParagraphInContent = (content) => {
            for (const element of content) {
                // Check if we have element boundaries defined
                if (element.startIndex !== undefined && element.endIndex !== undefined) {
                    // Check if index is within this element's range first
                    if (indexWithin >= element.startIndex && indexWithin < element.endIndex) {
                        // If it's a paragraph, we've found our target
                        if (element.paragraph) {
                            logger.debug(`Found paragraph containing index ${indexWithin}, range: ${element.startIndex}-${element.endIndex}`);
                            return {
                                startIndex: element.startIndex,
                                endIndex: element.endIndex,
                            };
                        }
                        // If it's a table, we need to check cells recursively
                        if (element.table && element.table.tableRows) {
                            logger.debug(`Index ${indexWithin} is within a table, searching cells...`);
                            for (const row of element.table.tableRows) {
                                if (row.tableCells) {
                                    for (const cell of row.tableCells) {
                                        if (cell.content) {
                                            const result = findParagraphInContent(cell.content);
                                            if (result)
                                                return result;
                                        }
                                    }
                                }
                            }
                        }
                        // For other structural elements, we didn't find a paragraph
                        // but we know the index is within this element
                        logger.warn(`Index ${indexWithin} is within element (${element.startIndex}-${element.endIndex}) but not in a paragraph`);
                    }
                }
            }
            return null;
        };
        const paragraphRange = findParagraphInContent(bodyContent);
        if (!paragraphRange) {
            logger.warn(`Could not find paragraph containing index ${indexWithin}`);
        }
        else {
            logger.debug(`Returning paragraph range: ${paragraphRange.startIndex}-${paragraphRange.endIndex}`);
        }
        return paragraphRange;
    }
    catch (error) {
        if (isPublicError(error)) throw error;
        logger.error(`Error getting paragraph range for index ${indexWithin} in doc ${documentId}: ${error.message || 'Unknown error'}`);
        if (error.code === 404)
            throw publicError(`Document not found while finding paragraph (ID: ${documentId}).`);
        if (error.code === 403)
            throw publicError(`Permission denied while accessing doc ${documentId}.`);
        throw new Error(`Failed to find paragraph: ${error.message || 'Unknown error'}`);
    }
}
// --- Default text color (issue #14) ---
/**
 * Looks up the document's NORMAL_TEXT named style and returns its explicit
 * RGB foreground color, if it has one.
 *
 * Shared by every insertion path that wants inserted text to carry an
 * explicit color (matching the document default) instead of leaving it
 * undefined, which Google Docs treats as "no color selected" in the picker.
 *
 * Does NOT log — callers decide what a fetch failure means for them (most
 * treat it as non-fatal and log a warning, then proceed without a color).
 * Theme-color-based NORMAL_TEXT styles (no `rgbColor`) are treated the same
 * as "no explicit default": matching a theme slot can't be done with a fixed
 * RGB paint without freezing it to today's theme.
 *
 * @returns {Promise<{color: {red?:number,green?:number,blue?:number}|null, error: Error|null}>}
 */
export async function getDefaultTextColor(docs, documentId) {
    try {
        const styleRes = await docs.documents.get({
            documentId,
            fields: 'namedStyles',
        });
        const normalTextStyle = styleRes.data.namedStyles?.styles?.find((s) => s.namedStyleType === 'NORMAL_TEXT');
        const rgbColor = normalTextStyle?.textStyle?.foregroundColor?.color?.rgbColor;
        return { color: rgbColor ?? null, error: null };
    }
    catch (error) {
        return { color: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
}
/**
 * Builds an updateTextStyle request that paints [startIndex, endIndex) with
 * an explicit foreground color (an rgbColor object as returned by
 * getDefaultTextColor). Returns null for an empty/invalid range so callers
 * can push-if-truthy without an extra guard.
 */
export function buildDefaultColorStyleRequest(startIndex, endIndex, color, tabId) {
    if (!color || endIndex <= startIndex)
        return null;
    const range = { startIndex, endIndex };
    if (tabId)
        range.tabId = tabId;
    return {
        updateTextStyle: {
            range,
            textStyle: {
                foregroundColor: { color: { rgbColor: color } },
            },
            fields: 'foregroundColor',
        },
    };
}
// --- Style Request Builders ---
export function buildUpdateTextStyleRequest(startIndex, endIndex, style, tabId) {
    const textStyle = {};
    const fieldsToUpdate = [];
    if (style.bold !== undefined) {
        textStyle.bold = style.bold;
        fieldsToUpdate.push('bold');
    }
    if (style.italic !== undefined) {
        textStyle.italic = style.italic;
        fieldsToUpdate.push('italic');
    }
    if (style.underline !== undefined) {
        textStyle.underline = style.underline;
        fieldsToUpdate.push('underline');
    }
    if (style.strikethrough !== undefined) {
        textStyle.strikethrough = style.strikethrough;
        fieldsToUpdate.push('strikethrough');
    }
    if (style.fontSize !== undefined) {
        textStyle.fontSize = { magnitude: style.fontSize, unit: 'PT' };
        fieldsToUpdate.push('fontSize');
    }
    if (style.fontFamily !== undefined) {
        textStyle.weightedFontFamily = { fontFamily: style.fontFamily };
        fieldsToUpdate.push('weightedFontFamily');
    }
    if (style.foregroundColor !== undefined) {
        const rgbColor = hexToRgbColor(style.foregroundColor);
        if (!rgbColor)
            throw publicError(`Invalid foreground hex color format: ${style.foregroundColor}`);
        textStyle.foregroundColor = { color: { rgbColor: rgbColor } };
        fieldsToUpdate.push('foregroundColor');
    }
    if (style.backgroundColor !== undefined) {
        const rgbColor = hexToRgbColor(style.backgroundColor);
        if (!rgbColor)
            throw publicError(`Invalid background hex color format: ${style.backgroundColor}`);
        textStyle.backgroundColor = { color: { rgbColor: rgbColor } };
        fieldsToUpdate.push('backgroundColor');
    }
    if (style.linkUrl !== undefined) {
        textStyle.link = { url: style.linkUrl };
        fieldsToUpdate.push('link');
    }
    // TODO: Handle clearing formatting
    if (fieldsToUpdate.length === 0)
        return null; // No styles to apply
    const range = { startIndex, endIndex };
    if (tabId) {
        range.tabId = tabId;
    }
    const request = {
        updateTextStyle: {
            range,
            textStyle: textStyle,
            fields: fieldsToUpdate.join(','),
        },
    };
    return { request, fields: fieldsToUpdate };
}
export function buildUpdateParagraphStyleRequest(startIndex, endIndex, style, tabId) {
    // Create style object and track which fields to update
    const paragraphStyle = {};
    const fieldsToUpdate = [];
    logger.debug(`Building paragraph style request for range ${startIndex}-${endIndex} with options:`, style);
    // Process alignment option (LEFT, CENTER, RIGHT, JUSTIFIED)
    if (style.alignment !== undefined) {
        paragraphStyle.alignment = style.alignment;
        fieldsToUpdate.push('alignment');
        logger.debug(`Setting alignment to ${style.alignment}`);
    }
    // Process indentation options
    if (style.indentStart !== undefined) {
        paragraphStyle.indentStart = { magnitude: style.indentStart, unit: 'PT' };
        fieldsToUpdate.push('indentStart');
        logger.debug(`Setting left indent to ${style.indentStart}pt`);
    }
    if (style.indentEnd !== undefined) {
        paragraphStyle.indentEnd = { magnitude: style.indentEnd, unit: 'PT' };
        fieldsToUpdate.push('indentEnd');
        logger.debug(`Setting right indent to ${style.indentEnd}pt`);
    }
    // Process spacing options
    if (style.spaceAbove !== undefined) {
        paragraphStyle.spaceAbove = { magnitude: style.spaceAbove, unit: 'PT' };
        fieldsToUpdate.push('spaceAbove');
        logger.debug(`Setting space above to ${style.spaceAbove}pt`);
    }
    if (style.spaceBelow !== undefined) {
        paragraphStyle.spaceBelow = { magnitude: style.spaceBelow, unit: 'PT' };
        fieldsToUpdate.push('spaceBelow');
        logger.debug(`Setting space below to ${style.spaceBelow}pt`);
    }
    // Process named style types (headings, etc.)
    if (style.namedStyleType !== undefined) {
        paragraphStyle.namedStyleType = style.namedStyleType;
        fieldsToUpdate.push('namedStyleType');
        logger.debug(`Setting named style to ${style.namedStyleType}`);
    }
    // Process page break control
    if (style.keepWithNext !== undefined) {
        paragraphStyle.keepWithNext = style.keepWithNext;
        fieldsToUpdate.push('keepWithNext');
        logger.debug(`Setting keepWithNext to ${style.keepWithNext}`);
    }
    // Verify we have styles to apply
    if (fieldsToUpdate.length === 0) {
        logger.warn('No paragraph styling options were provided');
        return null; // No styles to apply
    }
    // Build the range with optional tabId
    const range = { startIndex, endIndex };
    if (tabId) {
        range.tabId = tabId;
    }
    // Build the request object
    const request = {
        updateParagraphStyle: {
            range,
            paragraphStyle: paragraphStyle,
            fields: fieldsToUpdate.join(','),
        },
    };
    logger.debug(`Created paragraph style request with fields: ${fieldsToUpdate.join(', ')}`);
    return { request, fields: fieldsToUpdate };
}
// --- Specific Feature Helpers ---
export async function createTable(docs, documentId, rows, columns, index, tabId, writeControl) {
    if (rows < 1 || columns < 1) {
        throw publicError('Table must have at least 1 row and 1 column.');
    }
    const location = { index };
    if (tabId) {
        location.tabId = tabId;
    }
    const request = {
        insertTable: {
            location,
            rows: rows,
            columns: columns,
        },
    };
    return executeBatchUpdate(docs, documentId, [request], writeControl);
}
export async function insertText(docs, documentId, text, index) {
    if (!text)
        return {}; // Nothing to insert
    const request = {
        insertText: {
            location: { index },
            text: text,
        },
    };
    return executeBatchUpdate(docs, documentId, [request]);
}
// --- Table Cell Helper ---
/**
 * Finds the content range of a specific table cell.
 * Returns the start and end indices of the cell's text content (excluding trailing newline).
 */
export async function getTableCellRange(docs, documentId, tableStartIndex, rowIndex, columnIndex, tabId) {
    const res = await docs.documents.get({
        documentId,
        ...(tabId && { includeTabsContent: true }),
    });
    // Get body content from the correct tab or default
    let bodyContent;
    if (tabId) {
        const allTabs = getAllTabs(res.data);
        const tab = allTabs.find((t) => t.tabProperties?.tabId === tabId);
        if (!tab)
            throw publicError(`Tab with ID "${tabId}" not found.`);
        bodyContent = tab.documentTab?.body?.content;
    }
    else {
        bodyContent = res.data.body?.content;
    }
    if (!bodyContent) {
        throw publicError(`No content found in document ${documentId}.`);
    }
    // Find the table element matching tableStartIndex
    const tableElement = bodyContent.find((el) => el.table && el.startIndex === tableStartIndex);
    if (!tableElement || !tableElement.table) {
        throw publicError(`No table found at startIndex ${tableStartIndex}. Use readDocument with format='index' to find the correct table startIndex.`);
    }
    const table = tableElement.table;
    const rows = table.tableRows;
    if (!rows || rowIndex < 0 || rowIndex >= rows.length) {
        throw publicError(`Row index ${rowIndex} is out of range. Table has ${rows?.length ?? 0} rows (0-based).`);
    }
    const cells = rows[rowIndex].tableCells;
    if (!cells || columnIndex < 0 || columnIndex >= cells.length) {
        throw publicError(`Column index ${columnIndex} is out of range. Row ${rowIndex} has ${cells?.length ?? 0} columns (0-based).`);
    }
    const cell = cells[columnIndex];
    const cellContent = cell.content;
    if (!cellContent || cellContent.length === 0) {
        throw publicError(`Cell (${rowIndex}, ${columnIndex}) has no content elements.`);
    }
    // Cell always has at least one paragraph with a trailing \n.
    // We want the range covering all content *before* that final \n.
    const firstParagraph = cellContent[0];
    const lastParagraph = cellContent[cellContent.length - 1];
    const cellStartIndex = firstParagraph.startIndex;
    // The endIndex of the last paragraph includes the trailing \n.
    // We subtract 1 to exclude it so delete operations don't remove the cell structure.
    const cellEndIndex = lastParagraph.endIndex;
    if (cellStartIndex == null || cellEndIndex == null) {
        throw publicError(`Could not determine content range for cell (${rowIndex}, ${columnIndex}).`);
    }
    return { startIndex: cellStartIndex, endIndex: cellEndIndex - 1 };
}
// --- Complex / Stubbed Helpers ---
export async function findParagraphsMatchingStyle(docs, documentId, styleCriteria // Define a proper type for criteria (e.g., { fontFamily: 'Arial', bold: true })
) {
    // TODO: Implement logic
    // 1. Get document content with paragraph elements and their styles.
    // 2. Iterate through paragraphs.
    // 3. For each paragraph, check if its computed style matches the criteria.
    // 4. Return ranges of matching paragraphs.
    logger.warn('findParagraphsMatchingStyle is not implemented.');
    throw new NotImplementedError('Finding paragraphs by style criteria is not yet implemented.');
    // return [];
}
export async function detectAndFormatLists(docs, documentId, startIndex, endIndex) {
    // TODO: Implement complex logic
    // 1. Get document content (paragraphs, text runs) in the specified range (or whole doc).
    // 2. Iterate through paragraphs.
    // 3. Identify sequences of paragraphs starting with list-like markers (e.g., "-", "*", "1.", "a)").
    // 4. Determine nesting levels based on indentation or marker patterns.
    // 5. Generate CreateParagraphBulletsRequests for the identified sequences.
    // 6. Potentially delete the original marker text.
    // 7. Execute the batch update.
    logger.warn('detectAndFormatLists is not implemented.');
    throw new NotImplementedError('Automatic list detection and formatting is not yet implemented.');
    // return {};
}
export async function addCommentHelper(docs, documentId, text, startIndex, endIndex) {
    // NOTE: Adding comments typically requires the Google Drive API v3 and different scopes!
    // 'https://www.googleapis.com/auth/drive' or more specific comment scopes.
    // This helper is a placeholder assuming Drive API client (`drive`) is available and authorized.
    /*
  const drive = google.drive({version: 'v3', auth: authClient}); // Assuming authClient is available
  await drive.comments.create({
  fileId: documentId,
  requestBody: {
  content: text,
  anchor: JSON.stringify({ // Anchor format might need verification
  'type': 'workbook#textAnchor', // Or appropriate type for Docs
  'refs': [{
  'docRevisionId': 'head', // Or specific revision
  'range': {
  'start': startIndex,
  'end': endIndex,
  }
  }]
  })
  },
  fields: 'id'
  });
  */
    logger.warn('addCommentHelper requires Google Drive API and is not implemented.');
    throw new NotImplementedError('Adding comments requires Drive API setup and is not yet implemented.');
}
// --- Image Insertion Helpers ---
/**
 * Inserts an inline image into a document from a publicly accessible URL
 * @param docs - Google Docs API client
 * @param documentId - The document ID
 * @param imageUrl - Publicly accessible URL to the image
 * @param index - Position in the document where image should be inserted (1-based)
 * @param width - Optional width in points
 * @param height - Optional height in points
 * @returns Promise with batch update response
 */
export async function insertInlineImage(docs, documentId, imageUrl, index, width, height, tabId, writeControl) {
    // Validate URL format
    try {
        new URL(imageUrl);
    }
    catch (e) {
        throw publicError(`Invalid image URL format: ${imageUrl}`);
    }
    // Build the insertInlineImage request
    const location = { index };
    if (tabId) {
        location.tabId = tabId;
    }
    const request = {
        insertInlineImage: {
            location,
            uri: imageUrl,
            ...(width &&
                height && {
                objectSize: {
                    height: { magnitude: height, unit: 'PT' },
                    width: { magnitude: width, unit: 'PT' },
                },
            }),
        },
    };
    return executeBatchUpdate(docs, documentId, [request], writeControl);
}
/**
 * Uploads a local image file to Google Drive.
 *
 * When `skipPublicSharing` is false (default), the file is made publicly
 * readable and its webContentLink is returned — required for the Docs API
 * insertInlineImage approach.
 *
 * When `skipPublicSharing` is true, only the Drive file ID is returned.
 * Use this with the Apps Script insertion path where no public URL is needed.
 */
export async function uploadImageToDrive(drive, // drive_v3.Drive type
localFilePath, parentFolderId, skipPublicSharing = false) {
    const fs = await import('fs');
    const path = await import('path');
    if (!fs.existsSync(localFilePath)) {
        throw publicError(`Image file not found: ${localFilePath}`);
    }
    const fileName = path.basename(localFilePath);
    const mimeTypeMap = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
    };
    const ext = path.extname(localFilePath).toLowerCase();
    const mimeType = mimeTypeMap[ext] || 'application/octet-stream';
    const fileMetadata = {
        name: fileName,
        mimeType: mimeType,
    };
    if (parentFolderId) {
        fileMetadata.parents = [parentFolderId];
    }
    const media = {
        mimeType: mimeType,
        body: fs.createReadStream(localFilePath),
    };
    const uploadResponse = await drive.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: 'id,webViewLink,webContentLink',
        supportsAllDrives: true,
    });
    const fileId = uploadResponse.data.id;
    if (!fileId) {
        throw new Error('Failed to upload image to Drive - no file ID returned');
    }
    if (skipPublicSharing) {
        return fileId;
    }
    await drive.permissions.create({
        fileId: fileId,
        requestBody: {
            role: 'reader',
            type: 'anyone',
        },
        supportsAllDrives: true,
    });
    const fileInfo = await drive.files.get({
        fileId: fileId,
        fields: 'webContentLink',
        supportsAllDrives: true,
    });
    const webContentLink = fileInfo.data.webContentLink;
    if (!webContentLink) {
        throw new Error('Failed to get public URL for uploaded image');
    }
    return webContentLink;
}
/**
 * Inserts an image into a Google Doc via Apps Script.
 *
 * Flow:
 *   1. Insert a unique marker string at the target index using the Docs API.
 *   2. Call the deployed Apps Script which finds the marker and replaces it
 *      with the actual image blob from Drive (no public sharing needed).
 */
export async function insertImageViaAppsScript(docs, scriptClient, // script_v1.Script type
deploymentId, documentId, driveFileId, charIndex, tabId, writeControl) {
    const marker = `[mcp-img-${driveFileId}]`;
    // Step 1: Insert marker at the requested position via Docs API
    const location = { index: charIndex };
    if (tabId) {
        location.tabId = tabId;
    }
    await executeBatchUpdate(docs, documentId, [{ insertText: { location, text: marker } }], writeControl);
    // Step 2: Call Apps Script to replace the marker with the image
    const response = await scriptClient.scripts.run({
        scriptId: deploymentId,
        requestBody: {
            function: 'insertImageByFileId',
            parameters: [documentId, driveFileId],
        },
    });
    const result = response.data?.response?.result;
    if (!result || !result.success) {
        const msg = result?.message || 'Unknown Apps Script error';
        throw new Error(`Apps Script image insertion failed: ${msg}`);
    }
}
/**
 * Recursively collect all tabs from a document in a flat list with hierarchy info
 * @param doc - The Google Doc document object
 * @returns Array of tabs with nesting level information
 */
export function getAllTabs(doc) {
    const allTabs = [];
    if (!doc.tabs || doc.tabs.length === 0) {
        return allTabs;
    }
    for (const tab of doc.tabs) {
        addCurrentAndChildTabs(tab, allTabs, 0);
    }
    return allTabs;
}
/**
 * Recursive helper to add tabs with their nesting level
 * @param tab - The tab to add
 * @param allTabs - The accumulator array
 * @param level - Current nesting level (0 for top-level)
 */
function addCurrentAndChildTabs(tab, allTabs, level) {
    allTabs.push({ ...tab, level });
    if (tab.childTabs && tab.childTabs.length > 0) {
        for (const childTab of tab.childTabs) {
            addCurrentAndChildTabs(childTab, allTabs, level + 1);
        }
    }
}
/**
 * Get the text length from a DocumentTab
 * @param documentTab - The DocumentTab object
 * @returns Total character count
 */
export function getTabTextLength(documentTab) {
    let totalLength = 0;
    if (!documentTab?.body?.content) {
        return 0;
    }
    documentTab.body.content.forEach((element) => {
        // Handle paragraphs
        if (element.paragraph?.elements) {
            element.paragraph.elements.forEach((pe) => {
                if (pe.textRun?.content) {
                    totalLength += pe.textRun.content.length;
                }
            });
        }
        // Handle tables
        if (element.table?.tableRows) {
            element.table.tableRows.forEach((row) => {
                row.tableCells?.forEach((cell) => {
                    cell.content?.forEach((cellElement) => {
                        cellElement.paragraph?.elements?.forEach((pe) => {
                            if (pe.textRun?.content) {
                                totalLength += pe.textRun.content.length;
                            }
                        });
                    });
                });
            });
        }
    });
    return totalLength;
}
/**
 * Find a specific tab by ID in a document (searches recursively through child tabs)
 * @param doc - The Google Doc document object
 * @param tabId - The tab ID to search for
 * @returns The tab object if found, null otherwise
 */
export function findTabById(doc, tabId) {
    if (!doc.tabs || doc.tabs.length === 0) {
        return null;
    }
    // Helper function to search through tabs recursively
    const searchTabs = (tabs) => {
        for (const tab of tabs) {
            if (tab.tabProperties?.tabId === tabId) {
                return tab;
            }
            // Recursively search child tabs
            if (tab.childTabs && tab.childTabs.length > 0) {
                const found = searchTabs(tab.childTabs);
                if (found)
                    return found;
            }
        }
        return null;
    };
    return searchTabs(doc.tabs);
}
