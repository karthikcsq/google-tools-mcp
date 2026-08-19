import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { createPatch } from 'diff';
import { getDocsClient, getDriveClient } from '../../clients.js';
import { DocumentIdParameter, NotImplementedError } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import { docsJsonToMarkdown, checkMarkdownFidelity } from '../../markdown-transformer/index.js';
import { trackRead, getLastReadContent } from '../../readTracker.js';
import { writeWorkspaceFile } from '../../workspace.js';
import { mintDocsReadHandle } from '../../docsHandles.js';

async function fetchModifiedTime(documentId) {
    try {
        const drive = await getDriveClient();
        const res = await drive.files.get({
            fileId: documentId,
            fields: 'modifiedTime',
            supportsAllDrives: true,
        });
        return res.data.modifiedTime || null;
    } catch {
        return null;
    }
}

export function register(server) {
    server.addTool({
        name: 'readDocument',
        description: "Reads the content of a Google Document. Returns markdown by default (formatted content suitable for editing and re-uploading with replaceDocumentWithMarkdown) and saves it to a local working-copy file (path included in the response). " +
            "PREFERRED EDITING WORKFLOW for large edits: (1) readDocument to get the local file path, (2) edit that file locally, (3) call replaceDocumentWithMarkdown with filePath pointing to it. This avoids inline content truncation and gives you a reviewable working copy before pushing changes. " +
            "If the document contains content markdown cannot represent (images, footnotes), a warning is appended listing what replaceDocumentWithMarkdown would permanently remove — prefer modifyText or appendMarkdown for those documents. " +
            "Use format='text' for plain text, or format='json' for the raw document structure. Set diffFromLastRead=true (markdown only) to get a unified diff from your previous read in this session instead of the full content.",
        parameters: DocumentIdParameter.extend({
            format: z
                .enum(['text', 'json', 'markdown'])
                .optional()
                .default('markdown')
                .describe("Output format: 'markdown' (formatted content), 'text' (plain text), 'json' (raw API structure, complex)."),
            maxLength: z
                .number()
                .optional()
                .describe('Maximum character limit for text output. If not specified, returns full document content. Use this to limit very large documents.'),
            tabId: z
                .string()
                .optional()
                .describe('The ID of the specific tab to read. If not specified, reads the first tab (or legacy document.body for documents without tabs).'),
            diffFromLastRead: z
                .boolean()
                .optional()
                .default(false)
                .describe('If true and this document has already been read in this session (with format=markdown), returns a unified diff from the previous read to the current document instead of the full content. Ignored on first read or when format is not markdown.'),
        }),
        execute: async (args, { log }) => {
            const docs = await getDocsClient();
            log.info(`Reading Google Doc: ${args.documentId}, Format: ${args.format}${args.tabId ? `, Tab: ${args.tabId}` : ''}`);
            try {
                // Determine if we need tabs content
                const needsTabsContent = !!args.tabId;
                const fields = args.format === 'json' || args.format === 'markdown'
                    ? '*' // Get everything for structure analysis
                    : 'revisionId,body(content(paragraph(elements(textRun(content)))))'; // Just text content
                const res = await docs.documents.get({
                    documentId: args.documentId,
                    includeTabsContent: needsTabsContent,
                    fields: needsTabsContent ? '*' : fields, // Get full document if using tabs
                });
                log.info(`Fetched doc: ${args.documentId}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);
                const modifiedTime = await fetchModifiedTime(args.documentId);
                // If tabId is specified, find the specific tab
                let contentSource;
                if (args.tabId) {
                    const targetTab = GDocsHelpers.findTabById(res.data, args.tabId);
                    if (!targetTab) {
                        throw publicError(`Tab with ID "${args.tabId}" not found in document.`);
                    }
                    if (!targetTab.documentTab) {
                        throw publicError(`Tab "${args.tabId}" does not have content (may not be a document tab).`);
                    }
                    // List definitions are scoped to the document tab. Without them,
                    // docsJsonToMarkdown cannot distinguish ordered lists from bullets.
                    contentSource = {
                        body: targetTab.documentTab.body,
                        lists: targetTab.documentTab.lists,
                    };
                    log.info(`Using content from tab: ${targetTab.tabProperties?.title || 'Untitled'}`);
                }
                else {
                    // Use the document body (backward compatible)
                    contentSource = res.data;
                }
                // On the SDK v2 runtime every successful read mints an explicit
                // capability bound to this principal/profile/epoch, this file
                // and tab, this revision, and this structural fingerprint. The
                // facade surfaces it as a top-level `readHandle` field on the
                // result for every format (plan §2), so nothing about the
                // returned text below changes. Off that runtime this is a no-op
                // and the legacy readTracker guard stays in force.
                const mintHandle = async (content) => {
                    try {
                        return await mintDocsReadHandle({
                            documentId: args.documentId,
                            tabId: args.tabId ?? null,
                            revisionId: res.data.revisionId ?? null,
                            contentSource,
                            content,
                        });
                    }
                    catch (handleError) {
                        // A read that cannot mint a capability still returns its
                        // content; the follow-up mutation then fails closed with
                        // "a read handle is required" rather than writing blind.
                        log.error(`Could not mint a read handle for ${args.documentId}: ${handleError.message}`);
                        return null;
                    }
                };
                if (args.format === 'json') {
                    if (args.diffFromLastRead) {
                        log.info('diffFromLastRead ignored: only supported for format=markdown');
                    }
                    trackRead(args.documentId, modifiedTime, undefined, res.data.revisionId);
                    const jsonContent = JSON.stringify(contentSource, null, 2);
                    await mintHandle(jsonContent);
                    // Apply length limit to JSON if specified
                    if (args.maxLength && jsonContent.length > args.maxLength) {
                        return (jsonContent.substring(0, args.maxLength) +
                            `\n... [JSON truncated: ${jsonContent.length} total chars]`);
                    }
                    return jsonContent;
                }
                if (args.format === 'markdown') {
                    const markdownContent = docsJsonToMarkdown(contentSource);
                    const totalLength = markdownContent.length;
                    log.info(`Generated markdown: ${totalLength} characters`);
                    // Derive fidelity warnings from EXACTLY the body that will be replaced
                    // (contentSource.body is the active tab's body in tab mode, the document
                    // body otherwise). This scopes image/footnote detection to the content
                    // the replacement mutates and never over-reports images or footnotes
                    // living in other tabs or in headers/footers a body replacement leaves
                    // untouched.
                    const fidelityWarnings = checkMarkdownFidelity(contentSource.body?.content);
                    const fidelityNotice = fidelityWarnings.length > 0
                        ? '\n\n---\n⚠️ FORMATTING LOSS WARNING: This document contains content that cannot be represented in markdown. Calling replaceDocumentWithMarkdown will permanently lose:\n' +
                            fidelityWarnings.map(w => `  • ${w}`).join('\n') +
                            '\nConsider using modifyText or appendMarkdown for targeted edits instead.\n---'
                        : '';
                    if (args.diffFromLastRead) {
                        const previous = getLastReadContent(args.documentId);
                        if (previous !== null) {
                            const patch = createPatch(
                                args.documentId,
                                previous,
                                markdownContent,
                                'last read',
                                'current',
                                { context: 3 }
                            );
                            trackRead(args.documentId, modifiedTime, markdownContent, res.data.revisionId);
                            // Keep the on-disk working copy in sync even on diff reads, so a
                            // subsequent edit-and-push starts from the current document state.
                            // On the v2 runtime that copy is this handle's own editable file
                            // (already written when the handle was minted); off it, the legacy
                            // shared per-(documentId, tabId) copy.
                            const diffHandle = await mintHandle(markdownContent);
                            if (!diffHandle) {
                                try {
                                    await writeWorkspaceFile(args.documentId, markdownContent, args.tabId);
                                } catch (e) {
                                    log.info(`Could not update workspace on diff read: ${e.message}`);
                                }
                            }
                            // The diff can be silent about content the converter has no
                            // representation for: an image or footnote another editor added
                            // since the last read simply is not in either markdown snapshot,
                            // so it never shows up as a change. The workspace file was still
                            // refreshed above, and pushing it back would delete that content.
                            // Carry the same warning the full read gives.
                            return patch + fidelityNotice;
                        }
                        log.info('diffFromLastRead requested but no prior snapshot exists; returning full content');
                    }
                    // Store clean markdown (without warning) for future diffs and guardMutation
                    trackRead(args.documentId, modifiedTime, markdownContent, res.data.revisionId);
                    // Save to local workspace file so the AI can edit it and push with filePath.
                    // Scoped by tabId so two tabs of the same document keep separate copies.
                    // On the v2 runtime this is a workspace unique to the handle
                    // just minted, initialized from a shared immutable baseline;
                    // two concurrent reads of identical content get two separate
                    // editable files. Off it, the legacy shared copy.
                    const readHandleResult = await mintHandle(markdownContent);
                    let localPath = readHandleResult?.editablePath ?? null;
                    if (!localPath) {
                        try {
                            localPath = await writeWorkspaceFile(args.documentId, markdownContent, args.tabId);
                        } catch (e) {
                            log.info(`Could not save to workspace: ${e.message}`);
                            localPath = null;
                        }
                    }
                    if (localPath) log.info(`Saved to ${localPath}`);
                    // Apply length limit to markdown if specified
                    let output;
                    if (args.maxLength && totalLength > args.maxLength) {
                        const truncatedContent = markdownContent.substring(0, args.maxLength);
                        output = `${truncatedContent}\n\n... [Markdown truncated to ${args.maxLength} chars of ${totalLength} total. Use maxLength parameter to adjust limit or remove it to get full content.]`;
                    } else {
                        output = markdownContent;
                    }
                    // Append fidelity warning after the markdown so the AI knows what
                    // replaceDocumentWithMarkdown would permanently destroy.
                    output += fidelityNotice;
                    if (localPath) {
                        // Use forward slashes in the advice string so the path is valid JSON
                        // regardless of OS (backslashes in Windows paths break JSON encoding).
                        const jsonSafePath = localPath.replace(/\\/g, '/');
                        // If this was a tab read, the file holds only that tab's content, so the
                        // push must target the same tab to avoid writing it into the wrong tab.
                        const tabAdvice = args.tabId ? ` tabId="${args.tabId}"` : '';
                        output += `\n\n📄 Local file: ${localPath}\nEdit this file, then call replaceDocumentWithMarkdown with filePath="${jsonSafePath}"${tabAdvice} to push changes.`;
                    }
                    return output;
                }
                // Default: Text format - extract all text content
                if (args.diffFromLastRead) {
                    log.info('diffFromLastRead ignored: only supported for format=markdown');
                }
                let textContent = '';
                let elementCount = 0;
                // Process all content elements from contentSource
                contentSource.body?.content?.forEach((element) => {
                    elementCount++;
                    // Handle paragraphs
                    if (element.paragraph?.elements) {
                        element.paragraph.elements.forEach((pe) => {
                            if (pe.textRun?.content) {
                                textContent += pe.textRun.content;
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
                                            textContent += pe.textRun.content;
                                        }
                                    });
                                });
                            });
                        });
                    }
                });
                trackRead(args.documentId, modifiedTime, undefined, res.data.revisionId);
                await mintHandle(textContent);
                if (!textContent.trim())
                    return 'Document found, but appears empty.';
                const totalLength = textContent.length;
                log.info(`Document contains ${totalLength} characters across ${elementCount} elements`);
                log.info(`maxLength parameter: ${args.maxLength || 'not specified'}`);
                // Apply length limit only if specified
                if (args.maxLength && totalLength > args.maxLength) {
                    const truncatedContent = textContent.substring(0, args.maxLength);
                    log.info(`Truncating content from ${totalLength} to ${args.maxLength} characters`);
                    return `Content (truncated to ${args.maxLength} chars of ${totalLength} total):\n---\n${truncatedContent}\n\n... [Document continues for ${totalLength - args.maxLength} more characters. Use maxLength parameter to adjust limit or remove it to get full content.]`;
                }
                // Return full content
                const fullResponse = `Content (${totalLength} characters):\n---\n${textContent}`;
                const responseLength = fullResponse.length;
                log.info(`Returning full content: ${responseLength} characters in response (${totalLength} content + ${responseLength - totalLength} metadata)`);
                return fullResponse;
            }
            catch (error) {
                log.error(`Error reading doc ${args.documentId}: ${error.message || error}`);
                log.error(`Error details: ${JSON.stringify(error.response?.data || error)}`);
                // Handle errors thrown by helpers or API directly
                if (isPublicError(error))
                    throw error;
                if (error instanceof NotImplementedError)
                    throw error;
                // Generic fallback for API errors not caught by helpers
                if (error.code === 404)
                    throw publicError(`Doc not found (ID: ${args.documentId}).`);
                if (error.code === 403) {
                    // The Docs API may be blocked by Workspace admin policy even when the Drive API is
                    // accessible. Fall back to drive.files.export() for plain-text format, which uses
                    // the Drive API and respects supportsAllDrives for Shared Drive documents.
                    if (!args.format || args.format === 'text') {
                        try {
                            log.info(`Docs API returned 403, falling back to Drive export for ${args.documentId}`);
                            const drive = await getDriveClient();
                            const exportRes = await drive.files.export({ fileId: args.documentId, mimeType: 'text/plain' }, { responseType: 'text' });
                            const textContent = exportRes.data;
                            if (!textContent?.trim())
                                return 'Document found, but appears empty.';
                            if (args.maxLength && textContent.length > args.maxLength) {
                                return `Content (truncated to ${args.maxLength} chars of ${textContent.length} total):\n---\n${textContent.substring(0, args.maxLength)}\n\n... [Document continues. Use maxLength parameter to adjust limit or remove it to get full content.]`;
                            }
                            return `Content (${textContent.length} characters):\n---\n${textContent}`;
                        }
                        catch (exportError) {
                            log.error(`Drive export fallback also failed: ${exportError.message}`);
                        }
                    }
                    throw publicError(`Permission denied for doc (ID: ${args.documentId}). The Google Docs API may be restricted by your Workspace admin.`);
                }
                // Extract detailed error information from Google API response
                const errorDetails = error.response?.data?.error?.message || error.message || 'Unknown error';
                const errorCode = error.response?.data?.error?.code || error.code;
throw wrapOperationError('read Google document', error, { status: error?.code });
            }
        },
    });
}
