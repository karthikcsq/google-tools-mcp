// Internal structural walker for Google Docs API document JSON.
//
// This is the migration's "structural prerequisite" (see
// docs/plans/mcp-2026-07-28-migration.md, section 7): a small, dependency-free
// traversal over a Docs API `Document` that yields stable internal node
// descriptors. It has no public MCP tool or tool parameter of its own. Issue
// #105 is expected to build its public indexed/limited read behavior on top
// of `walkDocument` later; until then this module is exercised only by unit
// tests and (optionally) other internal modules.
//
// Document shape notes (verified against dist/docsToMarkdown.js,
// dist/tools/docs/readGoogleDoc.js, dist/tools/docs/listDocumentTabs.js, and
// dist/googleDocsApiHelpers.js — re-verify against a live `documents.get`
// response before relying on this in production code):
//
//   * A tabbed document has `document.tabs: Tab[]`. Each `Tab` carries
//     `tabProperties` (`tabId`, `title`, `index`, `parentTabId`),
//     `documentTab` (the actual `{ body, lists, ... }` for that tab, present
//     only when the tab is a document tab), and `childTabs: Tab[]` for
//     nested tabs (see googleDocsApiHelpers.getAllTabs/findTabById).
//   * A legacy (pre-tabs) or `includeTabsContent`-omitted document instead
//     has a top-level `document.body: { content: StructuralElement[] }`
//     directly, with no `tabs` array at all.
//   * `StructuralElement` (items of `body.content` and `tableCell.content`)
//     carries `startIndex`/`endIndex` and exactly one of `paragraph`,
//     `table`, `sectionBreak`, or `tableOfContents`.
//   * `paragraph.elements: ParagraphElement[]`; each carries its own
//     `startIndex`/`endIndex` and exactly one of `textRun` (the common case)
//     or another inline kind (`inlineObjectElement`, `pageBreak`,
//     `footnoteReference`, `horizontalRule`, `columnBreak`, `autoText`,
//     `richLink`, `person`, ...).
//   * `table.tableRows: TableRow[]`; `TableRow` has no `startIndex`/
//     `endIndex` of its own. `tableRow.tableCells: TableCell[]`; `TableCell`
//     *does* carry `startIndex`/`endIndex` plus its own `content:
//     StructuralElement[]`, recursing exactly like `body.content`.
//   * `tableOfContents.content: StructuralElement[]` recurses the same way.
//   * `sectionBreak` has no nested content.

/** Stable, exhaustive set of `kind` values this walker ever yields. */
export const NODE_KINDS = Object.freeze({
    TAB: 'tab',
    PARAGRAPH: 'paragraph',
    TEXT_RUN: 'textRun',
    PARAGRAPH_ELEMENT: 'paragraphElement',
    TABLE: 'table',
    TABLE_ROW: 'tableRow',
    TABLE_CELL: 'tableCell',
    SECTION_BREAK: 'sectionBreak',
    TABLE_OF_CONTENTS: 'tableOfContents',
});

// Inline paragraph-element kinds other than the common textRun case. Keys
// mirror the ParagraphElement field names in the Docs API.
const INLINE_ELEMENT_FIELDS = [
    'inlineObjectElement',
    'pageBreak',
    'footnoteReference',
    'horizontalRule',
    'columnBreak',
    'autoText',
    'richLink',
    'person',
    'equation',
];

function makeNode(kind, { startIndex, endIndex, tabId, depth, node, ...extra }) {
    return {
        kind,
        startIndex: startIndex ?? undefined,
        endIndex: endIndex ?? undefined,
        tabId: tabId ?? null,
        depth,
        node,
        ...extra,
    };
}

