import * as fs from 'fs/promises';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getDocsClient } from '../../clients.js';
import { DocumentIdParameter, MarkdownConversionError } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import { insertMarkdown, formatInsertResult, docsJsonToMarkdown } from '../../markdown-transformer/index.js';
import { guardMutation, getLastReadRevisionId, trackMutation } from '../../readTracker.js';
export function register(server) {
    server.addTool({
        name: 'appendMarkdown',
        description: 'Best for adding new formatted content to the end of a document. ' +
            'Supports headings, bold, italic, strikethrough, links, tables, bullet/numbered lists, and rich markdown HTML extensions for underline, color, highlight, font, alignment, and blockquotes. ' +
            'Use this instead of appendText when you need formatting. ' +
            'To edit existing content, use modifyText (single-location) or replaceDocumentWithMarkdown (section/full rewrite).',
        parameters: DocumentIdParameter.extend({
            markdown: z.string().optional().describe('The markdown content to append. For content longer than ~2000 characters, prefer writing to a local file first and passing filePath instead.'),
            filePath: z.string().optional().describe('Path to a local markdown file to use as content. Takes precedence over the markdown parameter.'),
            addNewlineIfNeeded: z
                .boolean()
                .optional()
                .default(true)
                .describe('Add spacing before appended content if needed.'),
            tabId: z
                .string()
                .optional()
                .describe('The ID of the specific tab to append to. If not specified, appends to the first tab.'),
            firstHeadingAsTitle: z
                .boolean()
                .optional()
                .default(false)
                .describe('If true, the first H1 heading (# ...) in the markdown is styled as a Google Docs TITLE instead of Heading 1. Useful when the markdown represents a full document whose first line is the document title.'),
        }),
        execute: async (args, { log }) => {
            const docs = await getDocsClient();
            await guardMutation(args.documentId, {
                contentFetcher: async () => {
                    const current = await docs.documents.get({ documentId: args.documentId });
                    return docsJsonToMarkdown(current.data);
                },
            });
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
            log.info(`Appending markdown to doc ${args.documentId} (${markdown.length} chars)${args.tabId ? ` in tab ${args.tabId}` : ''}`);
            try {
                const revisionId = getLastReadRevisionId(args.documentId);
                // Optimistic-concurrency guard. The first write carries the revision
                // from our last read; each subsequent write advances to the revision the
                // previous write produced (returned by batchUpdate). This keeps every
                // write in the operation guarded against concurrent edits instead of
                // dropping the guard after the first write (PR #42 review).
                const writeControlChain = GDocsHelpers.createWriteControlChain(revisionId);
                // 1. Get document end index
                const doc = await docs.documents.get({
                    documentId: args.documentId,
                    includeTabsContent: !!args.tabId,
                    fields: args.tabId ? 'tabs' : 'body(content(endIndex))',
                });
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
                let startIndex = bodyContent[bodyContent.length - 1].endIndex - 1;
                log.info(`Document end index: ${startIndex}`);
                // 2. Add spacing if needed
                if (args.addNewlineIfNeeded && startIndex > 1) {
                    const location = { index: startIndex };
                    if (args.tabId) {
                        location.tabId = args.tabId;
                    }
                    const spacingResult = await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [
                        {
                            insertText: {
                                location,
                                text: '\n\n',
                            },
                        },
                    ], writeControlChain.current);
                    writeControlChain.advance(spacingResult);
                    startIndex += 2;
                    log.info(`Added spacing, new start index: ${startIndex}`);
                }
                // 3. Convert and append markdown
                const result = await insertMarkdown(docs, args.documentId, markdown, {
                    startIndex,
                    tabId: args.tabId,
                    firstHeadingAsTitle: args.firstHeadingAsTitle,
                    // Carries the current guard; insertMarkdown chains it across its own
                    // split batches so the whole insert stays guarded.
                    writeControl: writeControlChain.current,
                });
                const debugSummary = formatInsertResult(result);
                log.info(debugSummary);
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;
                // insertMarkdown chains the guard across its own internal split batches
                // and returns the final revision as batchUpdate.finalWriteControl; fold
                // that into our chain so trackMutation re-arms the guard against the
                // TRUE post-write revision instead of the pre-insert (spacing-only) one.
                writeControlChain.advance({ writeControl: result.batchUpdate?.finalWriteControl });
                trackMutation(args.documentId, writeControlChain.current?.requiredRevisionId);
                return `${docUrl}\nSuccessfully appended ${markdown.length} characters of markdown.\n\n${debugSummary}`;
            }
            catch (error) {
                log.error(`Error appending markdown: ${error.message}`);
                if (error instanceof UserError || error instanceof MarkdownConversionError) {
                    throw error;
                }
                throw new UserError(`Failed to append markdown: ${error.message}`);
            }
        },
    });
}
