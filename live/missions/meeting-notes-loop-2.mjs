export const name = 'meeting-notes-loop-2';
export const goal = 'Turn raw meeting notes into a polished Google Doc, revise only its Next steps section, and create a formatted decision-summary spreadsheet.';

const decisions = [
    ['Approve a staged launch', 'Mina Patel', 'Limits support risk while retaining the October release window.'],
    ['Publish the migration guide first', 'Jon Bell', 'Gives pilot teams a self-service path before invitations go out.'],
    ['Measure activation at day seven', 'Sara Lee', 'Captures whether the new onboarding sequence changes early adoption.'],
];

function decode(raw) {
    if (typeof raw !== 'string') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

function asText(raw) {
    const parsed = decode(raw);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed.markdown === 'string') return parsed.markdown;
    if (parsed && typeof parsed.content === 'string') return parsed.content;
    return JSON.stringify(parsed);
}

function withoutNextSteps(markdown) {
    const heading = /^## Next steps\s*\n/im;
    const match = heading.exec(markdown);
    if (!match) throw new Error('Could not locate the Next steps section in the document read-back.');

    const nextHeading = /^##\s+/gim;
    nextHeading.lastIndex = match.index + match[0].length;
    const following = nextHeading.exec(markdown);
    const end = following ? following.index : markdown.length;
    return `${markdown.slice(0, match.index)}<NEXT-STEPS-ELIDED>${markdown.slice(end)}`;
}