function* walkParagraph(paragraph, element, tabId, depth) {
    yield makeNode(NODE_KINDS.PARAGRAPH, {
        startIndex: element?.startIndex,
        endIndex: element?.endIndex,
        tabId,
        depth,
        node: element,
    });
    const elements = paragraph?.elements;
    if (!Array.isArray(elements)) return;
    for (const paragraphElement of elements) {
        if (paragraphElement?.textRun !== undefined) {
            yield makeNode(NODE_KINDS.TEXT_RUN, {
                startIndex: paragraphElement.startIndex,
                endIndex: paragraphElement.endIndex,
                tabId,
                depth: depth + 1,
                node: paragraphElement.textRun,
            });
            continue;
        }
        const inlineField = INLINE_ELEMENT_FIELDS.find((field) => paragraphElement?.[field] !== undefined);
        yield makeNode(NODE_KINDS.PARAGRAPH_ELEMENT, {
            startIndex: paragraphElement?.startIndex,
            endIndex: paragraphElement?.endIndex,
            tabId,
            depth: depth + 1,
            node: paragraphElement,
            elementType: inlineField ?? 'unknown',
        });
    }
}

function* walkTableCell(cell, rowIndex, columnIndex, tabId, depth) {
    yield makeNode(NODE_KINDS.TABLE_CELL, {
        startIndex: cell?.startIndex,
        endIndex: cell?.endIndex,
        tabId,
        depth,
        node: cell,
        rowIndex,
        columnIndex,
    });
    if (Array.isArray(cell?.content)) {
        yield* walkStructuralElements(cell.content, tabId, depth + 1);
    }
}

function* walkTable(table, element, tabId, depth) {
    yield makeNode(NODE_KINDS.TABLE, {
        startIndex: element?.startIndex,
        endIndex: element?.endIndex,
        tabId,
        depth,
        node: element,
    });
    const rows = table?.tableRows;
    if (!Array.isArray(rows)) return;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        yield makeNode(NODE_KINDS.TABLE_ROW, {
            startIndex: undefined,
            endIndex: undefined,
            tabId,
            depth: depth + 1,
            node: row,
            rowIndex,
        });
        const cells = row?.tableCells;
        if (!Array.isArray(cells)) continue;
        for (let columnIndex = 0; columnIndex < cells.length; columnIndex += 1) {
            yield* walkTableCell(cells[columnIndex], rowIndex, columnIndex, tabId, depth + 2);
        }
    }
}

function* walkTableOfContents(toc, element, tabId, depth) {
    yield makeNode(NODE_KINDS.TABLE_OF_CONTENTS, {
        startIndex: element?.startIndex,
        endIndex: element?.endIndex,
        tabId,
        depth,
        node: element,
    });
    if (Array.isArray(toc?.content)) {
        yield* walkStructuralElements(toc.content, tabId, depth + 1);
    }
}

function* walkSectionBreak(element, tabId, depth) {
    yield makeNode(NODE_KINDS.SECTION_BREAK, {
        startIndex: element?.startIndex,
        endIndex: element?.endIndex,
        tabId,
        depth,
        node: element,
    });
}

/** Walk a `StructuralElement[]` array (a `body.content` or `tableCell.content`). */
function* walkStructuralElements(content, tabId, depth) {
    if (!Array.isArray(content)) return;
    for (const element of content) {
        if (!element || typeof element !== 'object') continue;
        if (element.paragraph !== undefined) {
            yield* walkParagraph(element.paragraph, element, tabId, depth);
        } else if (element.table !== undefined) {
            yield* walkTable(element.table, element, tabId, depth);
        } else if (element.sectionBreak !== undefined) {
            yield* walkSectionBreak(element, tabId, depth);
        } else if (element.tableOfContents !== undefined) {
            yield* walkTableOfContents(element.tableOfContents, element, tabId, depth);
        }
        // Structural elements this walker does not (yet) know about — e.g. a
        // future Docs API addition — are silently skipped rather than thrown
        // on, so an unrecognized element never crashes a caller that only
        // wants the shapes it recognizes.
    }
}

/** Walk a document body-like object (`{ content: [...] }`), scoped to a tab (or null for legacy). */
function* walkBody(body, tabId, depth) {
    if (!body?.content) return;
    yield* walkStructuralElements(body.content, tabId, depth);
}

