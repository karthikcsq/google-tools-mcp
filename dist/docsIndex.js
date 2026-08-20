// Public structural index for Google Docs (issue #105).
//
// `readDocument(format:'index')` needs an affordable answer to "what is in this
// document and at which character indices", so that every index-addressed tool
// (modifyText, deleteRange, insertTable, insertPageBreak, ...) has a read mode
// that actually completes. Before this, the only documented answer was
// `format:'json'`, which fetches `fields:'*'` and stringifies the entire raw
// Docs API response — 1.36 MB for 9.6 KB of text.
//
// This module is the *semantic* layer. It does not traverse the document
// itself: `dist/docsStructure.js`'s `walkDocument` is the single traversal in
// this codebase (it also backs the read-handle structural fingerprint in
// dist/handleRuntime.js), and forking a second one would let the two drift.
// walkDocument yields structural kinds (paragraph / textRun / table /
// tableCell / ...); everything below is the thin classification on top that
// turns those into caller-facing types (heading vs listItem vs paragraph,
// heading level, list nesting and orderedness, table cell addresses).
//
// Contract notes for callers:
//   * `start`/`end` are the raw Docs API `startIndex`/`endIndex`, unchanged, so
//     an entry's range can be handed straight to deleteRange/modifyText. `end`
//     is exclusive, matching the mutating tools.
//   * Top-level element ranges never overlap. The one nesting is table cells,
//     which live in their table entry's `cells` array with their own indices,
//     because cell content is separately addressable.
//   * On a tabbed read the indices are tab-local, exactly as the Docs API
//     reports them.

import { NODE_KINDS, walkDocument } from './docsStructure.js';

/** Longest preview text carried per element/cell. */
const PREVIEW_MAX_CHARS = 80;

/** Default cap on the serialized index payload. Mirrors helpers.js's budget. */
export const DEFAULT_INDEX_MAX_RESPONSE_CHARS = 100000;

// The body subtree both masks share. Everything the classifier reads and
// nothing else: no textStyle, no paragraphStyle beyond namedStyleType, no
// suggested* maps, no namedStyles, no inlineObjects/positionedObjects blobs.
const INDEX_BODY_SUBTREE =
    'content(startIndex,endIndex,' +
    'paragraph(paragraphStyle(namedStyleType),bullet(listId,nestingLevel),' +
    'elements(startIndex,endIndex,textRun(content),inlineObjectElement(inlineObjectId),horizontalRule,pageBreak)),' +
    'table(rows,columns,tableRows(startIndex,endIndex,' +
    'tableCells(startIndex,endIndex,content(startIndex,endIndex,paragraph(elements(startIndex,endIndex,textRun(content))))))),' +
    'sectionBreak,tableOfContents)';

const LISTS_SUBTREE = 'lists(listProperties(nestingLevels(glyphType)))';

/** Field mask for a legacy / body-only index read (`includeTabsContent:false`). */
export const INDEX_BODY_FIELDS = `revisionId,body(${INDEX_BODY_SUBTREE}),${LISTS_SUBTREE}`;

/**
 * Field mask for a tabbed index read (`includeTabsContent:true`).
 *
 * Deliberately NOT `'*'`: readGoogleDoc forces `fields:'*'` whenever tabs are
 * requested, which would silently defeat the whole affordability claim for
 * tabbed documents.
 */
export const INDEX_TABS_FIELDS =
    `revisionId,tabs(tabProperties(tabId),documentTab(body(${INDEX_BODY_SUBTREE}),${LISTS_SUBTREE}))`;

// --- classification helpers -------------------------------------------------

/** Mirrors markdown-transformer/docsToMarkdown.js getHeadingLevel. */
function headingLevelOf(paragraph) {
    const styleType = paragraph?.paragraphStyle?.namedStyleType;
    if (!styleType) return null;
    if (styleType === 'TITLE') return 1;
    if (styleType === 'SUBTITLE') return 2;
    const match = /^HEADING_(\d)$/.exec(styleType);
    return match ? parseInt(match[1], 10) : null;
}

/**
 * A list is "ordered" when its glyph for this nesting level is a glyph *type*
 * (DECIMAL/ALPHA/ROMAN) rather than a glyph symbol. Same rule
 * docsToMarkdown.js getListInfo uses, so the index and the markdown export can
 * never disagree about what is a numbered list.
 */
