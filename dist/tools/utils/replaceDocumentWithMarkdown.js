import * as fs from 'fs/promises';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDocsClient } from '../../clients.js';
import { DocumentIdParameter, MarkdownConversionError } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import { insertMarkdown, formatInsertResult } from '../../markdown-transformer/index.js';
import { guardMutation, trackMutation } from '../../readTracker.js';
export function register(server) {
    server.addTool({
        name: 'replaceDocumentWithMarkdown',
        description: "Best for rewriting entire sections or full documents. Replaces the entire document body with content parsed from markdown. " +
            "Supports headings, bold, italic, strikethrough, links, and bullet/numbered lists. " +
            "Use readDocument with format='markdown' first to get the current content, edit it, then call this tool to apply changes. " +
            "For small single-location edits (one line or paragraph), use modifyText instead. " +
            "To add content without rewriting, use appendMarkdown.",
        parameters: DocumentIdParameter.extend({
            markdown: z.string().optional().describe('The markdown content to apply to the document. For content longer than ~2000 characters, prefer writing to a local file first and passing filePath instead.'),
            filePath: z.string().optional().describe('Path to a local markdown file to use as content. Takes precedence over the markdown parameter. Use this for large documents to avoid truncation.'),
            preserveTitle: z
                .boolean()
                .optional()
                .default(false)
                .describe('If true, preserves the first heading/title and replaces content after it.'),
            tabId: z
                .string()
                .optional()
                .describe('The ID of the specific tab to replace content in. If not specified, replaces content in the first tab.'),
            firstHeadingAsTitle: z
                .boolean()
                .optional()
                .default(true)
                .describe('If true (default), the first H1 heading (# ...) in the markdown is styled as a Google Docs TITLE instead of Heading 1. Useful when the markdown represents a full document whose first line is the document title. Set to false if the first H1 should remain a Heading 1.'),
        }),
        execute: async (args, { log }) => {
            await guardMutation(args.documentId);
            const docs = await getDocsClient();
            // Resolve markdown content from filePath or inline parameter
            let markdown = args.markdown;
            if (args.filePath) {
                try {
                    markdown = await fs.readFile(args.filePath, 'utf-8');
                    log.info(`Read ${markdown.length} chars from file: ${args.filePath}`);
                } catch (err) {
                    throw new UserError(`Failed to read file at "${args.filePath}": ${err.message}`);
                }
            }
            if (!markdown || markdown.length === 0) {
                throw new UserError('Either markdown or filePath must be provided with non-empty content.');
            }
            log.info(`Replacing doc ${args.documentId} with markdown (${markdown.length} chars)${args.tabId ? ` in tab ${args.tabId}` : ''}`);
            try {
                // 1. Get document structure
                const doc = await docs.documents.get({
                    documentId: args.documentId,
                    includeTabsContent: !!args.tabId,
                    fields: args.tabId ? 'tabs' : 'body(content(startIndex,endIndex))',
                });
                // 2. Calculate replacement range
                let startIndex = 1;
                let bodyContent;
                if (args.tabId) {
                    const targetTab = GDocsHelpers.findTabById(doc.data, args.tabId);
                    if (!targetTab) {
                        throw new UserError(`Tab with ID "${args.tabId}" not found in document.`);
                    }
                    if (!targetTab.documentTab) {
                        throw new UserError(`Tab "${args.tabId}" does not have content (may not be a document tab).`);
                    }
                    bodyContent = targetTab.documentTab.body?.content;
                }
                else {
                    bodyContent = doc.data.body?.content;
                }
                if (!bodyContent) {
                    throw new UserError('No content found in document/tab');
                }
                let endIndex = bodyContent[bodyContent.length - 1].endIndex - 1;
                if (args.preserveTitle) {
                    // Find first content element that's a heading or paragraph
                    for (const element of bodyContent) {
                        if (element.paragraph && element.endIndex) {
                            startIndex = element.endIndex;
                            break;
                        }
                    }
                }
                // 3. Delete existing content
                if (endIndex > startIndex) {
                    const deleteRange = { startIndex, endIndex };
                    if (args.tabId) {
                        deleteRange.tabId = args.tabId;
                    }
                    log.info(`Deleting content from index ${startIndex} to ${endIndex}`);
                    await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [
                        {
                            deleteContentRange: { range: deleteRange },
                        },
                    ]);
                    log.info(`Delete complete.`);
                }
                // 4. Clean the surviving trailing paragraph.
                //    deleteContentRange always leaves one trailing paragraph that cannot
                //    be deleted. If it has bullet list membership or text formatting from
                //    the old content, all subsequently inserted text inherits those
                //    properties, corrupting the new document. We strip both bullets and
                //    text styles from the survivor before inserting.
                {
                    // Re-read to get the survivor's endIndex (always a short document now)
                    const docAfterDelete = await docs.documents.get({
                        documentId: args.documentId,
                        includeTabsContent: !!args.tabId,
                        fields: args.tabId ? 'tabs' : 'body(content(startIndex,endIndex))',
                    });
                    let survivorContent;
                    if (args.tabId) {
                        const tab = GDocsHelpers.findTabById(docAfterDelete.data, args.tabId);
                        survivorContent = tab?.documentTab?.body?.content;
                    }
                    else {
                        survivorContent = docAfterDelete.data.body?.content;
                    }
                    const survivorEnd = survivorContent
                        ? survivorContent[survivorContent.length - 1].endIndex
                        : startIndex + 1;
                    const survivorRange = { startIndex, endIndex: survivorEnd };
                    if (args.tabId) {
                        survivorRange.tabId = args.tabId;
                    }
                    const cleanupRequests = [
                        { deleteParagraphBullets: { range: survivorRange } },
                        {
                            updateTextStyle: {
                                range: survivorRange,
                                textStyle: {
                                    underline: false,
                                    bold: false,
                                    italic: false,
                                    strikethrough: false,
                                    foregroundColor: {},
                                    backgroundColor: {},
                                },
                                fields: 'underline,bold,italic,strikethrough,foregroundColor,backgroundColor',
                            },
                        },
                    ];
                    try {
                        await GDocsHelpers.executeBatchUpdate(docs, args.documentId, cleanupRequests);
                        log.info(`Cleaned surviving paragraph (bullets + text style) at range ${startIndex}-${survivorEnd}`);
                    }
                    catch (e) {
                        log.info(`Survivor cleanup skipped: ${e.message}`);
                    }
                }
                // 5. Convert markdown and insert (indices calculated for empty document)
                log.info(`Inserting markdown starting at index ${startIndex} (after delete, document should be empty)`);
                const result = await insertMarkdown(docs, args.documentId, markdown, {
                    startIndex,
                    tabId: args.tabId,
                    firstHeadingAsTitle: args.firstHeadingAsTitle,
                });
                const debugSummary = formatInsertResult(result);
                log.info(debugSummary);
                trackMutation(args.documentId);
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                return `${docUrl}\nSuccessfully replaced document content with ${markdown.length} characters of markdown.\n\n${debugSummary}`;
            }
            catch (error) {
                log.error(`Error replacing document with markdown: ${error.message}`);
                if (error instanceof UserError || error instanceof MarkdownConversionError) {
                    throw error;
                }
                throw new UserError(`Failed to apply markdown: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
