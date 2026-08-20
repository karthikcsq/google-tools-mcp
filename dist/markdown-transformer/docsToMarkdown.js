// src/markdown-transformer/docsToMarkdown.ts
/**
 * Font families used by the markdown-to-docs direction for code styling.
 * When these are detected on a text run, we render backtick code in markdown.
 */
const CODE_FONT_FAMILIES = new Set(['Roboto Mono', 'Courier New', 'Consolas', 'monospace']);
/**
 * Inspects the body content that replaceDocumentWithMarkdown will delete and
 * re-insert, and reports anything docsJsonToMarkdown cannot represent at all.
 * Returns an array of human-readable warning strings (empty if the content
 * converts losslessly). Call before replaceDocumentWithMarkdown to warn the AI
 * about what a body replacement will permanently lose.
 *
 * Checked: inline/positioned images and footnote references, neither of which
 * has any markdown representation in either direction of this converter; a
 * generated table of contents; and, generically, every OTHER Docs API
 * `ParagraphElement` variant that `extractFormattedText()` does not render.
 *
 * `extractFormattedText()` only ever renders `textRun` (see below). The Docs
 * API `ParagraphElement` union also defines `autoText`, `pageBreak`,
 * `columnBreak`, `horizontalRule`, `equation`, `person`, `richLink`, and
 * `dateElement` (https://developers.google.com/workspace/docs/api/reference/rest/v1/documents#ParagraphElement).
 * None of those has a markdown representation, so a body replacement deletes
 * them permanently and the current markdown output never mentions they were
 * there. Rather than enumerate that list (and silently miss whatever variant
 * Google adds next), this scanner is deny-by-default: any paragraph-element
 * key other than `startIndex`/`endIndex` (position metadata) and the three
 * keys explicitly handled elsewhere in this function (`textRun`, rendered;
 * `inlineObjectElement`/`footnoteReference`, already counted above) is
 * treated as an unhandled content variant and reported by name.
 *
 * NOT checked (intentionally): custom text/highlight colors and non-default
 * paragraph alignment. Those round-trip losslessly through the rich-markdown
 * HTML extensions this converter emits by default (`<span style="color:...">`,
 * `<p align="...">`, table alignment markers) and their inverse parsing in
 * markdownToDocs.js, so warning about them here would be inaccurate.
 *
 * IMPORTANT — accuracy: every warning is derived from `bodyContent` itself,
 * i.e. the exact body (a specific tab's body in tab mode, the document body
 * otherwise) that the replacement mutates. This deliberately does NOT inspect
 * document-level `headers`/`footers`, which are separate document segments a
 * body-content replacement does not delete, nor the global `inlineObjects`/
 * `footnotes` maps, which can include content belonging to OTHER tabs that a
 * scoped replacement never touches.
 *
 * @param {Array} bodyContent structural elements of the body being replaced
 *   (e.g. `contentSource.body.content`).
 * @returns {string[]} warnings
 */
