export const name = 'meeting-notes-friction-loop-1';
export const goal = 'Turn raw meeting notes into a polished Google Doc, revise only its Next steps section, then summarize decisions in a formatted spreadsheet.';

function message(error) {
    return error?.message ?? String(error);
}

function parseResult(raw, tool) {
    if (typeof raw === 'object' && raw !== null) return raw;

    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new Error(`${tool} returned a result that was not the documented JSON shape: ${message(error)}`);
    }
}

export async function run(ctx) {
    ctx.note('Preflight discovery found tool names only. `help` returned the full README rather than per-tool parameter schemas, so every mutation shape below is a documented best guess. I did not inspect dist/ or tests/.');
    ctx.friction('help', 'Tool discovery exposed names only, while help returned the whole README instead of per-tool schemas or examples. I had to infer every mutation shape and retry the ones that were wrong.');

    const initialMarkdown = `# Atlas product launch meeting\n\n## Context\n\nThe launch team met to settle the scope, ownership, and customer communication plan for the Atlas beta.\n\n## Decisions\n\n| Decision | Owner | Due date |\n| --- | --- | --- |\n| Limit the beta to 40 design partners | Priya Shah | September 9 |\n| Ship the onboarding checklist before invitations | Mateo Ruiz | September 5 |\n| Publish weekly adoption metrics to the launch channel | Chloe Nguyen | September 12 |\n\n## Next steps\n\n- Priya will confirm the design-partner list.\n- Mateo will circulate the onboarding draft.\n- Chloe will define the weekly metric template.\n`;

    const doc = await ctx.createDoc(ctx.title('atlas-launch-notes'), initialMarkdown);
    ctx.note(`Created Google Doc ${doc.id}.`);

    // Attempt 1: README and workflows document this as the normal way to inspect
    // table structure and obtain range indices. Keep this failed attempt visible.
    const indexAttempt = await ctx.tryCall('readDocument', { documentId: doc.id, format: 'index' });
    if (!indexAttempt.ok) {
        ctx.friction('readDocument', `The documented format: "index" workflow failed with no parameter-specific remedy: ${message(indexAttempt.error)}`);
    } else {
        const index = parseResult(indexAttempt.result, 'readDocument');
        const table = index.elements?.find((element) => element.type === 'table');
        if (!table || table.rows !== 4 || table.columns !== 3) {
            ctx.friction('createDocument', 'The index response did not show the required native 4-by-3 decision table after Markdown creation. The Docs writing documentation does not say whether pipe tables are converted, so an agent would need to guess a second table-creation tool and schema.');
        } else {
            ctx.note('The decision table is a native 4-by-3 Docs table, including its header row.');
        }
    }

    const beforeMarkdownAttempt = await ctx.tryCall('readDocument', { documentId: doc.id, format: 'markdown' });
    if (!beforeMarkdownAttempt.ok) {
        ctx.friction('readDocument', `The Markdown read required before a Docs mutation failed: ${message(beforeMarkdownAttempt.error)}`);
        return;
    }
    const beforeMarkdown = beforeMarkdownAttempt.result;
    const beforeText = typeof beforeMarkdown === 'string' ? beforeMarkdown : JSON.stringify(beforeMarkdown);
    if (!beforeText.includes('| Decision | Owner | Due date |')) {
        ctx.friction('createDocument', 'The Markdown read did not retain the decision table in a recognizable form, so I could not verify the required table without the broken index format.');
    } else {
        ctx.note('The Markdown read retained the decision table with its header and three decision rows.');
    }

    // Attempt 3: the default Markdown response includes rich HTML spans, which
    // makes a byte comparison ambiguous. This option is a best guess from the
    // available Docs documentation, not an implementation lookup.
    const beforePlainAttempt = await ctx.tryCall('readDocument', {
        documentId: doc.id,
        format: 'markdown',
        plainMarkdown: true,
    });
    if (!beforePlainAttempt.ok) {
        ctx.friction('readDocument', `A plain-Markdown fallback for faithful comparison failed: ${message(beforePlainAttempt.error)}`);
    }

    // Attempt 2: public workflows say the section can be addressed semantically
    // when the index form is unavailable. Dry-run first, as the same workflow says.
    const revisionArgs = {
        documentId: doc.id,
        target: { afterHeading: 'Next steps' },
        markdown: '- Priya will send beta invitations after partner approval.\n- Mateo will publish the onboarding checklist and track completion.\n- Chloe will share the first adoption dashboard every Friday.\n',
        preserveHeading: true,
    };
    const revisionDryRun = await ctx.tryCall('replaceRangeWithMarkdown', { ...revisionArgs, dryRun: true });

    if (!revisionDryRun.ok) {
        ctx.friction('replaceRangeWithMarkdown', `The documented heading-addressed dry run failed: ${message(revisionDryRun.error)}`);
        return;
    }

    const revision = await ctx.tryCall('replaceRangeWithMarkdown', revisionArgs);

    if (!revision.ok) {
        ctx.friction('replaceRangeWithMarkdown', `The first section-replacement attempt used the only parameter names implied by the index documentation (documentId, startIndex, endIndex, markdown), but failed: ${message(revision.error)}`);
        return;
    }

    const afterMarkdown = await ctx.call('readDocument', { documentId: doc.id, format: 'markdown' });
    const afterText = typeof afterMarkdown === 'string' ? afterMarkdown : JSON.stringify(afterMarkdown);
    const sectionMarker = '## Next steps';
    const beforeSection = beforeText.indexOf(sectionMarker);
    const afterSection = afterText.indexOf(sectionMarker);

    if (beforeSection < 0 || afterSection < 0 || beforeText.slice(0, beforeSection) !== afterText.slice(0, afterSection)) {
        ctx.friction('replaceRangeWithMarkdown', 'The post-write Markdown read could not prove that all text before Next steps was byte-identical. A section-only write needs an explicit fidelity result instead of requiring callers to parse Markdown output themselves.');
    } else {
        ctx.note('The Markdown before Next steps was byte-identical before and after the targeted replacement.');
    }

    if (beforePlainAttempt.ok) {
        const afterPlainAttempt = await ctx.tryCall('readDocument', {
            documentId: doc.id,
            format: 'markdown',
            plainMarkdown: true,
        });
        if (!afterPlainAttempt.ok) {
            ctx.friction('readDocument', `The plain-Markdown post-write verification failed: ${message(afterPlainAttempt.error)}`);
        } else {
            const beforePlain = typeof beforePlainAttempt.result === 'string' ? beforePlainAttempt.result : JSON.stringify(beforePlainAttempt.result);
            const afterPlain = typeof afterPlainAttempt.result === 'string' ? afterPlainAttempt.result : JSON.stringify(afterPlainAttempt.result);
            const beforePlainSection = beforePlain.indexOf(sectionMarker);
            const afterPlainSection = afterPlain.indexOf(sectionMarker);
            if (beforePlainSection < 0 || afterPlainSection < 0 || beforePlain.slice(0, beforePlainSection) !== afterPlain.slice(0, afterPlainSection)) {
                ctx.friction('replaceRangeWithMarkdown', 'Even the plain-Markdown fallback could not prove that text outside Next steps remained byte-identical.');
            } else {
                ctx.note('Plain Markdown verified that every section before Next steps was byte-identical after the targeted rewrite.');
            }
        }
    }

    const sheetRaw = await ctx.call('createSpreadsheet', {
        title: ctx.title('atlas-decision-summary'),
        parentFolderId: ctx.folderId,
    });
    const sheet = parseResult(sheetRaw, 'createSpreadsheet');
    ctx.note(`Created spreadsheet ${sheet.id}.`);

    const rows = [
        ['Decision', 'Owner', 'Due date'],
        ['Limit beta to 40 design partners', 'Priya Shah', 'September 9'],
        ['Ship onboarding checklist before invitations', 'Mateo Ruiz', 'September 5'],
        ['Publish weekly adoption metrics', 'Chloe Nguyen', 'September 12'],
    ];
    const write = await ctx.tryCall('writeSpreadsheet', {
        spreadsheetId: sheet.id,
        range: 'A1:C4',
        values: rows,
    });

    if (!write.ok) {
        ctx.friction('writeSpreadsheet', `The standard create-then-write spreadsheet flow failed: ${message(write.error)}`);
        return;
    }

    const headerFormat = await ctx.tryCall('formatCells', {
        spreadsheetId: sheet.id,
        range: 'A1:C1',
        format: {
            backgroundColor: { red: 0.11, green: 0.23, blue: 0.43 },
            textFormat: {
                bold: true,
                foregroundColor: { red: 1, green: 1, blue: 1 },
            },
        },
    });

    if (!headerFormat.ok) {
        ctx.friction('formatCells', `The header-formatting attempt used the conventional Sheets API shape, but the discovery tools exposed no schema or example to validate it: ${message(headerFormat.error)}`);
        // Attempt 4: the schema error says a formatting option must be top-level,
        // but does not name it. A bold header is the smallest useful fallback.
        const boldHeaderFormat = await ctx.tryCall('formatCells', {
            spreadsheetId: sheet.id,
            range: 'A1:C1',
            bold: true,
        });
        if (!boldHeaderFormat.ok) {
            ctx.friction('formatCells', `The top-level bold fallback also failed: ${message(boldHeaderFormat.error)}`);
            return;
        }
    }

    const headerVerification = await ctx.tryCall('readCellFormat', {
        spreadsheetId: sheet.id,
        range: 'A1',
    });
    if (!headerVerification.ok) {
        ctx.friction('readCellFormat', `The obvious header-format read-back attempt failed, so formatCells success could not be independently verified: ${message(headerVerification.error)}`);
    } else {
        ctx.note('readCellFormat successfully read the formatted A1 header cell after the write.');
    }

    ctx.note('Wrote one spreadsheet row per decision and formatted the header row.');
}
