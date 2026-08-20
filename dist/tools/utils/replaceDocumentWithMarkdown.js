// Whole-body markdown replace.
//
// --- What issue #88 added here (with #93 and #95) ---------------------------
//
// This tool's failure mode was never the text: it was everything the text diff
// does not show. Deleting the body and re-inserting it makes the Docs API treat
// the result as new content, so every unresolved comment anchored in the
// deleted range orphans and every `headingId` is regenerated, breaking every
// in-document link that pointed at a heading. Nothing looked at either before
// deleting.
//
// Three surfaces close that:
//   * `dryRun` — resolve the range, gather the collateral, return the
//     proposed-vs-current diff, and write NOTHING. No delete, no survivor
//     cleanup, no insert, no workspace mirror, no post-write heading fetch.
//   * `onCollateral` — the collateral is enumerated on every real call too, and
//     'block' turns it from a warning into a refusal.
//   * the post-write heading map — the new headingId of every heading, from a
//     narrow field mask, so a caller can repoint the links this call just broke
//     without a full JSON read (`insertMarkdown` returns request/timing
//     metadata only, so the ids genuinely have to be read back).
//
// The delete -> cleanup -> insert sequence still has its failure window: this
// is not a transactional replace. What changed is that a failure after the
// delete now names a recovery file holding the exact markdown that was being
// pushed, and says plainly that the document is partial. The shared workspace
// mirror is deliberately NOT that file — it must keep holding the last content
// that actually landed in the document, so a failed push never overwrites the
// caller's previous known-good copy.
import * as fs from 'fs/promises';
import * as path from 'path';
import { UserError, publicError, isPublicError, wrapOperationError } from '../../errors.js';
import { z } from 'zod';
import { createPatch } from 'diff';
import { getDocsClient, getDriveClient } from '../../clients.js';
import { DocumentIdParameter, MarkdownConversionError } from '../../types.js';
import * as GDocsHelpers from '../../googleDocsApiHelpers.js';
import { insertMarkdown, formatInsertResult, docsJsonToMarkdown } from '../../markdown-transformer/index.js';
import { guardMutation } from '../../readTracker.js';
import { ReadHandleParameter, beginDocsMutation } from '../../docsHandles.js';
import { fetchHeadingMap, gatherCollateral, formatCollateral } from '../../docsCollateral.js';
import {
    writeWorkspaceFile,
    getWorkspacePath,
    getWorkspaceDir,
    ensureSafeDirectory,
    writeFileSecurely,
} from '../../workspace.js';

const docUrlFor = (documentId) => `https://docs.google.com/document/d/${documentId}/edit`;

/** Cap on the diff carried in a response, so a large rewrite cannot flood the caller. */
const MAX_DIFF_CHARS = 20000;

/** Cap on headings listed inline in the post-write map. */
const MAX_HEADING_MAP_ENTRIES = 200;

/**
 * Write the markdown that was being pushed to a NEW file next to the workspace
 * mirror, for recovery after a partial write. Never the mirror itself: the
 * mirror's contract is "the last content that actually landed".
 */