export async function run(ctx) {
    const originalMarkdown = `# Atlas Launch Readout

## Context

The Atlas launch working group met on September 1 to set the pilot plan, documentation sequence, and first activation metric.

## Decisions

| Decision | Owner | Rationale |
| --- | --- | --- |
| Approve a staged launch | Mina Patel | Limits support risk while retaining the October release window. |
| Publish the migration guide first | Jon Bell | Gives pilot teams a self-service path before invitations go out. |
| Measure activation at day seven | Sara Lee | Captures whether the new onboarding sequence changes early adoption. |

## Action items

- Mina will publish the staged-launch cohort criteria by September 5.
- Jon will circulate the migration guide for support review by September 8.
- Sara will add the day-seven activation chart to the weekly dashboard.

## Next steps

1. Confirm the pilot cohort on Friday.
2. Send the launch checklist to the support team.
`;

    let doc = await ctx.createDoc(ctx.title('Atlas launch meeting notes'), originalMarkdown);
    ctx.note(`Created Google Doc ${doc.id} in the sandbox folder with a title, heading hierarchy, introduction, decisions table, action list, and Next steps section.`);

    let beforeRevision = asText(await ctx.call('readDocument', {
        documentId: doc.id,
        format: 'markdown',
    }));

    const revisedNextSteps = `1. Mina will confirm the 25-person pilot cohort by September 5.
2. Jon will send the launch checklist and migration guide to Support by September 8.
3. Sara will review the first day-seven activation results at the September 15 check-in.
`;

    const sectionTarget = { afterHeading: 'Next steps' };
    // First attempt deliberately follows the public example, which does not say whether
    // preserveHeading defaults to true. Keep this attempt to expose its actual behavior.
    const defaultPreview = await ctx.tryCall('replaceRangeWithMarkdown', {
        documentId: doc.id,
        target: sectionTarget,
        markdown: revisedNextSteps,
        dryRun: true,
    });
    if (!defaultPreview.ok) {
        ctx.friction('replaceRangeWithMarkdown', `The documented section-rewrite preview failed: ${defaultPreview.error?.message}`);
        throw defaultPreview.error;
    }

    const defaultRewrite = await ctx.tryCall('replaceRangeWithMarkdown', {
        documentId: doc.id,
        target: sectionTarget,
        markdown: revisedNextSteps,
    });
    if (!defaultRewrite.ok) {
        ctx.friction('replaceRangeWithMarkdown', `The documented section rewrite failed after a successful preview: ${defaultRewrite.error?.message}`);
        throw defaultRewrite.error;
    }

    const afterDefaultRevision = asText(await ctx.call('readDocument', {
        documentId: doc.id,
        format: 'markdown',
    }));
    let defaultAttemptKeptHeading = false;
    try {
        defaultAttemptKeptHeading = withoutNextSteps(beforeRevision) === withoutNextSteps(afterDefaultRevision);
    } catch {
        defaultAttemptKeptHeading = false;
    }
    if (!defaultAttemptKeptHeading) {
        ctx.friction('replaceRangeWithMarkdown', 'The public example omits preserveHeading and does not document its default. The first successful rewrite removed the Next steps heading, so the agent had to create a fresh document and retry with preserveHeading: true.');
        doc = await ctx.createDoc(ctx.title('Atlas launch meeting notes, explicit heading preservation'), originalMarkdown);
        ctx.note(`Created replacement Google Doc ${doc.id} after the undocumented heading-preservation default removed the target heading.`);
        beforeRevision = asText(await ctx.call('readDocument', {
            documentId: doc.id,
            format: 'markdown',
        }));

        // Second attempt: the documented explicit option still replaces the heading.
        // Keep it as a separate live probe before falling back to an index-addressed range.
        const explicitPreview = await ctx.tryCall('replaceRangeWithMarkdown', {
            documentId: doc.id,
            target: sectionTarget,
            markdown: revisedNextSteps,
            preserveHeading: true,
            dryRun: true,
        });
        if (!explicitPreview.ok) {
            ctx.friction('replaceRangeWithMarkdown', `The explicit preserveHeading preview failed: ${explicitPreview.error?.message}`);
            throw explicitPreview.error;
        }

        const explicitRewrite = await ctx.tryCall('replaceRangeWithMarkdown', {
            documentId: doc.id,
            target: sectionTarget,
            markdown: revisedNextSteps,
            preserveHeading: true,
        });
        if (!explicitRewrite.ok) {
            ctx.friction('replaceRangeWithMarkdown', `The explicit preserveHeading rewrite failed: ${explicitRewrite.error?.message}`);
            throw explicitRewrite.error;
        }

        const afterExplicitRevision = asText(await ctx.call('readDocument', {
            documentId: doc.id,
            format: 'markdown',
        }));
        let explicitAttemptKeptHeading = false;
        try {
            explicitAttemptKeptHeading = withoutNextSteps(beforeRevision) === withoutNextSteps(afterExplicitRevision);
        } catch {
            explicitAttemptKeptHeading = false;
        }
        if (!explicitAttemptKeptHeading) {
            ctx.friction('replaceRangeWithMarkdown', 'replaceRangeWithMarkdown returned success even with preserveHeading: true, but its Markdown read-back still lacked the Next steps heading. The agent had to abandon heading addressing and compute an explicit content-only range.');
            doc = await ctx.createDoc(ctx.title('Atlas launch meeting notes, explicit content range'), originalMarkdown);
            ctx.note(`Created final Google Doc ${doc.id} for an index-addressed content-only rewrite.`);
            beforeRevision = asText(await ctx.call('readDocument', {
                documentId: doc.id,
                format: 'markdown',
            }));

            const structure = decode(await ctx.call('readDocument', {
                documentId: doc.id,
                format: 'index',
            }));
            const heading = structure?.elements?.find((element) => (
                element.type === 'heading' && element.preview?.toLowerCase() === 'next steps'
            ));
            if (!heading || !Number.isInteger(heading.end) || !Number.isInteger(structure.documentEnd)) {
                throw new Error('The documented index read did not expose a usable Next steps heading range.');
            }
            const followingHeading = structure.elements.find((element) => (
                element.type === 'heading' && element.start >= heading.end && element.level <= heading.level
            ));
            const contentOnlyTarget = {
                startIndex: heading.end,
                endIndex: followingHeading?.start ?? structure.documentEnd,
            };

            let resolvedContentOnlyTarget = contentOnlyTarget;
            const rangePreview = await ctx.tryCall('replaceRangeWithMarkdown', {
                documentId: doc.id,
                target: contentOnlyTarget,
                markdown: revisedNextSteps,
                dryRun: true,
            });
            if (!rangePreview.ok) {
                ctx.friction('replaceRangeWithMarkdown', `The index-addressed preview rejected documentEnd even though the public index-read documentation says its ranges can be handed straight to mutations: ${rangePreview.error?.message}`);
                const onePastEndTarget = {
                    ...contentOnlyTarget,
                    endIndex: contentOnlyTarget.endIndex - 1,
                };
                const adjustedPreview = await ctx.tryCall('replaceRangeWithMarkdown', {
                    documentId: doc.id,
                    target: onePastEndTarget,
                    markdown: revisedNextSteps,
                    dryRun: true,
                });
                if (!adjustedPreview.ok) {
                    ctx.friction('replaceRangeWithMarkdown', `The one-index-lower preview also failed: ${adjustedPreview.error?.message}`);
                    throw adjustedPreview.error;
                }
                resolvedContentOnlyTarget = onePastEndTarget;
            }

            const rangeRewrite = await ctx.tryCall('replaceRangeWithMarkdown', {
                documentId: doc.id,
                target: resolvedContentOnlyTarget,
                markdown: revisedNextSteps,
            });
            if (!rangeRewrite.ok) {
                ctx.friction('replaceRangeWithMarkdown', `The index-addressed section rewrite failed: ${rangeRewrite.error?.message}`);
                throw rangeRewrite.error;
            }
        }
    }

    let afterRevision = asText(await ctx.call('readDocument', {
        documentId: doc.id,
        format: 'markdown',
    }));
    let sectionRewriteVerified = false;
    try {
        sectionRewriteVerified = withoutNextSteps(beforeRevision) === withoutNextSteps(afterRevision)
            && afterRevision.includes('Mina will confirm the 25-person pilot cohort by September 5.');
    } catch {
        sectionRewriteVerified = false;
    }
    if (!sectionRewriteVerified) {
        ctx.friction('replaceRangeWithMarkdown', 'Even an explicit content-only startIndex/endIndex range returned success but removed the Next steps heading. The structured section-rewrite tool could not meet the basic preservation contract.');
        doc = await ctx.createDoc(ctx.title('Atlas launch meeting notes, localized text edit'), originalMarkdown);
        ctx.note(`Created final fallback Google Doc ${doc.id} for a localized text-only revision.`);
        beforeRevision = asText(await ctx.call('readDocument', {
            documentId: doc.id,
            format: 'markdown',
        }));
        const structure = decode(await ctx.call('readDocument', {
            documentId: doc.id,
            format: 'index',
        }));
        const heading = structure?.elements?.find((element) => (
            element.type === 'heading' && element.preview?.toLowerCase() === 'next steps'
        ));
        if (!heading || !Number.isInteger(heading.end) || !Number.isInteger(structure.documentEnd)) {
            throw new Error('The index read did not expose a usable Next steps content range for modifyText.');
        }
        const followingHeading = structure.elements.find((element) => (
            element.type === 'heading' && element.start >= heading.end && element.level <= heading.level
        ));
        const textOnlyTarget = {
            startIndex: heading.end,
            endIndex: (followingHeading?.start ?? structure.documentEnd) - 1,
        };

        // Public workflows recommend modifyText for a small localized change, but provide
        // no schema example. This is the most natural argument shape an agent can infer.
        ctx.friction('modifyText', 'The public documentation recommends modifyText for localized edits but gives no argument example, forcing an unsupported schema guess for this fallback.');
        const textRewrite = await ctx.tryCall('modifyText', {
            documentId: doc.id,
            ...textOnlyTarget,
            text: revisedNextSteps,
        });
        if (!textRewrite.ok) {
            ctx.friction('modifyText', `The first reasonable localized-edit attempt failed: ${textRewrite.error?.message}`);
            const nestedTargetRewrite = await ctx.tryCall('modifyText', {
                documentId: doc.id,
                target: textOnlyTarget,
                text: revisedNextSteps,
            });
            if (!nestedTargetRewrite.ok) {
                ctx.friction('modifyText', `The target-nested retry also failed: ${nestedTargetRewrite.error?.message}`);
                throw nestedTargetRewrite.error;
            }
        }
        afterRevision = asText(await ctx.call('readDocument', {
            documentId: doc.id,
            format: 'markdown',
        }));
    }
    if (withoutNextSteps(beforeRevision) !== withoutNextSteps(afterRevision)) {
        ctx.friction('modifyText', 'The fallback text edit changed document content outside Next steps.');
        throw new Error('Section rewrite changed document content outside Next steps.');
    }
    if (!afterRevision.includes('Mina will confirm the 25-person pilot cohort by September 5.')) {
        throw new Error('The revised Next steps content was not present in the document read-back.');
    }
    ctx.note('Verified via Markdown read-back that only the Next steps section changed.');

    const spreadsheetRaw = await ctx.call('createSpreadsheet', {
        title: ctx.title('Atlas decision summary'),
        parentFolderId: ctx.folderId,
    });
    const spreadsheet = decode(spreadsheetRaw);
    if (!spreadsheet?.id) throw new Error('createSpreadsheet did not return a spreadsheet id.');
    ctx.note(`Created decision-summary spreadsheet ${spreadsheet.id} in the sandbox folder.`);

    await ctx.call('writeSpreadsheet', {
        spreadsheetId: spreadsheet.id,
        range: 'Sheet1!A1:C4',
        values: [['Decision', 'Owner', 'Rationale'], ...decisions],
        valueInputOption: 'USER_ENTERED',
    });

    // The public workflows document writing a range, but not the formatCells input shape.
    // This is the natural Google Sheets API-shaped guess an independent agent has to make.
    ctx.friction('formatCells', 'The public documentation does not show the formatCells argument shape, so formatting the required header row required an unsupported schema guess.');
    const headerFormat = await ctx.tryCall('formatCells', {
        spreadsheetId: spreadsheet.id,
        range: 'Sheet1!A1:C1',
        format: {
            backgroundColor: { red: 0.12, green: 0.31, blue: 0.47 },
            textFormat: {
                bold: true,
                foregroundColor: { red: 1, green: 1, blue: 1 },
            },
            horizontalAlignment: 'CENTER',
        },
    });
    if (!headerFormat.ok) {
        ctx.friction('formatCells', `The first reasonable header-formatting attempt failed without a documented alternative: ${headerFormat.error?.message}`);
        throw headerFormat.error;
    }

    const spreadsheetReadBack = asText(await ctx.call('readSpreadsheet', {
        spreadsheetId: spreadsheet.id,
        range: 'Sheet1!A1:C4',
    }));
    for (const [decision, owner, rationale] of decisions) {
        if (!spreadsheetReadBack.includes(decision) || !spreadsheetReadBack.includes(owner) || !spreadsheetReadBack.includes(rationale)) {
            throw new Error(`Spreadsheet read-back did not contain the decision row for ${decision}.`);
        }
    }
    ctx.note('Verified the spreadsheet contains one row for each document decision, plus its formatted header row.');
}
