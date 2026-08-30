// Lightweight heading structure API (issue #98, consolidated into #88).
//
// Why this exists next to readDocument(format='index'): the index answers "what
// is at which character index" for EVERY element — paragraphs, list items,
// tables with per-cell addresses — and its payload therefore scales with the
// document, not with its outline. The two questions callers actually ask about
// headings ("what sections exist?" and "which headingId does this link point
// at?") only need the outline, and asking them should cost a payload
// proportional to the number of headings.
//
// It shares docsIndex.js's `collectHeadings`, which the post-write heading map
// and the pre-write heading-link collateral scan also use, so the three can
// never disagree about what counts as a heading or what level it is.
//
// This is a structure read, not a content read: it deliberately does NOT track
// a read or mint a readHandle, because it never sees the document's text and so
// could not authorize an edit against content the caller has not seen.
import { z } from 'zod';
import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { getDocsClient } from '../../clients.js';
import { DocumentIdParameter } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import { HEADING_BODY_FIELDS, HEADING_TABS_FIELDS, collectHeadings } from '../../docsIndex.js';

/** Chars of heading text carried per entry, so one pathological heading cannot dominate. */
const MAX_HEADING_TEXT_CHARS = 300;

const ListHeadingsParameters = DocumentIdParameter.extend({
    tabId: z
        .string()
        .optional()
        .describe('The ID of the specific tab to list headings for. If not specified, lists the document body (the first tab on a tabbed document).'),
    maxResults: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .default(500)
        .describe('Maximum number of headings to return (default 500). Exceeding it truncates in document order and says so.'),
});

export function register(server) {
    server.addTool({
        name: 'listHeadings',
        description: 'Lists a document\'s headings — text, headingId, level, and start index — using a narrow field mask, so the response is proportional to the number of headings rather than to the size of the document. ' +
            'Use this to see a document\'s outline, to pick a section to edit (the start index feeds modifyText, deleteRange, and replaceRangeWithMarkdown; the headingId feeds replaceRangeWithMarkdown\'s headingId target), and to look up the heading ids that in-document links point at. ' +
            'TITLE counts as level 1 and SUBTITLE as level 2, matching the markdown export. ' +
            'headingId is null when Google Docs has not assigned one yet — it only assigns an id once a heading has been used as a link target — and this tool never invents one, because a made-up id would not resolve. ' +
            'Headings inside table cells are excluded: they are not part of the document outline. ' +
            "For full element-level addressing (list items, tables, per-cell indices) use readDocument with format='index'; for the document text use format='markdown'. " +
            'This is a structure read only: it does not return document content and does not authorize a subsequent edit — call readDocument for that.',
        parameters: ListHeadingsParameters,
        execute: async (args, { log }) => {
            const tabId = args.tabId ?? null;
            const maxResults = args.maxResults ?? 500;
            try {
                const docs = await getDocsClient();
                const response = await docs.documents.get({
                    documentId: args.documentId,
                    includeTabsContent: !!tabId,
                    fields: tabId ? HEADING_TABS_FIELDS : HEADING_BODY_FIELDS,
                });
                let contentSource = response.data;
                if (tabId) {
                    const tab = GDocsHelpers.findTabById(response.data, tabId);
                    if (!tab) throw publicError(`Tab with ID "${tabId}" not found in document.`);
                    if (!tab.documentTab) {
                        throw publicError(`Tab "${tabId}" does not have content (may not be a document tab).`);
                    }
                    contentSource = { body: tab.documentTab.body };
                }

                const all = collectHeadings(contentSource, { tabId });
                const truncated = all.length > maxResults;
                const headings = (truncated ? all.slice(0, maxResults) : all).map((heading) => ({
                    text: heading.text.length > MAX_HEADING_TEXT_CHARS
                        ? `${heading.text.slice(0, MAX_HEADING_TEXT_CHARS)}…`
                        : heading.text,
                    headingId: heading.headingId,
                    level: heading.level,
                    namedStyleType: heading.namedStyleType,
                    startIndex: heading.startIndex,
                    endIndex: heading.endIndex,
                }));

                log.info(`listHeadings on doc ${args.documentId}${tabId ? ` (tab ${tabId})` : ''}: ${all.length} heading(s)`);

                const payload = {
                    documentId: args.documentId,
                    tabId,
                    revisionId: response.data?.revisionId ?? null,
                    headingCount: all.length,
                    returnedCount: headings.length,
                    truncated,
                    headings,
                };
                if (all.length === 0) {
                    // An empty outline and an empty document are different
                    // answers, and a bare `[]` conflates them.
                    payload.note = 'This document has no headings. Its body may be empty, or its paragraphs may all be ' +
                        "NORMAL_TEXT (nothing is styled as Title, Subtitle, or Heading 1-6). Use readDocument with format='index' " +
                        'to see the elements that are there.';
                }
                if (truncated) {
                    payload.note = `Only the first ${maxResults} of ${all.length} headings are shown. Raise maxResults to see the rest.`;
                }
                return JSON.stringify(payload, null, 2);
            }
            catch (error) {
                if (isPublicError(error)) throw error;
                log.error(`Error listing headings for doc ${args.documentId}: ${error.message || error}`);
                if (error?.code === 404) throw publicError(`Document not found (ID: ${args.documentId}). Check the ID.`);
                if (error?.code === 403) throw publicError(`Permission denied for document (ID: ${args.documentId}).`);
                throw wrapOperationError('list document headings', error, { status: error?.code });
            }
        },
    });
}
