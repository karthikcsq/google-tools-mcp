import { publicError, isPublicError, wrapOperationError, getApiErrorDetail } from '../../errors.js';
import { z } from 'zod';
import { createPatch } from 'diff';
import { getDocsClient, getDriveClient } from '../../clients.js';
import { DocumentIdParameter, NotImplementedError } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import { docsJsonToMarkdown, checkMarkdownFidelity, detectLinkMismatches } from '../../markdown-transformer/index.js';
import { trackRead, getLastReadContent } from '../../readTracker.js';
import { writeWorkspaceFile, getWorkspacePath, backupIfLocallyModified } from '../../workspace.js';
import { mintDocsReadHandle } from '../../docsHandles.js';
import {
    DEFAULT_INDEX_MAX_RESPONSE_CHARS,
    INDEX_BODY_FIELDS,
    INDEX_TABS_FIELDS,
    serializeDocumentIndex,
} from '../../docsIndex.js';

// Style objects the Docs API echoes onto essentially every element by
// inheritance. `stripInheritedStyles` drops exactly these (plus the
// suggestion maps) from a format='json' response. `paragraphStyle` is
// deliberately kept: its `namedStyleType` is structural, not inherited noise.
// Nothing here carries a startIndex/endIndex, so pruning cannot move an index.
const INHERITED_STYLE_KEYS = new Set(['textStyle', 'documentStyle', 'namedStyles']);

function stripInheritedStyleKeys(value) {
    if (Array.isArray(value)) return value.map(stripInheritedStyleKeys);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
        if (INHERITED_STYLE_KEYS.has(key)) continue;
        if (key.startsWith('suggested')) continue;
        out[key] = stripInheritedStyleKeys(child);
    }
    return out;
}

