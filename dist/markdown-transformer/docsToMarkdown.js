// src/markdown-transformer/docsToMarkdown.ts
/**
 * Font families used by the markdown-to-docs direction for code styling.
 * When these are detected on a text run, we render backtick code in markdown.
 */
const CODE_FONT_FAMILIES = new Set(['Roboto Mono', 'Courier New', 'Consolas', 'monospace']);
/**
 * Inspects the body content that replaceDocumentWithMarkdown will delete and
 * re-insert, and reports anything docsJsonToMarkdown cannot represent. Returns
 * an array of human-readable warning strings (empty if the content converts
 * losslessly). Call before replaceDocumentWithMarkdown to warn the AI about
 * what a body replacement will permanently lose.
 *
 * IMPORTANT — accuracy: every warning is derived from `bodyContent` itself,
 * i.e. the exact body (a specific tab's body in tab mode, the document body
 * otherwise) that the replacement mutates. This deliberately does NOT inspect
 * document-level `inlineObjects`/`footnotes` maps or `headers`/`footers`:
 *   - Global maps can include images/footnotes belonging to OTHER tabs, which a
 *     scoped replacement never touches, so counting them over-reports.
 *   - Headers and footers are separate document segments that a body-content
 *     replacement does not delete, so warning that they "will be removed" is
 *     simply wrong. They are intentionally not reported here.
 * Instead we count the inline-image and footnote references that actually live
 * in this body, which are the ones deleted along with it.
 *
 * @param {Array} bodyContent structural elements of the body being replaced
 *   (e.g. `contentSource.body.content`).
 * @returns {string[]} warnings
 */
export function checkMarkdownFidelity(bodyContent) {
    const warnings = [];
    let imageCount = 0;
    let footnoteCount = 0;
    let hasCustomColors = false;
    let hasNonDefaultAlignment = false;
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
            const style = pe.textRun?.textStyle;
            if (!style)
                continue;
            const fgRgb = style.foregroundColor?.color?.rgbColor;
            if (fgRgb && ((fgRgb.red ?? 0) > 0 || (fgRgb.green ?? 0) > 0 || (fgRgb.blue ?? 0) > 0)) {
                hasCustomColors = true;
            }
            const bgRgb = style.backgroundColor?.color?.rgbColor;
            if (bgRgb && ((bgRgb.red ?? 0) > 0 || (bgRgb.green ?? 0) > 0 || (bgRgb.blue ?? 0) > 0)) {
                hasCustomColors = true;
            }
        }
    }
    function scanBodyContent(content) {
        for (const element of content) {
            if (element.paragraph) {
                const alignment = element.paragraph.paragraphStyle?.alignment;
                if (alignment && alignment !== 'START' && alignment !== 'UNSPECIFIED') {
                    hasNonDefaultAlignment = true;
                }
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
        }
    }
    scanBodyContent(bodyContent ?? []);
    if (imageCount > 0) {
        warnings.push(`${imageCount} image(s) — will be removed`);
    }
    if (footnoteCount > 0) {
        warnings.push(`${footnoteCount} footnote(s) — will be removed`);
    }
    if (hasCustomColors) {
        warnings.push('Custom text/highlight colors — will be lost');
    }
    if (hasNonDefaultAlignment) {
        warnings.push('Non-default paragraph alignment (center/right/justified) — will be lost');
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
export function docsJsonToMarkdown(docData) {
    const body = docData.body;
    if (!body?.content) {
        return '';
    }
    const lists = docData.lists ?? {};
    let markdown = '';
    for (const element of body.content) {
        if (element.paragraph) {
            markdown += convertParagraph(element.paragraph, lists);
        }
        else if (element.table) {
            markdown += convertTable(element.table);
        }
        else if (element.sectionBreak) {
            markdown += '\n---\n\n';
        }
    }
    return markdown.trim();
}
// --- Paragraph Conversion ---
function convertParagraph(paragraph, lists) {
    // 1. Determine paragraph type
    const headingLevel = getHeadingLevel(paragraph);
    const listInfo = getListInfo(paragraph, lists);
    // 2. Extract text content with inline formatting
    const elements = paragraph.elements ?? [];
    const text = extractFormattedText(elements);
    // 3. Format based on type
    if (headingLevel && text.trim()) {
        const hashes = '#'.repeat(Math.min(headingLevel, 6));
        return `${hashes} ${text.trim()}\n\n`;
    }
    if (listInfo && text.trim()) {
        const indent = '  '.repeat(listInfo.nestingLevel);
        const marker = listInfo.ordered ? `1.` : `-`;
        return `${indent}${marker} ${text.trim()}\n`;
    }
    if (text.trim()) {
        return `${text.trim()}\n\n`;
    }
    return '\n';
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
    return { ordered, nestingLevel };
}
// --- Text Run Conversion ---
function extractFormattedText(elements) {
    let result = '';
    for (const element of elements) {
        if (element.textRun) {
            result += convertTextRun(element.textRun);
        }
    }
    return result;
}
function convertTextRun(textRun) {
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
    if (style.underline && !style.link) {
        formatted = `<u>${formatted}</u>`;
    }
    if (style.link?.url) {
        formatted = `[${formatted}](${style.link.url})`;
    }
    return formatted + (trailingNewline ? '\n' : '');
}
function isCodeStyled(style) {
    const fontFamily = style.weightedFontFamily?.fontFamily;
    return typeof fontFamily === 'string' && CODE_FONT_FAMILIES.has(fontFamily);
}
// --- Table Conversion ---
function convertTable(table) {
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
            const cellText = extractCellText(cell);
            rowText += ` ${cellText} |`;
        }
        markdown += rowText + '\n';
        // Add header separator after the first row
        if (isFirstRow) {
            let separator = '|';
            for (let i = 0; i < row.tableCells.length; i++) {
                separator += ' --- |';
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
function extractCellText(cell) {
    let text = '';
    if (!cell.content)
        return text;
    for (const element of cell.content) {
        if (element.paragraph?.elements) {
            for (const pe of element.paragraph.elements) {
                if (pe.textRun?.content) {
                    text += pe.textRun.content.replace(/\n/g, ' ').trim();
                }
            }
        }
    }
    return text;
}