// ParagraphElement keys this converter already accounts for: startIndex/
// endIndex are position metadata (not content); textRun is rendered by
// extractFormattedText(); inlineObjectElement/footnoteReference are counted
// as their own dedicated warnings below. Any other key on a ParagraphElement
// is, by the Docs API's own union contract, an unhandled content-bearing
// variant (autoText, pageBreak, columnBreak, horizontalRule, equation,
// person, richLink, dateElement, or a future addition) that extractFormattedText
// silently drops.
const HANDLED_PARAGRAPH_ELEMENT_KEYS = new Set([
    'startIndex',
    'endIndex',
    'textRun',
    'inlineObjectElement',
    'footnoteReference',
]);
export function checkMarkdownFidelity(bodyContent) {
    const warnings = [];
    let imageCount = 0;
    let footnoteCount = 0;
    let tocCount = 0;
    const unhandledElementCounts = {};
    function scanParagraphElements(elements) {
        for (const pe of elements) {
            // Inline images embedded in the body flow — deleted with the body.
            if (pe.inlineObjectElement) {
                imageCount++;
            }
            // Footnote references live in the body; deleting the body removes them
            // (and Docs then drops the orphaned footnote).
            if (pe.footnoteReference) {
                footnoteCount++;
            }
            // Deny-by-default: anything that isn't a key we explicitly handle is an
            // unhandled ParagraphElement variant. Grouped and named below rather
            // than warning per element.
            for (const key of Object.keys(pe)) {
                if (!HANDLED_PARAGRAPH_ELEMENT_KEYS.has(key)) {
                    unhandledElementCounts[key] = (unhandledElementCounts[key] ?? 0) + 1;
                }
            }
        }
    }
    function scanBodyContent(content) {
        for (const element of content) {
            if (element.paragraph) {
                // Positioned (floating) images anchored to this paragraph are also
                // removed when the paragraph is deleted.
                if (Array.isArray(element.paragraph.positionedObjectIds)) {
                    imageCount += element.paragraph.positionedObjectIds.length;
                }
                scanParagraphElements(element.paragraph.elements ?? []);
            }
            else if (element.table) {
                for (const row of (element.table.tableRows ?? [])) {
                    for (const cell of (row.tableCells ?? [])) {
                        scanBodyContent(cell.content ?? []);
                    }
                }
            }
            // A generated table of contents sits in the body, so the replacement
            // deletes it, and markdown has no way to express one, so the importer
            // cannot put it back. Without this the whole round trip drops the TOC
            // with nothing said about it.
            else if (element.tableOfContents) {
                tocCount++;
            }
        }
    }
    scanBodyContent(bodyContent ?? []);
    if (imageCount > 0) {
        warnings.push(`${imageCount} image(s) — will be removed`);
    }
    if (footnoteCount > 0) {
        warnings.push(`${footnoteCount} footnote(s) — will be removed`);
    }
    if (tocCount > 0) {
        warnings.push(`${tocCount} table(s) of contents — will be removed (markdown cannot express a generated TOC; reinsert it in Docs afterward)`);
    }
    const unhandledKeys = Object.keys(unhandledElementCounts).sort();
    if (unhandledKeys.length > 0) {
        const parts = unhandledKeys.map((key) => `${unhandledElementCounts[key]} ${key}`).join(', ');
        warnings.push(`${parts} — unsupported content type(s) with no markdown representation; will be removed`);
    }
    return warnings;
}
// --- Main Conversion ---
/**
 * Converts Google Docs JSON structure to a markdown string.
 *
 * Accepts the raw response from `docs.documents.get()`, or a subset with
 * `{ body, lists }` (e.g. when extracting a specific tab).
 *
 * Handles headings, paragraphs, text formatting (bold, italic, strikethrough,
 * underline, links, code), ordered & unordered lists with nesting, tables,
 * and section breaks.
 */