// Writes the legacy shared mirror file for (documentId, tabId), backing up
// whatever is already on disk first if it looks like it holds an unpushed
// local edit (issue #122). Used by both the diffFromLastRead path and the
// full-content path below, which otherwise duplicated this exact sequence.
// Never throws for a backup failure — that is reported back to the caller as
// `backupError` instead, because a housekeeping step must never block the
// read that triggered it; an actual write failure DOES throw, same as before
// this existed, so callers keep their existing try/catch around this.
async function writeLegacyMirrorGuarded(documentId, tabId, content, log) {
    const targetPath = getWorkspacePath(documentId, tabId);
    const { backedUp, backupPath, backupError } = await backupIfLocallyModified(targetPath);
    if (backedUp) {
        log.info(`Local mirror at ${targetPath} had edits newer than this tool's last write to it; backed up to ${backupPath} before overwriting.`);
    }
    else if (backupError) {
        log.info(`Could not back up local mirror at ${targetPath} before overwriting: ${backupError}`);
    }
    const written = await writeWorkspaceFile(documentId, content, tabId);
    return { written, backedUp, backupPath };
}

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
            "Use format='text' for plain text, or format='index' to get a compact structural map (headings, list items and nesting, tables with per-cell indices) with the exact startIndex/endIndex every index-addressed tool needs. " +
            "format='index' is the cheap way to find indices: it fetches a narrow field mask instead of the whole document, so it stays affordable even for tabbed documents. format='json' returns the raw, unpruned API structure and is only for callers that genuinely need suggestions or style provenance. " +
            "Set diffFromLastRead=true (markdown only) to get a unified diff from your previous read in this session instead of the full content.",
        parameters: DocumentIdParameter.extend({
            format: z
                .enum(['text', 'json', 'markdown', 'index'])
                .optional()
                .default('markdown')
                .describe("Output format: 'markdown' (formatted content), 'text' (plain text), 'index' (compact structural map with character indices — use this to find indices for modifyText/deleteRange/insertTable), 'json' (raw API structure, large and unpruned)."),
            maxLength: z
                .number()
                .int()
                .positive()
                .optional()
                .describe('Maximum character limit for the returned content. Applies to text, markdown, and json output (not to index, which uses maxResponseChars and truncates at element boundaries). Must be a positive integer; omit it for the full document.'),
            fromIndex: z
                .number()
                .int()
                .nonnegative()
                .optional()
                .default(0)
                .describe("format='index' only. Resume point: elements ending at or before this document index are dropped. Pass the nextFromIndex from a truncated index response to get the next page. The Docs API has no start-index cursor, so each page costs another (narrow) fetch."),
            maxResponseChars: z
                .number()
                .int()
                .nonnegative()
                .optional()
                .describe("format='index' only. Character budget for the serialized index. Truncation lands on element boundaries so the JSON is always valid. 0 disables the budget. Defaults to 100000."),
            stripInheritedStyles: z
                .boolean()
                .optional()
                .default(false)
                .describe("format='json' only. If true, drops inherited textStyle/documentStyle/namedStyles and every suggested* map from the raw document. Every startIndex/endIndex is preserved. Off by default: format='json' means a faithful raw document."),
            tabId: z
                .string()
                .optional()
                .describe('The ID of the specific tab to read. If not specified, reads the first tab (or legacy document.body for documents without tabs).'),
            diffFromLastRead: z
                .boolean()
                .optional()
                .default(false)
                .describe('If true and this document has already been read in this session (with format=markdown), returns a unified diff from the previous read to the current document instead of the full content. Ignored on first read or when format is not markdown.'),
            plainMarkdown: z
                .boolean()
                .optional()
                .default(false)
                .describe('For Google Docs markdown output only. If true, suppresses rich HTML-style formatting extensions and returns cleaner portable markdown. ' +
                    'The local working-copy file and diff/conflict tracking always keep the rich version — for lossless editing, edit the working-copy file, not this plain text. ' +
                    'Ignored (with a note) when diffFromLastRead is true.'),
            writeLocalFile: z
                .boolean()
                .optional()
                .default(true)
                .describe("For Google Docs markdown output only (format='markdown'). If false, this read does not touch the on-disk local mirror file at all — no overwrite, no backup, response text is unaffected. " +
                    'Use this to run a diffFromLastRead staleness check (or any read you do not intend to edit locally) without risking the mirror. ' +
                    "When true (the default) and the SDK v2 runtime's per-handle capability system is not in play, this read overwrites the shared mirror at the path from a previous read of this document/tab; if that file's on-disk content is newer than this process's own last write to it (a local edit readDocument told you to make, still unpushed), it is backed up to '<path>.bak' first and the result says so — the overwrite still proceeds, so recover from the .bak file, not from a re-read."),
        }),
        execute: async (args, { log }) => {
            const docs = await getDocsClient();
            log.info(`Reading Google Doc: ${args.documentId}, Format: ${args.format}${args.tabId ? `, Tab: ${args.tabId}` : ''}`);
            try {
                // Determine if we need tabs content
                const needsTabsContent = !!args.tabId;
                // Index mode is the whole point of #105: it never falls back to
                // '*', not even for tabs, because the affordability claim is
                // about the *fetch*, not just the response we serialize.
                let fields;
                if (args.format === 'index') {
                    fields = needsTabsContent ? INDEX_TABS_FIELDS : INDEX_BODY_FIELDS;
                }
                else if (needsTabsContent || args.format === 'json' || args.format === 'markdown' || args.format === 'text') {
                    fields = '*'; // Get everything for structure analysis
                }
                else {
                    fields = 'revisionId,body(content(paragraph(elements(textRun(content)))))'; // Just text content
                }
                const res = await docs.documents.get({
                    documentId: args.documentId,
                    includeTabsContent: needsTabsContent,
                    fields,
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
                const mintHandle = async (content, projectionSource) => {
                    try {
                        return await mintDocsReadHandle({
                            documentId: args.documentId,
                            tabId: args.tabId ?? null,
                            revisionId: res.data.revisionId ?? null,
                            contentSource,
                            ...(projectionSource !== undefined && { projectionSource }),
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
                if (args.format === 'index') {
                    if (args.diffFromLastRead) {
                        log.info('diffFromLastRead ignored: only supported for format=markdown');
                    }
                    trackRead(args.documentId, modifiedTime, undefined, res.data.revisionId);
                    const { payload, text: indexContent } = serializeDocumentIndex(contentSource, {
                        tabId: args.tabId ?? null,
                        documentId: args.documentId,
                        revisionId: res.data.revisionId ?? null,
                        fromIndex: args.fromIndex ?? 0,
                        maxResponseChars: args.maxResponseChars ?? DEFAULT_INDEX_MAX_RESPONSE_CHARS,
                    });
                    log.info(`Index: ${payload.elementCount} of ${payload.totalElementCount} elements` +
                        `${payload.truncated ? ` (truncated, nextFromIndex=${payload.nextFromIndex ?? 'none'})` : ''}`);
                    // An index read is still a read: it authorizes the mutation
                    // that follows. The fingerprint comes from the same document
                    // JSON that produced the index above, so one fetch serves both.
                    await mintHandle(indexContent);
                    return indexContent;
                }
                if (args.format === 'json') {
                    if (args.diffFromLastRead) {
                        log.info('diffFromLastRead ignored: only supported for format=markdown');
                    }
                    const jsonSource = args.stripInheritedStyles
                        ? stripInheritedStyleKeys(contentSource)
                        : contentSource;
                    const jsonContent = JSON.stringify(jsonSource, null, 2);
                    // Emitting a megabyte of raw document because nobody set a
                    // limit is the failure #105 exists to remove. Fail with a
                    // directive instead, naming the read mode that completes.
                    if (!args.maxLength && jsonContent.length > DEFAULT_INDEX_MAX_RESPONSE_CHARS) {
                        throw publicError(
                            `The raw JSON for this document is ${jsonContent.length} characters, over the ` +
                            `${DEFAULT_INDEX_MAX_RESPONSE_CHARS}-character response budget. If you need character ` +
                            "indices, call readDocument with format='index' — it returns a compact structural map " +
                            'with the same startIndex/endIndex values for a fraction of the size. If you genuinely ' +
                            "need the raw document, re-run with maxLength set (and optionally stripInheritedStyles=true).",
                        );
                    }
                    trackRead(args.documentId, modifiedTime, undefined, res.data.revisionId);
                    await mintHandle(jsonContent);
                    // Apply length limit to JSON if specified
                    if (args.maxLength && jsonContent.length > args.maxLength) {
                        return (jsonContent.substring(0, args.maxLength) +
                            `\n... [JSON truncated: ${jsonContent.length} total chars]`);
                    }
                    return jsonContent;
                }
                if (args.format === 'markdown') {
                    // Default true (issue #122): compared with !== false, not truthiness,
                    // so an internal caller that invokes execute() directly and omits the
                    // field entirely (bypassing zod's own `.default(true)`) still gets the
                    // default behavior instead of silently skipping the local mirror write.
                    const writeLocalFile = args.writeLocalFile !== false;
                    // Canonical rich markdown. This is what mints the read handle,
                    // seeds the working-copy file, and feeds trackRead/diffing —
                    // never the plain variant, so a plainMarkdown=true read can never
                    // cause a later push to silently drop the document's existing
                    // colors/formatting.
                    const markdownContent = docsJsonToMarkdown(contentSource);
                    // The variant actually returned in the response text. Only this
                    // (and its length) is affected by plainMarkdown.
                    const responseMarkdown = args.plainMarkdown
                        ? docsJsonToMarkdown(contentSource, { plainMarkdown: true })
                        : markdownContent;
                    const totalLength = responseMarkdown.length;
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
                            '\nThis warning is about a WHOLE-BODY replacement. To rewrite one section while leaving that content ' +
                            'in place, use replaceRangeWithMarkdown: it builds the same markdown structure inside a chosen range ' +
                            'and checks fidelity only inside that range. For one line or paragraph of plain text, use modifyText.\n---'
                        : '';
                    // Issue #117: a link whose visible text is itself email- or
                    // URL-shaped but disagrees with its actual target. Every
                    // readable surface (this markdown, format='text', the doc
                    // itself) shows the CORRECT-looking display text, so nothing
                    // about reading the document catches a re-autolinked target —
                    // this is the one surface that compares the two.
                    const linkMismatches = detectLinkMismatches(contentSource.body?.content);
                    const linkMismatchNotice = linkMismatches.length > 0
                        ? '\n\n---\n⚠️ LINK MISMATCH: ' +
                            `${linkMismatches.length} link(s) whose target does not match their visible text:\n` +
                            linkMismatches.map((m) => `  • "${m.displayText}" → ${m.targetUrl}` +
                                (m.precedingWord ? `  (preceded by "${m.precedingWord}" — possible autolink boundary break)` : '')).join('\n') +
                            '\nfindAndReplace cannot fix these: it only changes visible text, not the link target, and will ' +
                            'report success while leaving the wrong target in place. Use modifyText with style.linkUrl to repair one.\n---'
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
                            // shared per-(documentId, tabId) copy — unless writeLocalFile=false,
                            // which exists precisely so a staleness check like this one can run
                            // without touching the mirror at all (issue #122).
                            let localMirrorNotice = '';
                            const diffHandle = await mintHandle(markdownContent);
                            if (diffHandle?.backedUp) {
                                localMirrorNotice = `\n\n---\nâš ï¸ LOCAL MIRROR CONFLICT: the working copy on disk had edits newer than this tool's ` +
                                    `last write to it (an unpushed local edit). It was backed up to ${diffHandle.backupPath.replace(/\\/g, '/')} before being ` +
                                    'overwritten with the current document content â€” recover any unpushed edits from that file.\n---';
                            }
                            else if (!diffHandle && writeLocalFile) {
                                try {
                                    const { backedUp, backupPath } = await writeLegacyMirrorGuarded(args.documentId, args.tabId, markdownContent, log);
                                    if (backedUp) {
                                        localMirrorNotice = `\n\n---\n⚠️ LOCAL MIRROR CONFLICT: the working copy on disk had edits newer than this tool's ` +
                                            `last write to it (an unpushed local edit). It was backed up to ${backupPath.replace(/\\/g, '/')} before being ` +
                                            'overwritten with the current document content — recover any unpushed edits from that file.\n---';
                                    }
                                } catch (e) {
                                    log.info(`Could not update workspace on diff read: ${e.message}`);
                                }
                            }
                            else if (!diffHandle) {
                                log.info('writeLocalFile=false: left the local mirror file untouched for this diff read.');
                            }
                            // The diff can be silent about content the converter has no
                            // representation for: an image or footnote another editor added
                            // since the last read simply is not in either markdown snapshot,
                            // so it never shows up as a change. The workspace file was still
                            // refreshed above, and pushing it back would delete that content.
                            // Carry the same warning the full read gives.
                            const plainMarkdownIgnoredNotice = args.plainMarkdown
                                ? '\n\n---\nNote: plainMarkdown was ignored for this diff. Diffs are always computed from rich markdown so they stay comparable across reads regardless of flag usage.\n---'
                                : '';
                            return patch + plainMarkdownIgnoredNotice + fidelityNotice + linkMismatchNotice + localMirrorNotice;
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
                    let localMirrorNotice = '';
                    if (readHandleResult?.backedUp) {
                        localMirrorNotice = `\n\n---\nâš ï¸ LOCAL MIRROR CONFLICT: the working copy on disk had edits newer than this tool's ` +
                            `last write to it (an unpushed local edit). It was backed up to ${readHandleResult.backupPath.replace(/\\/g, '/')} before being ` +
                            'overwritten with the current document content â€” recover any unpushed edits from that file.\n---';
                    }
                    else if (!localPath && writeLocalFile) {
                        try {
                            const written = await writeLegacyMirrorGuarded(args.documentId, args.tabId, markdownContent, log);
                            localPath = written.written;
                            if (written.backedUp) {
                                localMirrorNotice = `\n\n---\n⚠️ LOCAL MIRROR CONFLICT: the working copy on disk had edits newer than this tool's ` +
                                    `last write to it (an unpushed local edit). It was backed up to ${written.backupPath.replace(/\\/g, '/')} before being ` +
                                    'overwritten with the current document content — recover any unpushed edits from that file.\n---';
                            }
                        } catch (e) {
                            log.info(`Could not save to workspace: ${e.message}`);
                            localPath = null;
                        }
                    }
                    else if (!localPath) {
                        log.info('writeLocalFile=false: skipped writing the local mirror file for this read.');
                    }
                    if (localPath) log.info(`Saved to ${localPath}`);
                    // Apply length limit to markdown if specified. Computed against
                    // responseMarkdown (the variant actually returned below), not the
                    // rich canonical markdownContent, so a plainMarkdown response is
                    // never truncated against a length longer than what it received.
                    let output;
                    if (args.maxLength && totalLength > args.maxLength) {
                        const truncatedContent = responseMarkdown.substring(0, args.maxLength);
                        output = `${truncatedContent}\n\n... [Markdown truncated to ${args.maxLength} chars of ${totalLength} total. Use maxLength parameter to adjust limit or remove it to get full content.]`;
                    } else {
                        output = responseMarkdown;
                    }
                    // Append fidelity warning after the markdown so the AI knows what
                    // replaceDocumentWithMarkdown would permanently destroy.
                    output += fidelityNotice;
                    output += linkMismatchNotice;
                    output += localMirrorNotice;
                    if (localPath) {
                        // Use forward slashes in the advice string so the path is valid JSON
                        // regardless of OS (backslashes in Windows paths break JSON encoding).
                        const jsonSafePath = localPath.replace(/\\/g, '/');
                        // If this was a tab read, the file holds only that tab's content, so the
                        // push must target the same tab to avoid writing it into the wrong tab.
                        const tabAdvice = args.tabId ? ` tabId="${args.tabId}"` : '';
                        const richFileNote = args.plainMarkdown
                            ? ' Note: the text above is the plain variant (plainMarkdown=true), but this local file always holds the rich version — edit the file, not the text above, for lossless round-trip editing.'
                            : '';
                        output += `\n\n📄 Local file: ${localPath}\nEdit this file, then call replaceDocumentWithMarkdown with filePath="${jsonSafePath}"${tabAdvice} to push changes.${richFileNote}`;
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
                // A text-format read still authorizes a later mutation. Keep a
                // canonical body snapshot for the stale guard even though the
                // caller asked to receive plain text: Drive title changes move
                // modifiedTime but do not alter this body representation.
                trackRead(args.documentId, modifiedTime, docsJsonToMarkdown(contentSource), res.data.revisionId);
                // Text reads retain a complete body snapshot for the legacy
                // stale guard, but do not expose indexed structure through the
                // read handle. A later index-based edit must still re-read in
                // index or markdown mode before range precision can authorize it.
                await mintHandle(textContent, { body: { content: [] } });
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
                // The Docs API's own description of the failure, plus its
                // structured numeric code. Both are validated upstream fields;
                // the thrown object's own message is never used.
                const detail = getApiErrorDetail(error);
                if (!detail) throw wrapOperationError('read Google document', error, { status: error?.code });
                throw publicError(
                    `Failed to read doc: ${detail.description}${detail.code ? ` (Code: ${detail.code})` : ''}`
                );
            }
        },
    });
}