async function writeRecoveryCopy(documentId, tabId, markdown) {
    const dir = getWorkspaceDir();
    await ensureSafeDirectory(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.basename(getWorkspacePath(documentId, tabId)).replace(/\.md$/, '');
    const file = path.join(dir, `${base}.recovery-${stamp}.md`);
    await writeFileSecurely(file, markdown);
    return file;
}

/** Tab-scoped source for docsJsonToMarkdown, or the whole document body. */
function scopeForMarkdown(data, tabId) {
    if (!tabId) return data;
    const tab = GDocsHelpers.findTabById(data, tabId);
    if (!tab?.documentTab) return null;
    return { body: tab.documentTab.body, lists: tab.documentTab.lists, inlineObjects: data.inlineObjects };
}

function clampDiff(patch) {
    if (!patch) return null;
    if (patch.length <= MAX_DIFF_CHARS) return patch;
    return `${patch.slice(0, MAX_DIFF_CHARS)}\n…[diff truncated at ${MAX_DIFF_CHARS} characters]\n`;
}

function renderHeadingMap(headings) {
    if (!headings || headings.length === 0) {
        return 'Post-write heading map: this document now has no headings.';
    }
    const shown = headings.slice(0, MAX_HEADING_MAP_ENTRIES);
    const lines = shown.map((h) => `  - level ${h.level} at ${h.startIndex}: "${h.text.slice(0, 80)}" -> ` +
        `${h.headingId ?? '(no headingId yet — Google Docs assigns one when the heading is first used as a link target)'}`);
    const more = headings.length > shown.length
        ? `\n  … and ${headings.length - shown.length} more (call listHeadings for the full outline).`
        : '';
    return `Post-write heading map (${headings.length} heading(s)) — use these ids to repoint any in-document links:\n${lines.join('\n')}${more}`;
}

export function register(server) {
    server.addTool({
        name: 'replaceDocumentWithMarkdown',
        description: "Best for rewriting entire sections or full documents. Replaces the entire document body with content parsed from markdown. " +
            "Supports headings, bold, italic, strikethrough, links, tables, bullet/numbered lists, and rich markdown HTML extensions for underline, color, highlight, font, alignment, and blockquotes. " +
            "Does not support markdown images or raw HTML outside those listed extensions; unsupported content is omitted and reported as warnings in the result. Use insertImage for images. " +
            "Use readDocument with format='markdown' first to get the current content, edit it, then call this tool to apply changes. " +
            "PREFERRED WORKFLOW for large edits: readDocument saves the content to a local working-copy file and returns its path — edit that file, then pass it here as filePath instead of inline markdown, to avoid truncation and get a reviewable diff before pushing. " +
            "DESTRUCTIVE METADATA WARNING: this rebuilds the whole body, which Google Docs treats as new content, so unresolved comments anchored in the replaced text lose their anchors and every headingId is regenerated, breaking in-document links that pointed at headings. " +
            "Both are enumerated before the delete and reported (onCollateral='block' refuses instead of warning), and the response carries the post-write heading map so links can be repointed. " +
            "Pass dryRun to see the proposed-vs-current unified diff and the full collateral list without writing anything. " +
            "For several small scattered edits, use batchModifyText — it edits in place in one atomic batch and costs no comment anchors or heading ids. " +
            "To rewrite ONE section instead of the whole body — keeping images, rules, and every other section untouched — use replaceRangeWithMarkdown, which builds the same structure inside a caller-chosen range. " +
            "For small single-location edits (one line or paragraph), use modifyText instead. " +
            "To add content without rewriting, use appendMarkdown. " +
            "Inserted text carries the document's default text color explicitly, when the document defines one.",
        parameters: DocumentIdParameter.extend({
            markdown: z.string().optional().describe('Inline markdown content. Prefer filePath instead for content longer than ~2000 characters — use the working-copy path returned by readDocument, edit that file, then pass it here.'),
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
            dryRun: z
                .boolean()
                .optional()
                .default(false)
                .describe('Preview only: returns the proposed-vs-current unified diff, the deletion summary, and the full comment/heading-link collateral list, and performs NO delete, no cleanup, no insert, and no workspace write.'),
            onCollateral: z
                .enum(['warn', 'block'])
                .optional()
                .default('warn')
                .describe("What to do when the replace would orphan unresolved comment anchors or break in-document heading links. 'warn' (default) proceeds and reports them; 'block' refuses and lists them. Under 'block', a collateral check that could not run (for example comments could not be listed) is also a refusal, since a check that did not run cannot clear anything."),
            expectedRevisionId: z
                .string()
                .optional()
                .describe('Optional compare-and-write assertion: the write is refused unless the read handle was issued for this revision. It is an assertion only, never authorization.'),
            readHandle: ReadHandleParameter,
        }),
        execute: async (args, { log }) => {
            const tabId = args.tabId ?? null;
            const dryRun = args.dryRun ?? false;
            const onCollateral = args.onCollateral ?? 'warn';
            const docs = await getDocsClient();
            const lease = await beginDocsMutation(args.documentId, {
                tabId,
                readHandle: args.readHandle,
                expectedRevisionId: args.expectedRevisionId ?? null,
                legacyGuard: () => guardMutation(args.documentId, {
                    contentFetcher: async () => {
                        const current = await docs.documents.get({ documentId: args.documentId });
                        // Return the revision this content came from alongside the
                        // content itself so guardMutation can refresh both together
                        // instead of leaving revisionId stale after a diff (see
                        // readTracker.js guardMutation for why that matters).
                        return { content: docsJsonToMarkdown(current.data), revisionId: current.data.revisionId };
                    },
                }),
            });
            // Resolve markdown content from filePath or inline parameter
            let markdown = args.markdown;
            if (args.filePath) {
                try {
                    markdown = await fs.readFile(args.filePath, 'utf-8');
                    log.info(`Read ${markdown.length} chars from file: ${args.filePath}`);
                } catch (err) {
                    // A local fs error message carries server-side absolute paths,
                    // so it stays an internal cause (matching appendToGoogleDoc).
                    await lease.abort();
                    throw wrapOperationError('read local markdown file', err, { code: err?.code });
                }
            }
            if (!markdown || markdown.length === 0) {
                // A pure input error must not burn the caller's read handle.
                await lease.abort();
                throw new UserError('Either markdown or filePath must be provided with non-empty content.');
            }
            log.info(`Replacing doc ${args.documentId} with markdown (${markdown.length} chars)${tabId ? ` in tab ${tabId}` : ''}`);
            // Set once the delete has landed: from that point a failure leaves a
            // partially rebuilt document, and the caller needs their content back.
            let deleteLanded = false;
            let wroteSomething = false;
            try {
                // The guard's authorized revision: the validated read handle's on
                // the v2 runtime, the tracked read's on the legacy one.
                const revisionId = lease.revisionId;
                // Optimistic-concurrency guard. The first write carries the revision
                // from our last read; each subsequent write advances to the revision the
                // previous write produced (returned by batchUpdate). This keeps every
                // write in the operation (delete → cleanup → insert) guarded against
                // concurrent edits instead of dropping the guard after the first write
                // (PR #42 review).
                const writeControlChain = GDocsHelpers.createWriteControlChain(revisionId);
                // 1. Get document structure
                const doc = await docs.documents.get({
                    documentId: args.documentId,
                    includeTabsContent: !!tabId,
                    fields: tabId ? 'tabs' : 'body(content(startIndex,endIndex))',
                });
                // 2. Calculate replacement range
                let startIndex = 1;
                let bodyContent;
                if (tabId) {
                    const targetTab = GDocsHelpers.findTabById(doc.data, tabId);
                    if (!targetTab) {
                        throw new UserError(`Tab with ID "${tabId}" not found in document.`);
                    }
                    if (!targetTab.documentTab) {
                        throw new UserError(`Tab "${tabId}" does not have content (may not be a document tab).`);
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
                const wholeBody = startIndex === 1;

                // 2b. Collateral, BEFORE anything destructive (issues #93, #95).
                //     Tab-scoped: a tabbed call must draw its comments-and-links
                //     picture from the tab being replaced, not the default body.
                const collateralNotes = [];
                let collateral = null;
                try {
                    const drive = await getDriveClient();
                    collateral = await gatherCollateral(docs, drive, args.documentId, { tabId, startIndex, endIndex });
                } catch (error) {
                    // getDriveClient itself failing (no Drive scope, for example)
                    // must not silently clear the check.
                    collateral = {
                        links: [],
                        comments: null,
                        commentScanError: 'a Drive client could not be obtained, so comments could not be listed.',
                        commentsTruncated: false,
                        structureScanError: null,
                    };
                    log.warn(`Collateral scan unavailable for ${args.documentId}: ${error?.message ?? error}`);
                }
                const formatted = formatCollateral({ ...collateral, wholeBody });
                if (collateral.structureScanError) {
                    formatted.lines.push(`Heading-link check UNAVAILABLE: ${collateral.structureScanError} ` +
                        'In-document links to headings may break silently.');
                }
                const scanUnavailable = Boolean(collateral.commentScanError || collateral.structureScanError);
                if (!formatted.hasCollateral && !scanUnavailable) {
                    collateralNotes.push('Collateral check: no unresolved comment anchors and no in-document heading ' +
                        'links are affected by this replace.');
                } else {
                    collateralNotes.push(...formatted.lines);
                }
                if (onCollateral === 'block' && (formatted.hasCollateral || scanUnavailable)) {
                    throw publicError(['This replace was refused because onCollateral is set to "block" and it would ' +
                        'damage metadata that is not visible in a text diff:',
                        ...formatted.lines,
                        "Re-run with onCollateral='warn' to accept this, use batchModifyText or replaceRangeWithMarkdown " +
                        'to edit in place instead, or resolve/move the affected comments first.'].join('\n'));
                }

                // 2c. Current markdown, for the proposed-vs-current diff. Its own
                //     fetch on purpose: the guard exposes no document snapshot
                //     (guardMutation only invokes its content fetcher after
                //     detecting a conflict, and never returns the content), and
                //     the structure fetch above carries indices only.
                let currentMarkdown = null;
                let diffNote = null;
                try {
                    const full = await docs.documents.get({
                        documentId: args.documentId,
                        includeTabsContent: !!tabId,
                    });
                    const source = scopeForMarkdown(full.data, tabId);
                    currentMarkdown = source ? docsJsonToMarkdown(source) : null;
                } catch (error) {
                    diffNote = 'The current content could not be re-read, so no diff is available for this call.';
                    log.warn(`Diff snapshot unavailable for ${args.documentId}: ${error?.message ?? error}`);
                }
                const patch = currentMarkdown === null
                    ? null
                    : clampDiff(createPatch(
                        `${args.documentId}${tabId ? ` (tab ${tabId})` : ''}`,
                        currentMarkdown,
                        markdown,
                        'current',
                        'proposed',
                        { context: 3 },
                    ));
                const deletionLine = endIndex > startIndex
                    ? `Deletion summary: ${endIndex - startIndex} character(s) of the ` +
                      `${tabId ? `tab "${tabId}"` : 'document body'} are deleted (range ${startIndex}-${endIndex})` +
                      `${args.preserveTitle ? ', preserving the first paragraph as the title' : ' — the entire body'}, ` +
                      `then replaced with ${markdown.length} characters of markdown.`
                    : `Deletion summary: the ${tabId ? `tab "${tabId}"` : 'document body'} is empty, so nothing is ` +
                      `deleted; ${markdown.length} characters of markdown are inserted.`;
                const docUrl = `https://docs.google.com/document/d/${args.documentId}/edit`;

                // 3. dryRun stops here, before ANY write.
                if (dryRun) {
                    await lease.abort();
                    return [
                        docUrl,
                        'DRY RUN — nothing was written. No delete, no cleanup, no insert, no local working copy.',
                        deletionLine,
                        '',
                        ...collateralNotes,
                        '',
                        diffNote ?? (patch
                            ? `--- DIFF (current → proposed) ---\n${patch}--- END DIFF ---`
                            : 'The proposed markdown is identical to the current content; this replace would change nothing.'),
                    ].filter((line) => line !== undefined).join('\n');
                }

                // 4. Delete existing content
                if (endIndex > startIndex) {
                    const deleteRange = { startIndex, endIndex };
                    if (tabId) {
                        deleteRange.tabId = tabId;
                    }
                    log.info(`Deleting content from index ${startIndex} to ${endIndex}`);
                    wroteSomething = true;
                    const deleteResult = await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [
                        {
                            deleteContentRange: { range: deleteRange },
                        },
                    ], writeControlChain.current);
                    writeControlChain.advance(deleteResult);
                    deleteLanded = true;
                    log.info(`Delete complete.`);
                }
                // 5. Clean the surviving trailing paragraph.
                //    deleteContentRange always leaves one trailing paragraph that cannot
                //    be deleted. If it has bullet list membership or text formatting from
                //    the old content, all subsequently inserted text inherits those
                //    properties, corrupting the new document. We strip both bullets and
                //    text styles from the survivor before inserting.
                {
                    // Re-read to get the survivor's endIndex (always a short document now)
                    const docAfterDelete = await docs.documents.get({
                        documentId: args.documentId,
                        includeTabsContent: !!tabId,
                        fields: tabId ? 'tabs' : 'body(content(startIndex,endIndex))',
                    });
                    let survivorContent;
                    if (tabId) {
                        const tab = GDocsHelpers.findTabById(docAfterDelete.data, tabId);
                        survivorContent = tab?.documentTab?.body?.content;
                    }
                    else {
                        survivorContent = docAfterDelete.data.body?.content;
                    }
                    const survivorEnd = survivorContent
                        ? survivorContent[survivorContent.length - 1].endIndex
                        : startIndex + 1;
                    const survivorRange = { startIndex, endIndex: survivorEnd };
                    if (tabId) {
                        survivorRange.tabId = tabId;
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
                    // This cleanup is the operation's first write when the delete step
                    // was skipped (empty document), so it must carry the current guard —
                    // otherwise it bumps the revision and the insert below fails with a
                    // spurious conflict against the revision from the read. Peek (don't
                    // advance yet): the cleanup is best-effort, and only a SUCCESSFUL
                    // cleanup changes the revision.
                    const cleanupWriteControl = writeControlChain.current;
                    try {
                        wroteSomething = true;
                        const cleanupResult = await GDocsHelpers.executeBatchUpdate(docs, args.documentId, cleanupRequests, cleanupWriteControl);
                        // Advance only after success, so the insert requires the revision
                        // the cleanup produced.
                        writeControlChain.advance(cleanupResult);
                        log.info(`Cleaned surviving paragraph (bullets + text style) at range ${startIndex}-${survivorEnd}`);
                    }
                    catch (e) {
                        // A revision conflict is a genuine concurrent edit — surface it
                        // instead of proceeding to clobber the document unguarded.
                        if (cleanupWriteControl && (e instanceof UserError || isPublicError(e)) && /changed since you last read/i.test(e.message)) {
                            throw e;
                        }
                        // Non-conflict failure: the cleanup did not modify the document,
                        // so the revision is unchanged and writeControlChain.current still
                        // guards the insert below (we deliberately did NOT advance it).
                        log.info(`Survivor cleanup skipped: ${e.message}`);
                    }
                }
                // 6. Convert markdown and insert (indices calculated for empty document)
                log.info(`Inserting markdown starting at index ${startIndex} (after delete, document should be empty)`);
                wroteSomething = true;
                const result = await insertMarkdown(docs, args.documentId, markdown, {
                    startIndex,
                    tabId: args.tabId,
                    firstHeadingAsTitle: args.firstHeadingAsTitle,
                    // Carries the current guard; insertMarkdown chains it across its own
                    // split batches so the whole insert stays guarded.
                    writeControl: writeControlChain.current,
                });
                // The insert landed: the document is whole again, so a later
                // failure is no longer a partial-document situation.
                deleteLanded = false;
                const debugSummary = formatInsertResult(result);
                log.info(debugSummary);
                // insertMarkdown chains the guard across its own internal split batches
                // and returns the final revision as batchUpdate.finalWriteControl; fold
                // that into our chain so trackMutation re-arms the guard against the
                // TRUE post-write revision instead of the pre-insert (delete/cleanup) one.
                writeControlChain.advance({ writeControl: result.batchUpdate?.finalWriteControl });
                // Settling the lease is deliberately NOT folded into the write:
                // creating the successor workspace can fail on its own, and that
                // is "your next handle is missing", not "your write failed".
                // Reporting it as a write failure would invite a retry that
                // applied this whole replace a second time.
                let successorWarning = null;
                try {
                    await lease.complete(writeControlChain.current?.requiredRevisionId);
                } catch (error) {
                    successorWarning = 'The document was replaced successfully, but a follow-on read handle could not be ' +
                        'issued for the new revision. Do NOT retry this call. Call readDocument again to get a fresh handle.';
                    log.error(`replaceDocumentWithMarkdown: lease.complete failed after a successful write on ` +
                        `${args.documentId}: ${error?.message ?? error}`);
                }
                // Mirror the pushed markdown to the local workspace only now that the
                // Docs mutation has actually succeeded and been tracked. Writing this
                // earlier (before the fetch/delete/cleanup/insert sequence above)
                // meant that if any of those steps failed, the local file held content
                // that was never committed to the document; worse, if the delete
                // succeeded but the insert failed, the workspace file would show the
                // full intended result while the document itself was left partial.
                // Scoped by tabId so it lines up with the per-tab file readDocument
                // created. Non-fatal: a failure to save the mirror doesn't undo an
                // already-successful Docs write, so we log and continue.
                // On the v2 runtime the working copy belongs to a handle, not to a
                // shared per-(documentId, tabId) path, and the handle that authorized
                // this write was just consumed -- so there is no shared mirror to keep.
                if (!args.filePath && !lease.active) {
                    try {
                        const workspacePath = await writeWorkspaceFile(args.documentId, markdown, args.tabId);
                        log.info(`Saved working copy to ${workspacePath}`);
                    } catch (e) {
                        log.info(`Could not save working copy: ${e.message}`);
                    }
                }
                // 7. Post-write heading map (issue #95). Narrow mask, so this is a
                //    fraction of a full read, and best-effort: the replace has
                //    already succeeded and must not be reported as failed because
                //    a convenience read did not come back.
                let headingMapText;
                try {
                    const { headings } = await fetchHeadingMap(docs, args.documentId, tabId);
                    headingMapText = renderHeadingMap(headings);
                } catch (error) {
                    headingMapText = 'Post-write heading map unavailable: the heading read after the write did not ' +
                        'complete. Call listHeadings to get the new heading ids.';
                    log.warn(`Post-write heading map failed for ${args.documentId}: ${error?.message ?? error}`);
                }
                const warningNote = result.warnings?.length
                    ? ` with ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'} (content dropped — see below)`
                    : '';
                return [
                    docUrl,
                    `Successfully replaced document content with ${markdown.length} characters of markdown${warningNote}.`,
                    ...(successorWarning ? ['', `WARNING: ${successorWarning}`] : []),
                    '',
                    ...collateralNotes,
                    '',
                    headingMapText,
                    '',
                    diffNote ?? (patch
                        ? `--- APPLIED DIFF (before → after) ---\n${patch}--- END DIFF ---`
                        : 'The pushed markdown matched the previous content; nothing changed.'),
                    '',
                    debugSummary,
                ].join('\n');
            }
            catch (error) {
                log.error(`Error replacing document with markdown: ${error.message}`);
                if (wroteSomething) {
                    // Settle as a failed write so a dirty per-handle workspace is
                    // retained for recovery rather than silently reclaimed.
                    await lease.fail();
                } else {
                    await lease.abort();
                }
                if (deleteLanded) {
                    // The body was deleted and the new content never landed. No
                    // silent data loss: name where the intended content is and
                    // state plainly that the document is partial.
                    let recovery = args.filePath
                        ? `your own file ${args.filePath}`
                        : null;
                    if (!recovery) {
                        try {
                            recovery = await writeRecoveryCopy(args.documentId, tabId, markdown);
                        } catch (recoveryError) {
                            log.warn(`Could not write recovery copy for ${args.documentId}: ${recoveryError?.message ?? recoveryError}`);
                        }
                    }
                    throw publicError('The old content was deleted but the new content did not land, so this document is ' +
                        'now PARTIAL — do not treat it as replaced. ' +
                        (isPublicError(error) || error instanceof UserError
                            ? `The step that failed reported: ${error.message} `
                            : 'The insert step did not complete. ') +
                        (recovery
                            ? `The markdown that was being pushed is saved at ${recovery}; re-read the document, then push it again. `
                            : 'The markdown that was being pushed could not be saved locally; re-send it from your own copy. ') +
                        docUrlFor(args.documentId));
                }
                if (error instanceof UserError || isPublicError(error) || error instanceof MarkdownConversionError) {
                    throw error;
                }
                throw wrapOperationError('apply markdown', error, { status: error?.code });
            }
        },
    });
}
