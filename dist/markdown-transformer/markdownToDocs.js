import MarkdownIt from 'markdown-it';
import { buildUpdateTextStyleRequest, buildUpdateParagraphStyleRequest, } from '../googleDocsApiHelpers.js';
import { MarkdownConversionError } from '../types.js';
// --- Markdown-it Setup ---
function createParser() {
    return new MarkdownIt({
        html: false,
        linkify: true,
        typographer: false,
        breaks: false,
        xhtmlOut: false,
    });
}
function getLinkHref(token) {
    if (token.type !== 'link_open')
        return null;
    const hrefAttr = token.attrs?.find((attr) => attr[0] === 'href');
    return hrefAttr ? hrefAttr[1] : null;
}
function getHeadingLevel(token) {
    if (!token.type.startsWith('heading_'))
        return null;
    const match = token.tag.match(/h(\d)/);
    return match ? parseInt(match[1], 10) : null;
}
const CODE_FONT_FAMILY = 'Roboto Mono';
const CODE_TEXT_HEX = '#188038';
const CODE_BACKGROUND_HEX = '#F1F3F4';
// --- Code Block (table-based) Constants ---
// Google Docs "Code Block" building block is a styled 1x1 table.
// These constants define the visual style for programmatically created code blocks.
const CODE_BLOCK_BG_RGB = { red: 0.937, green: 0.945, blue: 0.953 }; // #EFF1F3
const CODE_BLOCK_BORDER_RGB = { red: 0.855, green: 0.863, blue: 0.878 }; // #DADCE0
// IMPORTANT: The Google Docs API always inserts a newline character ("\n") BEFORE
// the table when processing an insertTable request. So calling insertTable at index T
// produces the following document structure:
//
//   T       → paragraph break ("\n") — auto-inserted by the API
//   T + 1   → table.startIndex       (the actual table element)
//   T + 2   → tableRow.startIndex
//   T + 3   → tableCell.startIndex
//   T + 4   → paragraph.startIndex   ← cell content (text insertion point)
//   T + 6   → table.endIndex
//
// Therefore:
//   CELL_CONTENT_OFFSET = 4  (from insertTable target T to cell content at T+4)
//   EMPTY_1x1_TABLE_SIZE = 6 (total positions: 1 newline + 5 table structure)
//   Actual table start for updateTableCellStyle = T + 1 (NOT T)
//
// Verified empirically via documents.get on a real document with a 1x1 table.
const CELL_CONTENT_OFFSET = 4;
const EMPTY_1x1_TABLE_SIZE = 6;
// --- Main Conversion Function ---
/**
 * Converts a markdown string to an array of Google Docs API batch update requests.
 *
 * This is an internal function -- callers should use `insertMarkdown()` from
 * the barrel export instead.
 *
 * @param markdown - The markdown content to convert
 * @param startIndex - The document index where content should be inserted (1-based)
 * @param tabId - Optional tab ID for multi-tab documents
 * @param options - Optional conversion options (e.g. firstHeadingAsTitle)
 * @returns Array of Google Docs API requests (insertions first, then formatting)
 */