function* walkTabs(tabs, level, options) {
    if (!Array.isArray(tabs)) return;
    for (const tab of tabs) {
        const tabId = tab?.tabProperties?.tabId ?? null;
        const matchesFilter = options.tabId == null || tabId === options.tabId;
        if (matchesFilter) {
            if (options.includeTabNodes) {
                yield makeNode(NODE_KINDS.TAB, {
                    startIndex: undefined,
                    endIndex: undefined,
                    tabId,
                    depth: level,
                    node: tab,
                });
            }
            if (tab?.documentTab?.body) {
                yield* walkBody(tab.documentTab.body, tabId, 0);
            }
        }
        if (Array.isArray(tab?.childTabs) && tab.childTabs.length > 0) {
            // A tabId filter still recurses into every subtree, because the
            // matching tab might be a descendant; only yields are gated above.
            yield* walkTabs(tab.childTabs, level + 1, options);
        }
    }
}

/**
 * Traverse a Google Docs API `Document` (or a bare `{ body }`/`{ tabs }`
 * fragment) and yield stable internal node descriptors in document order.
 *
 * Each yielded node is:
 *   {
 *     kind: one of NODE_KINDS,
 *     startIndex: number | undefined,   // present when the Docs API element carries one
 *     endIndex: number | undefined,
 *     tabId: string | null,             // enclosing tab, or null for a legacy body-only document
 *     depth: number,                    // structural nesting depth (0-based)
 *     node: <raw Docs API object>,      // the exact element/paragraph/table/etc. reference
 *     ...kind-specific extras (rowIndex/columnIndex for cells, elementType for
 *        non-textRun paragraph elements)
 *   }
 *
 * Handles both a tabbed document (`document.tabs`, including nested
 * `childTabs`) and a legacy body-only document (`document.body`) with no
 * `tabs` array at all.
 *
 * @param {object} document - A Docs API `Document`, or a fragment carrying
 *   `tabs` and/or `body` (e.g. a single `DocumentTab`'s `{ body }`).
 * @param {object} [options]
 * @param {string} [options.tabId] - If set, only yield nodes belonging to the
 *   tab with this id (its own content only, not sibling/uncle tabs); other
 *   tabs' subtrees are still walked internally so a matching descendant tab
 *   is still found, but nothing outside the match is yielded.
 * @param {boolean} [options.includeTabNodes=true] - Whether to yield the
 *   synthetic `'tab'` node for each tab itself, in addition to its content.
 * @returns {Generator<object>}
 */
export function* walkDocument(document, options = {}) {
    const resolvedOptions = {
        tabId: options.tabId ?? null,
        includeTabNodes: options.includeTabNodes ?? true,
    };
    const tabs = document?.tabs;
    if (Array.isArray(tabs) && tabs.length > 0) {
        yield* walkTabs(tabs, 0, resolvedOptions);
        return;
    }
    // Legacy / tabs-omitted shape: a bare document body with no tab context.
    if (resolvedOptions.tabId != null) return; // A tab filter can never match a body-only document.
    if (document?.body) {
        yield* walkBody(document.body, null, 0);
    }
}

/**
 * Convenience helper built on `walkDocument`: concatenate every `textRun`'s
 * text content in document order. A thin, dependency-free stand-in for the
 * text-extraction loops duplicated across dist/tools/docs/readGoogleDoc.js,
 * dist/googleDocsApiHelpers.js, and dist/googleDocsApiHelpers.js's
 * getTabTextLength — kept separate from those call sites deliberately, since
 * this module changes no existing behavior.
 *
 * @param {object} document
 * @param {object} [options] - Forwarded to walkDocument (e.g. `tabId`).
 * @returns {string}
 */
export function collectText(document, options = {}) {
    let text = '';
    for (const entry of walkDocument(document, options)) {
        if (entry.kind === NODE_KINDS.TEXT_RUN && typeof entry.node?.content === 'string') {
            text += entry.node.content;
        }
    }
    return text;
}