function isOrderedList(lists, listId, nestingLevel) {
    const level = lists?.[listId]?.listProperties?.nestingLevels?.[nestingLevel];
    return !!(level?.glyphType && level.glyphType !== 'GLYPH_TYPE_UNSPECIFIED');
}

/**
 * Build tabId -> lists map. A legacy body-only document (or a single tab's
 * `{ body, lists }` fragment, which is what readGoogleDoc hands us on a
 * tab-scoped read) keys its lists under `null`, matching the walker's `tabId`
 * for that shape.
 */
function collectLists(document) {
    const byTab = new Map();
    byTab.set(null, document?.lists ?? {});
    const visit = (tabs) => {
        if (!Array.isArray(tabs)) return;
        for (const tab of tabs) {
            const tabId = tab?.tabProperties?.tabId ?? null;
            byTab.set(tabId, tab?.documentTab?.lists ?? {});
            visit(tab?.childTabs);
        }
    };
    visit(document?.tabs);
    return byTab;
}

function makePreview(text) {
    const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (collapsed.length <= PREVIEW_MAX_CHARS) return collapsed;
    return `${collapsed.slice(0, PREVIEW_MAX_CHARS)}…`;
}

const INLINE_TYPE_BY_FIELD = {
    horizontalRule: 'horizontalRule',
    pageBreak: 'pageBreak',
    inlineObjectElement: 'inlineObject',
    footnoteReference: 'footnoteReference',
    columnBreak: 'columnBreak',
    equation: 'equation',
    richLink: 'richLink',
    person: 'person',
    autoText: 'autoText',
};

// --- the walk ---------------------------------------------------------------

/**
 * Collect every top-level structural element (and, nested inside table
 * entries, every table cell) in document order.
 *
 * Single pass over `walkDocument`. Depth is what disambiguates nesting: the
 * walker emits body-level elements at depth 0, a table's rows at depth 1 and
 * its cells at depth 2, and recurses into cell content from there. So a cell
 * belongs to the table currently open exactly when its depth is that table's
 * depth + 2; a cell any deeper belongs to a nested table, whose text still
 * flows into the enclosing cell's preview but which gets no `cells` array of
 * its own (nested tables are rare and their cells are reachable by re-reading
 * scoped to the outer cell's range).
 */