export function convertMarkdownToRequests(markdown, startIndex = 1, tabId, options) {
    if (!markdown || markdown.trim().length === 0) {
        return [];
    }
    const parser = createParser();
    const tokens = parser.parse(markdown, {});
    const context = {
        startIndex,
        currentIndex: startIndex,
        insertRequests: [],
        formatRequests: [],
        textRanges: [],
        formattingStack: [],
        listStack: [],
        paragraphRanges: [],
        normalParagraphRanges: [],
        listSpacingRanges: [],
        pendingListItems: [],
        openListItemStack: [],
        hrRanges: [],
        codeBlockRanges: [],
        tableState: undefined,
        inTableCell: false,
        tabId,
        titleConsumed: false,
        firstHeadingAsTitle: options?.firstHeadingAsTitle ?? false,
        defaultForegroundColor: options?.defaultForegroundColor ?? null,
    };
    try {
        for (const token of tokens) {
            processToken(token, context);
        }
        finalizeFormatting(context);
        return [...context.insertRequests, ...context.formatRequests];
    }
    catch (error) {
        if (error instanceof MarkdownConversionError) {
            throw error;
        }
        throw new MarkdownConversionError(`Failed to convert markdown: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
// --- Token Processing ---
function processToken(token, context) {
    switch (token.type) {
        // Headings
        case 'heading_open':
            handleHeadingOpen(token, context);
            break;
        case 'heading_close':
            handleHeadingClose(context);
            break;
        // Paragraphs
        case 'paragraph_open':
            handleParagraphOpen(context);
            break;
        case 'paragraph_close':
            handleParagraphClose(context);
            break;
        // Text content
        case 'text':
            handleTextToken(token, context);
            break;
        case 'code_inline':
            handleCodeInlineToken(token, context);
            break;
        // Inline formatting
        case 'strong_open':
            context.formattingStack.push({ bold: true });
            break;
        case 'strong_close':
            popFormatting(context, 'bold');
            break;
        case 'em_open':
            context.formattingStack.push({ italic: true });
            break;
        case 'em_close':
            popFormatting(context, 'italic');
            break;
        case 's_open':
            context.formattingStack.push({ strikethrough: true });
            break;
        case 's_close':
            popFormatting(context, 'strikethrough');
            break;
        // Links
        case 'link_open': {
            const href = getLinkHref(token);
            if (href) {
                context.formattingStack.push({ link: href });
            }
            break;
        }
        case 'link_close':
            popFormatting(context, 'link');
            break;
        // Lists
        case 'bullet_list_open':
            context.listStack.push({ type: 'bullet', level: context.listStack.length });
            break;
        case 'bullet_list_close':
            handleListClose(context);
            break;
        case 'ordered_list_open':
            context.listStack.push({ type: 'ordered', level: context.listStack.length });
            break;
        case 'ordered_list_close':
            handleListClose(context);
            break;
        case 'list_item_open':
            handleListItemOpen(context);
            break;
        case 'list_item_close':
            handleListItemClose(context);
            break;
        // Breaks
        case 'softbreak':
            if (context.inTableCell && context.tableState?.currentCell) {
                context.tableState.currentCell.text += ' ';
            }
            else {
                insertText(' ', context);
            }
            break;
        case 'hardbreak':
            if (context.inTableCell && context.tableState?.currentCell) {
                context.tableState.currentCell.text += '\n';
            }
            else {
                insertText('\n', context);
            }
            break;
        // Inline container
        case 'inline':
            if (token.children) {
                for (const child of token.children) {
                    processToken(child, context);
                }
            }
            break;
        // Tables
        case 'table_open':
            context.tableState = { rows: [], currentRow: [], inHeader: false, currentCell: null };
            break;
        case 'thead_open':
            if (context.tableState)
                context.tableState.inHeader = true;
            break;
        case 'thead_close':
            if (context.tableState)
                context.tableState.inHeader = false;
            break;
        case 'tbody_open':
        case 'tbody_close':
            break;
        case 'tr_open':
            if (context.tableState)
                context.tableState.currentRow = [];
            break;
        case 'tr_close':
            if (context.tableState && context.tableState.currentRow.length > 0) {
                context.tableState.rows.push([...context.tableState.currentRow]);
                context.tableState.currentRow = [];
            }
            break;
        case 'th_open':
        case 'td_open': {
            if (context.tableState) {
                context.tableState.currentCell = {
                    text: '',
                    isHeader: context.tableState.inHeader || token.type === 'th_open',
                    textRanges: [],
                };
                context.inTableCell = true;
            }
            break;
        }
        case 'th_close':
        case 'td_close':
            if (context.tableState?.currentCell) {
                context.tableState.currentRow.push(context.tableState.currentCell);
                context.tableState.currentCell = null;
            }
            context.inTableCell = false;
            break;
        case 'table_close':
            if (context.tableState) {
                handleTableClose(context.tableState, context);
                context.tableState = undefined;
                context.inTableCell = false;
            }
            break;
        // Code blocks
        case 'fence':
        case 'code_block':
            handleCodeBlockToken(token, context);
            break;
        // Horizontal rules
        case 'hr':
            handleHorizontalRule(context);
            break;
        // Blockquotes (skip for now)
        case 'blockquote_open':
        case 'blockquote_close':
            break;
        default:
            break;
    }
}
// --- Heading Handlers ---
function handleHeadingOpen(token, context) {
    const level = getHeadingLevel(token);
    if (level) {
        context.currentHeadingLevel = level;
        context.currentParagraphStart = context.currentIndex;
    }
}
function handleHeadingClose(context) {
    if (context.currentHeadingLevel && context.currentParagraphStart !== undefined) {
        // When firstHeadingAsTitle is enabled, the very first H1 becomes a TITLE.
        const useTitle = context.firstHeadingAsTitle && !context.titleConsumed && context.currentHeadingLevel === 1;
        if (useTitle) {
            context.titleConsumed = true;
        }
        context.paragraphRanges.push({
            startIndex: context.currentParagraphStart,
            endIndex: context.currentIndex,
            namedStyleType: useTitle ? 'TITLE' : `HEADING_${context.currentHeadingLevel}`,
        });
        insertText('\n', context);
        context.currentHeadingLevel = undefined;
        context.currentParagraphStart = undefined;
    }
}
// --- Horizontal Rule ---
function handleHorizontalRule(context) {
    if (!lastInsertEndsWithNewline(context)) {
        insertText('\n', context);
    }
    const start = context.currentIndex;
    insertText('\n', context);
    context.hrRanges.push({ startIndex: start, endIndex: context.currentIndex });
}
// --- Paragraph Handlers ---
function handleParagraphOpen(context) {
    if (context.listStack.length === 0) {
        context.currentParagraphStart = context.currentIndex;
    }
}
function handleParagraphClose(context) {
    // Track normal (non-list) paragraph ranges for spacing
    const paragraphStart = context.currentParagraphStart;
    if (!lastInsertEndsWithNewline(context)) {
        insertText('\n', context);
    }
    const currentListItem = getCurrentOpenListItem(context);
    if (currentListItem) {
        const paragraphEndIndex = lastInsertEndsWithNewline(context)
            ? context.currentIndex - 1
            : context.currentIndex;
        if (paragraphEndIndex > currentListItem.startIndex) {
            currentListItem.endIndex = paragraphEndIndex;
        }
    }
    // Record the range for normal paragraphs (not list items) so we can apply spacing later
    if (paragraphStart !== undefined && context.listStack.length === 0) {
        context.normalParagraphRanges.push({
            startIndex: paragraphStart,
            endIndex: context.currentIndex,
        });
    }
    context.currentParagraphStart = undefined;
}
// --- List Handlers ---
function handleListItemOpen(context) {
    if (context.listStack.length === 0) {
        throw new MarkdownConversionError('List item found outside of list context');
    }
    const currentList = context.listStack[context.listStack.length - 1];
    const itemStart = context.currentIndex;
    if (currentList.level > 0) {
        insertText('\t'.repeat(currentList.level), context);
    }
    const listItem = {
        startIndex: itemStart,
        nestingLevel: currentList.level,
        bulletPreset: currentList.type === 'ordered' ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE',
        taskPrefixProcessed: false,
    };
    context.pendingListItems.push(listItem);
    context.openListItemStack.push(context.pendingListItems.length - 1);
}
function handleListItemClose(context) {
    const openIndex = context.openListItemStack.pop();
    if (openIndex === undefined)
        return;
    const listItem = context.pendingListItems[openIndex];
    if (listItem.endIndex === undefined) {
        const computedEndIndex = lastInsertEndsWithNewline(context)
            ? context.currentIndex - 1
            : context.currentIndex;
        if (computedEndIndex > listItem.startIndex) {
            listItem.endIndex = computedEndIndex;
        }
    }
    if (!lastInsertEndsWithNewline(context)) {
        insertText('\n', context);
    }
}
function handleListClose(context) {
    context.listStack.pop();
    // When a top-level list closes (stack becomes empty), record the range of the
    // last list item's paragraph so we can apply spaceBelow to it. This creates a
    // visible gap between the end of a list and the following content.
    if (context.listStack.length === 0) {
        // Find the last pending list item that has a valid endIndex
        for (let i = context.pendingListItems.length - 1; i >= 0; i--) {
            const item = context.pendingListItems[i];
            if (item.endIndex !== undefined && item.endIndex > item.startIndex) {
                context.listSpacingRanges.push({
                    startIndex: item.startIndex,
                    endIndex: item.endIndex,
                });
                break;
            }
        }
    }
}
// --- Text Handling ---
function handleTextToken(token, context) {
    let text = token.content;
    if (!text)
        return;
    // Intercept text when inside a table cell — collect into cell buffer
    if (context.inTableCell && context.tableState?.currentCell) {
        const cell = context.tableState.currentCell;
        const startIndex = cell.text.length;
        cell.text += text;
        const formatting = mergeFormattingStack(context.formattingStack);
        if (hasFormatting(formatting)) {
            cell.textRanges.push({ startIndex, endIndex: cell.text.length, formatting });
        }
        return;
    }
    const currentListItem = getCurrentOpenListItem(context);
    if (currentListItem && !currentListItem.taskPrefixProcessed) {
        currentListItem.taskPrefixProcessed = true;
        const taskPrefixMatch = text.match(/^\[( |x|X)\]\s+/);
        if (taskPrefixMatch) {
            currentListItem.bulletPreset = 'BULLET_CHECKBOX';
            text = text.slice(taskPrefixMatch[0].length);
            if (!text)
                return;
        }
    }
    const startIndex = context.currentIndex;
    const endIndex = startIndex + text.length;
    insertText(text, context);
    const currentFormatting = mergeFormattingStack(context.formattingStack);
    if (hasFormatting(currentFormatting)) {
        context.textRanges.push({ startIndex, endIndex, formatting: currentFormatting });
    }
}
function handleCodeInlineToken(token, context) {
    context.formattingStack.push({ code: true });
    handleTextToken(token, context);
    popFormatting(context, 'code');
}
function handleCodeBlockToken(token, context) {
    const normalizedContent = token.content.endsWith('\n')
        ? token.content.slice(0, -1)
        : token.content;
    const language = token.info?.trim() || undefined;
    // Ensure previous content ends with a newline before inserting the table
    if (context.insertRequests.length > 0 && !lastInsertEndsWithNewline(context)) {
        insertText('\n', context);
    }
    const tableStartIndex = context.currentIndex;
    // 1. Insert a 1x1 table (creates the table structure with an empty paragraph in the cell)
    const tableLocation = { index: tableStartIndex };
    if (context.tabId)
        tableLocation.tabId = context.tabId;
    context.insertRequests.push({
        insertTable: {
            location: tableLocation,
            rows: 1,
            columns: 1,
        },
    });
    // 2. Insert code text into the cell paragraph
    // For a 1x1 table at index N, the cell paragraph content starts at N + CELL_CONTENT_OFFSET
    const cellContentIndex = tableStartIndex + CELL_CONTENT_OFFSET;
    const textLength = normalizedContent.length;
    if (textLength > 0) {
        const cellLocation = { index: cellContentIndex };
        if (context.tabId)
            cellLocation.tabId = context.tabId;
        context.insertRequests.push({
            insertText: {
                location: cellLocation,
                text: normalizedContent,
            },
        });
    }
    // 3. Track the code block for table/text formatting in finalization
    context.codeBlockRanges.push({
        tableStartIndex,
        textStartIndex: cellContentIndex,
        textEndIndex: cellContentIndex + textLength,
        language,
    });
    // 4. Advance currentIndex past the entire table structure
    // Total table size = EMPTY_1x1_TABLE_SIZE + inserted text length
    context.currentIndex = tableStartIndex + EMPTY_1x1_TABLE_SIZE + textLength;
    // 5. Ensure a newline after the table for paragraph separation
    insertText('\n', context);
}
// --- Table Handler ---
//
// Google Docs API table index layout for an R×C table inserted at T:
//
//   T          → newline (auto-inserted before table)
//   T + 1      → table element
//   T + 2      → row[0]
//   T + 3      → cell[0][0]
//   T + 4      → paragraph in cell[0][0]  ← content insertion point
//   T + 5      → cell[0][1]  (for C > 1)
//   T + 6      → paragraph in cell[0][1]
//   ...
//   T + 2+C    → row[1]  (for R > 1)
//   ...
//   T + end    → table end
//
// Formulas (verified empirically via CELL_CONTENT_OFFSET and EMPTY_1x1_TABLE_SIZE):
//   cellContentIndex(T, r, c, C) = T + 4 + r * (1 + 2*C) + 2*c
//   emptyTableSize(R, C)         = 3 + R * (1 + 2*C)
function handleTableClose(tableState, context) {
    const rows = tableState.rows;
    if (rows.length === 0)
        return;
    const numRows = rows.length;
    const numCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
    if (numCols === 0)
        return;
    // Ensure newline before table
    if (!lastInsertEndsWithNewline(context)) {
        insertText('\n', context);
    }
    const tableStartIndex = context.currentIndex;
    // Insert the table structure
    const tableLocation = { index: tableStartIndex };
    if (context.tabId)
        tableLocation.tabId = context.tabId;
    context.insertRequests.push({
        insertTable: {
            location: tableLocation,
            rows: numRows,
            columns: numCols,
        },
    });
    // Insert text into each cell, tracking cumulative offset from prior insertions
    let cumulativeTextLength = 0;
    for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < numCols; c++) {
            const cell = rows[r]?.[c];
            if (!cell?.text)
                continue;
            const baseCellIndex = tableStartIndex + 4 + r * (1 + 2 * numCols) + 2 * c;
            const adjustedIndex = baseCellIndex + cumulativeTextLength;
            const cellLocation = { index: adjustedIndex };
            if (context.tabId)
                cellLocation.tabId = context.tabId;
            context.insertRequests.push({
                insertText: {
                    location: cellLocation,
                    text: cell.text,
                },
            });
            // Apply inline formatting (bold, italic, links, etc.) from within the cell
            for (const range of cell.textRanges) {
                const absStart = adjustedIndex + range.startIndex;
                const absEnd = adjustedIndex + range.endIndex;
                if (range.formatting.bold ||
                    range.formatting.italic ||
                    range.formatting.strikethrough ||
                    range.formatting.code) {
                    const styleReq = buildUpdateTextStyleRequest(absStart, absEnd, {
                        bold: range.formatting.bold,
                        italic: range.formatting.italic,
                        strikethrough: range.formatting.strikethrough,
                        fontFamily: range.formatting.code ? CODE_FONT_FAMILY : undefined,
                        foregroundColor: range.formatting.code ? CODE_TEXT_HEX : undefined,
                        backgroundColor: range.formatting.code ? CODE_BACKGROUND_HEX : undefined,
                    }, context.tabId);
                    if (styleReq)
                        context.formatRequests.push(styleReq.request);
                }
                if (range.formatting.link) {
                    const linkReq = buildUpdateTextStyleRequest(absStart, absEnd, { linkUrl: range.formatting.link }, context.tabId);
                    if (linkReq)
                        context.formatRequests.push(linkReq.request);
                }
            }
            // Bold all text in header cells
            if (cell.isHeader && cell.text.length > 0) {
                const headerStyleReq = buildUpdateTextStyleRequest(adjustedIndex, adjustedIndex + cell.text.length, { bold: true }, context.tabId);
                if (headerStyleReq)
                    context.formatRequests.push(headerStyleReq.request);
            }
            cumulativeTextLength += cell.text.length;
        }
    }
    // Advance currentIndex past the full table (empty structure + all inserted text)
    const emptyTableSize = 3 + numRows * (1 + 2 * numCols);
    context.currentIndex = tableStartIndex + emptyTableSize + cumulativeTextLength;
    // Ensure newline after table
    insertText('\n', context);
}
// --- Insert Helper ---
function insertText(text, context) {
    const location = { index: context.currentIndex };
    if (context.tabId) {
        location.tabId = context.tabId;
    }
    context.insertRequests.push({
        insertText: { location: location, text },
    });
    context.currentIndex += text.length;
}
// --- Formatting Stack ---
function mergeFormattingStack(stack) {
    const merged = {};
    for (const state of stack) {
        if (state.bold !== undefined)
            merged.bold = state.bold;
        if (state.italic !== undefined)
            merged.italic = state.italic;
        if (state.strikethrough !== undefined)
            merged.strikethrough = state.strikethrough;
        if (state.code !== undefined)
            merged.code = state.code;
        if (state.link !== undefined)
            merged.link = state.link;
    }
    return merged;
}
function hasFormatting(formatting) {
    return (formatting.bold === true ||
        formatting.italic === true ||
        formatting.strikethrough === true ||
        formatting.code === true ||
        formatting.link !== undefined);
}
function popFormatting(context, type) {
    for (let i = context.formattingStack.length - 1; i >= 0; i--) {
        if (context.formattingStack[i][type] !== undefined) {
            context.formattingStack.splice(i, 1);
            break;
        }
    }
}
// --- Finalization ---
function finalizeFormatting(context) {
    // Apply the document's default foreground color to the entire inserted range
    // so text has an explicit color value in Google Docs (fixes issue #14).
    // This goes first so intentional colors (code blocks, links) override it.
    if (context.defaultForegroundColor && context.currentIndex > context.startIndex) {
        const baseRange = {
            startIndex: context.startIndex,
            endIndex: context.currentIndex,
        };
        if (context.tabId) {
            baseRange.tabId = context.tabId;
        }
        context.formatRequests.push({
            updateTextStyle: {
                range: baseRange,
                textStyle: {
                    foregroundColor: {
                        color: { rgbColor: context.defaultForegroundColor },
                    },
                },
                fields: 'foregroundColor',
            },
        });
    }
    // Character-level formatting (bold, italic, strikethrough, code, links)
    for (const range of context.textRanges) {
        const rangeLocation = {
            startIndex: range.startIndex,
            endIndex: range.endIndex,
        };
        if (context.tabId) {
            rangeLocation.tabId = context.tabId;
        }
        if (range.formatting.bold ||
            range.formatting.italic ||
            range.formatting.strikethrough ||
            range.formatting.code) {
            const styleRequest = buildUpdateTextStyleRequest(range.startIndex, range.endIndex, {
                bold: range.formatting.bold,
                italic: range.formatting.italic,
                strikethrough: range.formatting.strikethrough,
                fontFamily: range.formatting.code ? CODE_FONT_FAMILY : undefined,
                foregroundColor: range.formatting.code ? CODE_TEXT_HEX : undefined,
                backgroundColor: range.formatting.code ? CODE_BACKGROUND_HEX : undefined,
            }, context.tabId);
            if (styleRequest) {
                context.formatRequests.push(styleRequest.request);
            }
        }
        if (range.formatting.link) {
            const linkRequest = buildUpdateTextStyleRequest(range.startIndex, range.endIndex, { linkUrl: range.formatting.link }, context.tabId);
            if (linkRequest) {
                context.formatRequests.push(linkRequest.request);
            }
        }
    }
    // Paragraph-level formatting (headings)
    for (const paraRange of context.paragraphRanges) {
        if (paraRange.namedStyleType) {
            const paraRequest = buildUpdateParagraphStyleRequest(paraRange.startIndex, paraRange.endIndex, { namedStyleType: paraRange.namedStyleType }, context.tabId);
            if (paraRequest) {
                context.formatRequests.push(paraRequest.request);
            }
        }
    }
    // Normal paragraph spacing (spaceBelow so paragraphs have visible gaps between them,
    // matching the visual separation expected from markdown-rendered paragraphs).
    // The default Google Docs NORMAL_TEXT style has 0pt spacing, so without this
    // paragraphs would appear crammed together with no gap.
    for (const normalRange of context.normalParagraphRanges) {
        const range = {
            startIndex: normalRange.startIndex,
            endIndex: normalRange.endIndex,
        };
        if (context.tabId) {
            range.tabId = context.tabId;
        }
        context.formatRequests.push({
            updateParagraphStyle: {
                range,
                paragraphStyle: {
                    spaceBelow: { magnitude: 8, unit: 'PT' },
                },
                fields: 'spaceBelow',
            },
        });
    }
    // List trailing spacing: apply spaceBelow to the last paragraph of each
    // top-level list so there is a visible gap between the list and the content
    // that follows it.
    for (const listRange of context.listSpacingRanges) {
        const range = {
            startIndex: listRange.startIndex,
            endIndex: listRange.endIndex,
        };
        if (context.tabId) {
            range.tabId = context.tabId;
        }
        context.formatRequests.push({
            updateParagraphStyle: {
                range,
                paragraphStyle: {
                    spaceBelow: { magnitude: 8, unit: 'PT' },
                },
                fields: 'spaceBelow',
            },
        });
    }
    // Code block table formatting (1x1 table with background + monospace text)
    for (const codeBlock of context.codeBlockRanges) {
        // The actual table element starts at tableStartIndex + 1 because insertTable
        // auto-inserts a preceding newline at tableStartIndex (see constants comment above).
        const tableStartLocation = { index: codeBlock.tableStartIndex + 1 };
        if (context.tabId)
            tableStartLocation.tabId = context.tabId;
        // Style the text inside the cell as monospace
        if (codeBlock.textEndIndex > codeBlock.textStartIndex) {
            const codeTextStyle = buildUpdateTextStyleRequest(codeBlock.textStartIndex, codeBlock.textEndIndex, { fontFamily: CODE_FONT_FAMILY }, context.tabId);
            if (codeTextStyle) {
                context.formatRequests.push(codeTextStyle.request);
            }
        }
        // Set cell background color to light gray
        const borderStyle = {
            color: { color: { rgbColor: CODE_BLOCK_BORDER_RGB } },
            width: { magnitude: 0.5, unit: 'PT' },
            dashStyle: 'SOLID',
        };
        context.formatRequests.push({
            updateTableCellStyle: {
                tableRange: {
                    tableCellLocation: {
                        tableStartLocation: tableStartLocation,
                        rowIndex: 0,
                        columnIndex: 0,
                    },
                    rowSpan: 1,
                    columnSpan: 1,
                },
                tableCellStyle: {
                    backgroundColor: { color: { rgbColor: CODE_BLOCK_BG_RGB } },
                    paddingTop: { magnitude: 8, unit: 'PT' },
                    paddingBottom: { magnitude: 8, unit: 'PT' },
                    paddingLeft: { magnitude: 12, unit: 'PT' },
                    paddingRight: { magnitude: 12, unit: 'PT' },
                    borderTop: borderStyle,
                    borderBottom: borderStyle,
                    borderLeft: borderStyle,
                    borderRight: borderStyle,
                },
                fields: 'backgroundColor,paddingTop,paddingBottom,paddingLeft,paddingRight,borderTop,borderBottom,borderLeft,borderRight',
            },
        });
    }
    // Horizontal rule styling (bottom border on empty paragraphs)
    for (const hrRange of context.hrRanges) {
        const range = {
            startIndex: hrRange.startIndex,
            endIndex: hrRange.endIndex,
        };
        if (context.tabId) {
            range.tabId = context.tabId;
        }
        context.formatRequests.push({
            updateParagraphStyle: {
                range,
                paragraphStyle: {
                    borderBottom: {
                        color: {
                            color: { rgbColor: { red: 0.75, green: 0.75, blue: 0.75 } },
                        },
                        width: { magnitude: 1, unit: 'PT' },
                        padding: { magnitude: 6, unit: 'PT' },
                        dashStyle: 'SOLID',
                    },
                },
                fields: 'borderBottom',
            },
        });
    }
    // List formatting: merge *adjacent* items of the same bullet type into single
    // ranges so Google Docs treats them as one list (with sequential numbering).
    // Items are only merged when they're truly adjacent (gap of at most 1 char
    // for the newline between them). Separate lists with paragraphs, headings, or
    // other content between them must NOT be merged, otherwise
    // createParagraphBullets would turn all intervening content into bullets.
    const validListItems = context.pendingListItems
        .filter((item) => item.endIndex !== undefined && item.endIndex > item.startIndex)
        .sort((a, b) => a.startIndex - b.startIndex);
    const mergedListRanges = [];
    for (const item of validListItems) {
        const last = mergedListRanges[mergedListRanges.length - 1];
        if (last && last.bulletPreset === item.bulletPreset && item.startIndex <= last.endIndex + 1) {
            last.endIndex = Math.max(last.endIndex, item.endIndex);
        }
        else {
            mergedListRanges.push({
                startIndex: item.startIndex,
                endIndex: item.endIndex,
                bulletPreset: item.bulletPreset,
            });
        }
    }
    // Apply bottom-to-top to avoid index shifts from tab consumption
    mergedListRanges.sort((a, b) => b.startIndex - a.startIndex);
    for (const merged of mergedListRanges) {
        const rangeLocation = {
            startIndex: merged.startIndex,
            endIndex: merged.endIndex,
        };
        if (context.tabId) {
            rangeLocation.tabId = context.tabId;
        }
        context.formatRequests.push({
            createParagraphBullets: {
                range: rangeLocation,
                bulletPreset: merged.bulletPreset,
            },
        });
    }
}
// --- Utility ---
function getCurrentOpenListItem(context) {
    const openIndex = context.openListItemStack[context.openListItemStack.length - 1];
    if (openIndex === undefined)
        return null;
    return context.pendingListItems[openIndex] ?? null;
}
function lastInsertEndsWithNewline(context) {
    const lastInsert = context.insertRequests[context.insertRequests.length - 1]?.insertText?.text;
    return Boolean(lastInsert && lastInsert.endsWith('\n'));
}
