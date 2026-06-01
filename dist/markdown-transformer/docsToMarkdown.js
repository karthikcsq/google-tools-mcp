// src/markdown-transformer/docsToMarkdown.ts
/**
 * Font families used by the markdown-to-docs direction for code styling.
 * When these are detected on a text run, we render backtick code in markdown.
 */
const CODE_FONT_FAMILIES = new Set(['Roboto Mono', 'Courier New', 'Consolas', 'monospace']);
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
    let markdown = '';
    for (const element of body.content) {
        if (element.paragraph) {
            markdown += convertParagraph(element.paragraph, lists, conversionOptions);
        }
        else if (element.table) {
            markdown += convertTable(element.table, conversionOptions);
        }
        else if (element.sectionBreak) {
            if (isInitialDocumentSectionBreak(element)) {
                continue;
            }
            markdown += '\n---\n\n';
        }
    }
    return markdown.trim();
}
function isInitialDocumentSectionBreak(element) {
    return element.endIndex === 1 && element.startIndex === undefined;
}
// --- Paragraph Conversion ---
function convertParagraph(paragraph, lists, options) {
    // 1. Determine paragraph type
    const headingLevel = getHeadingLevel(paragraph);
    const listInfo = getListInfo(paragraph, lists);
    // 2. Extract text content with inline formatting
    const elements = paragraph.elements ?? [];
    const text = extractFormattedText(elements, options);
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
        const trimmed = text.trim();
        if (options.richMarkdown && isBlockquoteParagraph(paragraph)) {
            return `<blockquote>${trimmed}</blockquote>\n\n`;
        }
        const alignment = paragraphAlignmentToHtml(paragraph.paragraphStyle?.alignment);
        if (options.richMarkdown && alignment) {
            return `<p align="${alignment}">${trimmed}</p>\n\n`;
        }
        return `${trimmed}\n\n`;
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