function collectElements(document, { tabId = null } = {}) {
    const listsByTab = collectLists(document);
    const elements = [];
    let openTable = null;     // { entry, depth }
    let textTarget = null;    // entry accumulating textRun content
    let documentEnd = 0;

    const noteEnd = (end) => {
        if (typeof end === 'number' && end > documentEnd) documentEnd = end;
    };

    // The walker's `tabId` option is a *filter* over `document.tabs`, and it
    // matches nothing on a body-only shape. readGoogleDoc already narrows
    // `contentSource` to the requested tab's `{ body, lists }`, so the filter
    // is only meaningful when a real `tabs` array is present; otherwise `tabId`
    // here is purely a label for the entries.
    const hasTabs = Array.isArray(document?.tabs) && document.tabs.length > 0;
    const walkOptions = { includeTabNodes: false };
    if (hasTabs && tabId) walkOptions.tabId = tabId;

    for (const node of walkDocument(document, walkOptions)) {
        const nodeTabId = node.tabId ?? tabId ?? null;
        switch (node.kind) {
            case NODE_KINDS.PARAGRAPH: {
                if (node.depth !== 0) break; // nested paragraph: text only, keep the open target
                openTable = null;
                const paragraph = node.node?.paragraph;
                const entry = {
                    start: node.startIndex,
                    end: node.endIndex,
                    tabId: nodeTabId,
                    type: 'paragraph',
                    level: null,
                    ordered: null,
                    nesting: null,
                    _text: '',
                    _inline: [],
                };
                const bullet = paragraph?.bullet;
                const heading = headingLevelOf(paragraph);
                if (bullet) {
                    entry.type = 'listItem';
                    entry.nesting = bullet.nestingLevel ?? 0;
                    entry.ordered = isOrderedList(listsByTab.get(nodeTabId) ?? {}, bullet.listId, entry.nesting);
                } else if (heading !== null) {
                    entry.type = 'heading';
                    entry.level = heading;
                }
                elements.push(entry);
                noteEnd(entry.end);
                textTarget = entry;
                break;
            }
            case NODE_KINDS.TEXT_RUN: {
                if (textTarget) textTarget._text += node.node?.content ?? '';
                break;
            }
            case NODE_KINDS.PARAGRAPH_ELEMENT: {
                if (!textTarget || !Array.isArray(textTarget._inline)) break;
                textTarget._inline.push({
                    type: INLINE_TYPE_BY_FIELD[node.elementType] ?? node.elementType ?? 'unknown',
                    start: node.startIndex,
                    end: node.endIndex,
                    objectId: node.node?.inlineObjectElement?.inlineObjectId ?? null,
                });
                break;
            }
            case NODE_KINDS.TABLE: {
                const table = node.node?.table;
                if (node.depth !== 0) {
                    // Nested table: no entry of its own, and its cells must not
                    // be attached to the enclosing table.
                    break;
                }
                const entry = {
                    start: node.startIndex,
                    end: node.endIndex,
                    tabId: nodeTabId,
                    type: 'table',
                    rows: table?.rows ?? table?.tableRows?.length ?? 0,
                    columns: table?.columns ?? table?.tableRows?.[0]?.tableCells?.length ?? 0,
                    cells: [],
                };
                elements.push(entry);
                noteEnd(entry.end);
                openTable = { entry, depth: node.depth };
                textTarget = null;
                break;
            }
            case NODE_KINDS.TABLE_CELL: {
                if (!openTable || node.depth !== openTable.depth + 2) {
                    // A nested table's cell. Keep the enclosing cell as the text
                    // target so its preview still reflects the nested content.
                    break;
                }
                const cell = {
                    start: node.startIndex,
                    end: node.endIndex,
                    row: node.rowIndex,
                    col: node.columnIndex,
                    _text: '',
                };
                openTable.entry.cells.push(cell);
                textTarget = cell;
                break;
            }
            case NODE_KINDS.SECTION_BREAK:
            case NODE_KINDS.TABLE_OF_CONTENTS: {
                if (node.depth !== 0) break;
                openTable = null;
                const entry = {
                    start: node.startIndex,
                    end: node.endIndex,
                    tabId: nodeTabId,
                    type: node.kind === NODE_KINDS.SECTION_BREAK ? 'sectionBreak' : 'tableOfContents',
                    _text: '',
                };
                elements.push(entry);
                noteEnd(entry.end);
                textTarget = entry;
                break;
            }
            default:
                break;
        }
    }
    return { elements, documentEnd };
}

/**
 * Turn the accumulated entry into the shape actually serialized: drop the
 * private accumulators, add `preview`, and let a paragraph whose entire
 * content is one non-text element (a horizontal rule, a page break, an anchored
 * image) report that as its type. Most specific type wins, and a paragraph is
 * still exactly one of heading | listItem | paragraph | horizontalRule |
 * pageBreak | inlineObject — never two.
 */
function finalizeEntry(entry) {
    const { _text, _inline, ...rest } = entry;
    const preview = makePreview(_text);
    const out = { ...rest };

    if (Array.isArray(_inline) && _inline.length > 0) {
        const solitary = _inline.length === 1 && preview === '' ? _inline[0] : null;
        if (solitary && out.type === 'paragraph') {
            out.type = solitary.type;
            if (solitary.objectId) out.objectId = solitary.objectId;
        } else {
            out.inline = _inline.map(({ type, start, end, objectId }) =>
                (objectId ? { type, start, end, objectId } : { type, start, end }));
        }
    }
    if (out.level === null) delete out.level;
    if (out.ordered === null) delete out.ordered;
    if (Array.isArray(out.cells)) {
        out.cells = out.cells.map(({ _text: cellText, ...cellRest }) => ({
            ...cellRest,
            preview: makePreview(cellText),
        }));
    } else {
        out.preview = preview;
    }
    return out;
}

/**
 * Fit `entries` into `maxChars` by dropping whole elements off the end, so the
 * payload is valid JSON at every step and truncation always lands on an
 * element boundary. Binary search rather than a shrink loop: each probe costs
 * a full `JSON.stringify` of the candidate payload, and measuring the real
 * payload (metadata included) is the only honest way to respect the budget.
 */