export function docsJsonToMarkdown(docData, options = {}) {
    const body = docData.body;
    if (!body?.content) {
        return '';
    }
    const lists = docData.lists ?? {};
    const conversionOptions = {
        richMarkdown: options.plainMarkdown ? false : options.richMarkdown ?? true,
    };
    // Stateful list-rendering context threaded through the whole conversion
    // loop: per-nesting-level ordinal counters (keyed to the Docs listId so a
    // list resumes its count across an interrupting paragraph but resets when
    // a different list, or a new parent item, takes over that level) plus
    // whether the immediately preceding block was a list item (so a following
    // non-list block gets a blank-line separator instead of being read as a
    // lazy continuation of the last list item).
    const listState = { listStack: [], lastWasListItem: false };
    let markdown = '';
    for (const element of body.content) {
        if (element.paragraph) {
            markdown += convertParagraph(element.paragraph, lists, conversionOptions, listState);
        }
        else if (element.table) {
            markdown += separatorIfAfterListItem(listState) + convertTable(element.table, conversionOptions);
            listState.lastWasListItem = false;
        }
        else if (element.sectionBreak) {
            if (isInitialDocumentSectionBreak(element)) {
                continue;
            }
            markdown += separatorIfAfterListItem(listState) + '\n---\n\n';
            listState.lastWasListItem = false;
        }
    }
    return markdown.trim();
}
// A blank-line separator so a non-list block that immediately follows a list
// item is parsed as its own block rather than a lazy continuation line of the
// last list item (CommonMark's "lazy continuation" rule).
function separatorIfAfterListItem(listState) {
    return listState.lastWasListItem ? '\n' : '';
}
function isInitialDocumentSectionBreak(element) {
    return element.endIndex === 1 && element.startIndex === undefined;
}
// --- Paragraph Conversion ---
function convertParagraph(paragraph, lists, options, listState) {
    // 1. Determine paragraph type
    const headingLevel = getHeadingLevel(paragraph);
    const listInfo = getListInfo(paragraph, lists);
    // 2. Extract text content with inline formatting
    const elements = paragraph.elements ?? [];
    const text = extractFormattedText(elements, options);
    // 3. Format based on type
    if (listInfo && text.trim()) {
        // List items are handled before the "was the previous block a list
        // item" separator check below — they ARE the list, not the thing that
        // needs separating from it.
        return renderListItem(listInfo, text.trim(), listState);
    }
    const separator = separatorIfAfterListItem(listState);
    listState.lastWasListItem = false;
    if (headingLevel && text.trim()) {
        const hashes = '#'.repeat(Math.min(headingLevel, 6));
        return `${separator}${hashes} ${text.trim()}\n\n`;
    }
    if (text.trim()) {
        const trimmed = text.trim();
        if (options.richMarkdown && isBlockquoteParagraph(paragraph)) {
            return `${separator}<blockquote>${trimmed}</blockquote>\n\n`;
        }
        const alignment = paragraphAlignmentToHtml(paragraph.paragraphStyle?.alignment);
        if (options.richMarkdown && alignment) {
            return `${separator}<p align="${alignment}">${trimmed}</p>\n\n`;
        }
        return `${separator}${trimmed}\n\n`;
    }
    return `${separator}\n`;
}
// Renders one list item's marker/indent and updates the per-level ordinal
// state. Indentation for a level is the cumulative rendered width (marker +
// trailing space) of every ancestor level's marker, so a nested item lands
// past its parent's marker column regardless of whether the parent is a
// `-` (2 columns) or a multi-digit ordinal like `12.` (4 columns) — the bug
// this replaces used a flat 2-space-per-level indent that only happened to
// work for unordered lists.
function renderListItem(listInfo, text, listState) {
    const { nestingLevel, ordered, listId } = listInfo;
    const stack = listState.listStack;
    // Preserve this level's existing entry (needed below to decide whether the
    // ordinal continues or resets) while discarding any deeper levels: we have
    // returned to `nestingLevel`, so whatever nested sub-list state existed
    // below it no longer applies to what comes next.
    const existing = stack[nestingLevel];
    stack.length = nestingLevel + 1;
    let count;
    if (existing && existing.listId === listId) {
        // Same Docs list resuming at this level — continue counting even if a
        // non-list paragraph interrupted it (an "interrupted/resumed" list).
        count = existing.count + 1;
    }
    else {
        // A different list, or the first item a new parent introduces at this
        // level: sequential numbering restarts at 1.
        count = 1;
    }
    const marker = ordered ? `${count}.` : '-';
    stack[nestingLevel] = { listId, count, markerWidth: marker.length + 1 };
    let indent = '';
    for (let level = 0; level < nestingLevel; level++) {
        const ancestor = stack[level];
        // No ancestor entry means Docs jumped straight to a deep nesting level
        // with no intervening parent item observed; fall back to the classic
        // 2-column indent for that level rather than losing indentation.
        indent += ' '.repeat(ancestor ? ancestor.markerWidth : 2);
    }
    listState.lastWasListItem = true;
    return `${indent}${marker} ${text}\n`;
}
// --- Heading Detection ---
function getHeadingLevel(paragraph) {
    const styleType = paragraph.paragraphStyle?.namedStyleType;
    if (!styleType)
        return null;
    if (styleType === 'TITLE')
        return 1;
    if (styleType === 'SUBTITLE')
        return 2;
    const match = styleType.match(/^HEADING_(\d)$/);
    return match ? parseInt(match[1], 10) : null;
}
function getListInfo(paragraph, lists) {
    if (!paragraph.bullet)
        return null;
    const nestingLevel = paragraph.bullet.nestingLevel ?? 0;
    const listId = paragraph.bullet.listId;
    let ordered = false;
    if (listId && lists[listId]?.listProperties?.nestingLevels) {
        const nestingLevels = lists[listId].listProperties.nestingLevels;
        const level = nestingLevels[nestingLevel];
        if (level) {
            // glyphType is set for ordered lists (e.g., DECIMAL, ALPHA, ROMAN)
            // glyphSymbol is set for unordered lists (e.g., bullet characters)
            // If glyphType is present and not empty, it's ordered
            if (level.glyphType && level.glyphType !== 'GLYPH_TYPE_UNSPECIFIED') {
                ordered = true;
            }
        }
    }
    return { ordered, nestingLevel, listId };
}
// --- Text Run Conversion ---
function extractFormattedText(elements, options) {
    let result = '';
    for (const element of elements) {
        if (element.textRun) {
            result += convertTextRun(element.textRun, options);
        }
    }
    return result;
}
function convertTextRun(textRun, options) {
    let text = textRun.content ?? '';
    const style = textRun.textStyle;
    if (!style)
        return text;
    // Detect code-styled text (monospace font) -- wrap in backticks and skip
    // other formatting since markdown code spans don't support nested formatting.
    if (isCodeStyled(style)) {
        const trimmed = text.replace(/\n$/, '');
        if (trimmed) {
            return `\`${trimmed}\`${text.endsWith('\n') ? '\n' : ''}`;
        }
        return text;
    }
    // Strip trailing newline before applying formatting markers, then re-add.
    // This prevents markers from wrapping the newline (e.g., "**text\n**").
    const trailingNewline = text.endsWith('\n');
    const content = trailingNewline ? text.slice(0, -1) : text;
    if (!content)
        return text;
    let formatted = content;
    // Apply inline formatting (bold + italic combined, or individually)
    if (style.bold && style.italic) {
        formatted = `***${formatted}***`;
    }
    else if (style.bold) {
        formatted = `**${formatted}**`;
    }
    else if (style.italic) {
        formatted = `*${formatted}*`;
    }
    if (style.strikethrough) {
        formatted = `~~${formatted}~~`;
    }
    if (options.richMarkdown && style.underline && !style.link) {
        formatted = `<u>${formatted}</u>`;
    }
    if (options.richMarkdown) {
        formatted = applyRichTextStyle(formatted, style);
    }
    if (style.link?.url) {
        formatted = `[${formatted}](${style.link.url})`;
    }
    return formatted + (trailingNewline ? '\n' : '');
}
function applyRichTextStyle(text, style) {
    const styles = [];
    const fg = rgbColorToHex(style.foregroundColor?.color?.rgbColor);
    const bg = rgbColorToHex(style.backgroundColor?.color?.rgbColor);
    const fontSize = style.fontSize?.magnitude;
    const fontFamily = style.weightedFontFamily?.fontFamily;
    if (fg)
        styles.push(`color:${fg}`);
    if (bg)
        styles.push(`background-color:${bg}`);
    if (typeof fontSize === 'number')
        styles.push(`font-size:${fontSize}pt`);
    if (fontFamily && !CODE_FONT_FAMILIES.has(fontFamily))
        styles.push(`font-family:${escapeHtmlAttr(fontFamily)}`);
    if (styles.length === 0)
        return text;
    return `<span style="${styles.join(';')}">${text}</span>`;
}
function isCodeStyled(style) {
    const fontFamily = style.weightedFontFamily?.fontFamily;
    return typeof fontFamily === 'string' && CODE_FONT_FAMILIES.has(fontFamily);
}
function isBlockquoteParagraph(paragraph) {
    const style = paragraph.paragraphStyle;
    return Boolean(style?.borderLeft ||
        style?.indentStart?.magnitude >= 30 ||
        style?.indentFirstLine?.magnitude >= 30);
}
function paragraphAlignmentToHtml(alignment) {
    switch (alignment) {
        case 'CENTER':
            return 'center';
        case 'END':
        case 'RIGHT':
            return 'right';
        case 'JUSTIFIED':
            return 'justify';
        default:
            return null;
    }
}
function rgbColorToHex(rgb) {
    if (!rgb)
        return null;
    const toHex = (value) => {
        const normalized = Math.max(0, Math.min(255, Math.round((value ?? 0) * 255)));
        return normalized.toString(16).padStart(2, '0');
    };
    return `#${toHex(rgb.red)}${toHex(rgb.green)}${toHex(rgb.blue)}`;
}
function escapeHtmlAttr(value) {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
// --- Table Conversion ---
function convertTable(table, options) {
    if (!table.tableRows || table.tableRows.length === 0) {
        return '';
    }
    // Detect code block tables (1x1 table with monospace font or gray background)
    if (isCodeBlockTable(table)) {
        return convertCodeBlockTable(table);
    }
    let markdown = '\n';
    let isFirstRow = true;
    for (const row of table.tableRows) {
        if (!row.tableCells)
            continue;
        let rowText = '|';
        for (const cell of row.tableCells) {
            const cellText = extractCellText(cell, options);
            rowText += ` ${cellText} |`;
        }
        markdown += rowText + '\n';
        // Add header separator after the first row
        if (isFirstRow) {
            let separator = '|';
            for (const cell of row.tableCells) {
                separator += ` ${tableAlignmentMarker(cell)} |`;
            }
            markdown += separator + '\n';
            isFirstRow = false;
        }
    }
    return markdown + '\n';
}
/**
 * Detects if a table is a code block (1x1 table with monospace font or gray background).
 * Google Docs "Code Block" building blocks are represented as styled 1x1 tables.
 */
function isCodeBlockTable(table) {
    // Must be a 1x1 table
    if (!table.tableRows || table.tableRows.length !== 1)
        return false;
    const row = table.tableRows[0];
    if (!row.tableCells || row.tableCells.length !== 1)
        return false;
    const cell = row.tableCells[0];
    // Check for gray/colored background on the cell
    const cellStyle = cell.tableCellStyle;
    if (cellStyle?.backgroundColor?.color?.rgbColor) {
        const bg = cellStyle.backgroundColor.color.rgbColor;
        // Detect light gray backgrounds (typical of code blocks)
        // Allow a range of light grays
        const r = bg.red ?? 0;
        const g = bg.green ?? 0;
        const b = bg.blue ?? 0;
        if (r > 0.85 && g > 0.85 && b > 0.85 && r < 1 && g < 1 && b < 1) {
            return true;
        }
    }
    // Check for monospace font in cell content
    if (cell.content) {
        for (const element of cell.content) {
            if (element.paragraph?.elements) {
                for (const pe of element.paragraph.elements) {
                    if (pe.textRun?.textStyle) {
                        if (isCodeStyled(pe.textRun.textStyle)) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    return false;
}
/**
 * Converts a code block table (1x1 table) to a fenced markdown code block.
 */
function convertCodeBlockTable(table) {
    const cell = table.tableRows[0].tableCells[0];
    let codeText = '';
    if (cell.content) {
        for (const element of cell.content) {
            if (element.paragraph?.elements) {
                for (const pe of element.paragraph.elements) {
                    if (pe.textRun?.content) {
                        codeText += pe.textRun.content;
                    }
                }
            }
        }
    }
    // Remove trailing newline (cells always end with one)
    if (codeText.endsWith('\n')) {
        codeText = codeText.slice(0, -1);
    }
    return '\n```\n' + codeText + '\n```\n\n';
}
function tableAlignmentMarker(cell) {
    const alignment = paragraphAlignmentToHtml(cell.content?.[0]?.paragraph?.paragraphStyle?.alignment);
    if (alignment === 'center')
        return ':---:';
    if (alignment === 'right')
        return '---:';
    return '---';
}
function extractCellText(cell, options) {
    let text = '';
    if (!cell.content)
        return text;
    for (const element of cell.content) {
        if (element.paragraph?.elements) {
            text += extractFormattedText(element.paragraph.elements, options).replace(/\n/g, ' ');
        }
    }
    return text.trim().replace(/\|/g, '\\|');
}