function fitToBudget(entries, maxChars, indent, build) {
    const size = (value) => JSON.stringify(value, null, indent).length;
    const full = build(entries, false);
    if (!maxChars || maxChars <= 0) return full;
    if (size(full) <= maxChars) return full;
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (size(build(entries.slice(0, mid), true)) <= maxChars) lo = mid;
        else hi = mid - 1;
    }
    // A single element can be larger than the whole budget — a wide table
    // carries one cell entry per cell. Returning zero elements would be
    // correct about the budget and useless to a paginating caller: every
    // subsequent page would ask for the same element and get nothing back, so
    // the walk never terminates. Emit that one element, overshooting the
    // budget deliberately and saying so, because forward progress is the
    // property callers actually depend on.
    if (lo === 0 && entries.length > 0) return build(entries.slice(0, 1), true, true);
    return build(entries.slice(0, lo), true);
}

/**
 * Build the `format:'index'` payload.
 *
 * @param {object} document Docs API document, or the `{ body, lists }`
 *   fragment readGoogleDoc builds for a tab-scoped read.
 * @param {object} [options]
 * @param {string|null} [options.tabId] Tab this read is scoped to (labels
 *   entries and, for a whole-document tabbed response, filters the walk).
 * @param {string|null} [options.documentId]
 * @param {string|null} [options.revisionId]
 * @param {number} [options.fromIndex=0] Drop elements ending at or before this
 *   document index. Pagination resume point.
 * @param {number} [options.maxResponseChars] Budget measured against the
 *   payload as it will actually be serialized, `indent` included.
 * @param {number} [options.indent=2] `JSON.stringify` indent the caller will
 *   use. Passed in so the budget is measured against the real bytes returned.
 * @returns {object} JSON-serializable payload.
 */
export function buildDocumentIndex(document, {
    tabId = null,
    documentId = null,
    revisionId = null,
    fromIndex = 0,
    maxResponseChars = DEFAULT_INDEX_MAX_RESPONSE_CHARS,
    indent = 2,
} = {}) {
    const { elements: raw, documentEnd } = collectElements(document, { tabId });
    const start = Number.isFinite(fromIndex) && fromIndex > 0 ? fromIndex : 0;
    // Gap-free by construction: slicing happens on a single consistent snapshot
    // and drops only elements wholly behind the cursor.
    const sliced = raw.filter((entry) => !(typeof entry.end === 'number' && entry.end <= start));
    const finalized = sliced.map(finalizeEntry);

    const build = (entries, truncated, budgetExceeded = false) => {
        const payload = {
            format: 'index',
            documentId,
            revisionId: revisionId ?? null,
            tabId,
            documentEnd,
            fromIndex: start,
            totalElementCount: raw.length,
            elementCount: entries.length,
            truncated,
            elements: entries,
        };
        if (truncated) {
            const last = entries[entries.length - 1];
            if (budgetExceeded) payload.budgetExceeded = true;
            if (last && typeof last.end === 'number') {
                payload.nextFromIndex = last.end;
                payload.note =
                    (budgetExceeded
                        ? 'This single element is larger than maxResponseChars, so it was returned anyway (the ' +
                          'budget is overshot) rather than stalling pagination. Raise maxResponseChars to avoid it. '
                        : '') +
                    'Truncated at an element boundary. Call readDocument again with the same arguments plus ' +
                    `fromIndex=${last.end} for the next page. The Docs API has no start-index cursor, so each ` +
                    'page costs one more (narrow-mask) fetch; there is no free resumption.';
            } else {
                payload.note =
                    'The remaining elements carry no end index, so no resume point can be offered. Raise ' +
                    'maxResponseChars (or set it to 0) to get the whole index in one response.';
            }
        }
        return payload;
    };

    return fitToBudget(finalized, maxResponseChars, indent, build);
}

/**
 * `buildDocumentIndex` plus the exact serialization the tool returns. Kept
 * together so the budget is always measured against the bytes actually sent.
 *
 * @returns {{payload: object, text: string}}
 */
export function serializeDocumentIndex(document, options = {}) {
    const indent = options.indent ?? 2;
    const payload = buildDocumentIndex(document, { ...options, indent });
    return { payload, text: JSON.stringify(payload, null, indent) };
}
