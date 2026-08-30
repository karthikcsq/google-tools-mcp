// Unit coverage for the #108 change classifier (dist/docsChangePrecision.js).
//
// This is the layer that decides whether a document change could have affected
// one requested range. Everything it does is a judgement call about safety, so
// each rule gets its own case here, and the integration suite
// (tests/docsConflictGuardPrecision.test.js) proves the same rules through the
// real facade and real wire requests.
import { describe, expect, it } from '@jest/globals';

const {
    CHANGE_STATUS,
    REJECTION_TIER,
    buildTextHunks,
    captureDocsProjection,
    classifyDocumentChange,
    classifyTargetAgainstChange,
    describeRejection,
    docIndexAtOffset,
    renderProjectionDiff,
    walkTabFilter,
} = await import('../dist/docsChangePrecision.js');

// --- document builders ------------------------------------------------------

/** A body-only document whose paragraphs occupy real, contiguous Docs indices. */
function docOf(paragraphs, extras = []) {
    const content = [];
    let index = 1;
    for (const text of paragraphs) {
        content.push({
            startIndex: index,
            endIndex: index + text.length,
            paragraph: { elements: [{ startIndex: index, endIndex: index + text.length, textRun: { content: text } }] },
        });
        index += text.length;
    }
    for (const extra of extras) {
        content.push(extra(index));
        index += 20;
    }
    return { body: { content } };
}

const tableAt = (start) => ({
    startIndex: start,
    endIndex: start + 20,
    table: {
        rows: 1,
        columns: 1,
        tableRows: [{
            tableCells: [{
                startIndex: start + 1,
                endIndex: start + 19,
                content: [{
                    startIndex: start + 2,
                    endIndex: start + 8,
                    paragraph: { elements: [{ startIndex: start + 2, endIndex: start + 8, textRun: { content: 'cell\n' } }] },
                }],
            }],
        }],
    },
});

const imageAt = (start) => ({
    startIndex: start,
    endIndex: start + 2,
    paragraph: {
        elements: [
            { startIndex: start, endIndex: start + 1, inlineObjectElement: { inlineObjectId: 'img-1' } },
            { startIndex: start + 1, endIndex: start + 2, textRun: { content: '\n' } },
        ],
    },
});

const BASE = ['Alpha one\n', 'Beta two\n', 'Gamma three\n'];
const project = (paragraphs, extras = []) => captureDocsProjection(docOf(paragraphs, extras));
const explicit = (startIndex, endIndex) => ({ kind: 'explicit', startIndex, endIndex });
const semantic = (startIndex, endIndex, resolved) => ({ kind: 'semantic', startIndex, endIndex, resolved });

// --- projection -------------------------------------------------------------

describe('captureDocsProjection', () => {
    it('flattens text with the document indices each character really has', () => {
        const projection = project(BASE);
        expect(projection.available).toBe(true);
        expect(projection.text).toBe(BASE.join(''));
        // "two" is at document index 1 + 'Alpha one\n'.length + 'Beta '.length.
        const offset = projection.text.indexOf('two');
        expect(docIndexAtOffset(projection, offset)).toBe(1 + 10 + 5);
    });

    it('reports unavailable for a source with no indexed text', () => {
        // Exactly the shape a format='text' read fetches: textRun content with
        // no startIndex/endIndex anywhere.
        const masked = { body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Alpha\n' } }] } }] } };
        expect(captureDocsProjection(masked).available).toBe(false);
    });

    it('does not filter a bare {body} fragment away when a tabId is supplied', () => {
        // A tab read hands its content on as a fragment with no `tabs` array;
        // passing the tab id straight to walkDocument would yield nothing.
        expect(walkTabFilter({ body: { content: [] } }, 'tab-1')).toBeNull();
        expect(walkTabFilter({ tabs: [{ tabProperties: { tabId: 'tab-1' } }] }, 'tab-1')).toBe('tab-1');
        expect(captureDocsProjection(docOf(BASE), { tabId: 'tab-1' }).text).toBe(BASE.join(''));
    });

    it('counts tables and inline objects into the structural census', () => {
        const withTable = project(BASE, [tableAt]);
        expect(withTable.census.kindCounts.table).toBe(1);
        expect(withTable.census.opaqueSpans.some((span) => span.kind === 'table')).toBe(true);
        const withImage = project(BASE, [imageAt]);
        expect(withImage.census.inlineTypes).toEqual(['inlineObjectElement']);
    });
});

// --- hunks ------------------------------------------------------------------

describe('buildTextHunks', () => {
    it('pairs a removal with the addition that replaces it as one hunk', () => {
        const hunks = buildTextHunks('a\nb\nc\n', 'a\nB!\nc\n');
        expect(hunks).toHaveLength(1);
        expect(hunks[0].removedText).toBe('b\n');
        expect(hunks[0].addedText).toBe('B!\n');
    });

    it('reports separate changes as separate hunks', () => {
        const hunks = buildTextHunks('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\nE\n');
        expect(hunks).toHaveLength(2);
    });
});

// --- classification ---------------------------------------------------------

describe('classifyDocumentChange', () => {
    it('treats an unavailable projection on either side as unclassifiable', () => {
        const usable = project(BASE);
        const empty = captureDocsProjection({ body: { content: [] } });
        expect(classifyDocumentChange(empty, usable).status).toBe(CHANGE_STATUS.UNKNOWN);
        expect(classifyDocumentChange(usable, empty).status).toBe(CHANGE_STATUS.UNKNOWN);
        expect(classifyDocumentChange(null, usable).reason).toBe('projection-unavailable');
    });

    it('is UNCHANGED only when the revision did not move', () => {
        const before = project(BASE);
        const after = project(BASE);
        expect(classifyDocumentChange(before, after, { revisionMoved: false }).status).toBe(CHANGE_STATUS.UNCHANGED);
    });

    it('is UNKNOWN when the revision moved but nothing visible changed', () => {
        // A formatting-only edit: real, revision-advancing, and invisible to a
        // text projection. Conservative default says reject.
        const change = classifyDocumentChange(project(BASE), project(BASE), { revisionMoved: true });
        expect(change.status).toBe(CHANGE_STATUS.UNKNOWN);
        expect(change.reason).toBe('invisible-change');
    });

    it('classifies a clean text edit and maps every hunk to document indices', () => {
        const before = project(BASE);
        const after = project(['Alpha one\n', 'Beta two\n', 'Gamma three\n', 'Delta four\n']);
        const change = classifyDocumentChange(before, after);
        expect(change.status).toBe(CHANGE_STATUS.TEXT);
        expect(change.hunks).toHaveLength(1);
        expect(change.hunks[0].addedText).toBe('Delta four\n');
        expect(change.hunks[0].beforeRange.start).toBeGreaterThan(1);
    });

    it('rejects a table appearing, disappearing or resizing as structural', () => {
        expect(classifyDocumentChange(project(BASE), project(BASE, [tableAt])).status)
            .toBe(CHANGE_STATUS.STRUCTURAL);
        const wide = (start) => {
            const table = tableAt(start);
            table.table.columns = 2;
            return table;
        };
        const change = classifyDocumentChange(project(BASE, [tableAt]), project(BASE, [wide]));
        expect(change.status).toBe(CHANGE_STATUS.STRUCTURAL);
        expect(change.detail).toMatch(/resized/);
    });

    it('rejects an image appearing as structural', () => {
        const change = classifyDocumentChange(project(BASE), project(BASE, [imageAt]));
        expect(change.status).toBe(CHANGE_STATUS.STRUCTURAL);
    });

    it('rejects a text change that lands inside a table as structural', () => {
        const cellEdited = (start) => {
            const table = tableAt(start);
            table.table.tableRows[0].tableCells[0].content[0].paragraph.elements[0].textRun.content = 'CELL\n';
            return table;
        };
        const change = classifyDocumentChange(project(BASE, [tableAt]), project(BASE, [cellEdited]));
        expect(change.status).toBe(CHANGE_STATUS.STRUCTURAL);
        expect(change.reason).toBe('opaque-span');
    });
});

// --- per-target verdicts ----------------------------------------------------

describe('classifyTargetAgainstChange', () => {
    const insertedFirst = classifyDocumentChange(project(BASE), project(['Zero new\n', ...BASE]));
    const appendedLast = classifyDocumentChange(project(BASE), project([...BASE, 'Delta four\n']));

    it('permits everything when nothing changed', () => {
        const unchanged = classifyDocumentChange(project(BASE), project(BASE), { revisionMoved: false });
        expect(classifyTargetAgainstChange(explicit(7, 10), unchanged).permitted).toBe(true);
    });

    it('blocks an explicit range when the change lands before it', () => {
        const verdict = classifyTargetAgainstChange(explicit(16, 19), insertedFirst);
        expect(verdict.permitted).toBe(false);
        expect(verdict.tier).toBe(REJECTION_TIER.SHIFTED);
    });

    it('blocks an explicit insertion point when the change lands at it', () => {
        expect(classifyTargetAgainstChange({ kind: 'explicit', startIndex: 1 }, insertedFirst).permitted).toBe(false);
    });

    it('permits an explicit range when every change lands strictly after its end', () => {
        const verdict = classifyTargetAgainstChange(explicit(7, 10), appendedLast);
        expect(verdict.permitted).toBe(true);
    });

    it('permits a re-resolved semantic target whose new range no change touches', () => {
        // "two" moved from 16-19 to 25-28 when a paragraph was inserted above.
        const verdict = classifyTargetAgainstChange(
            semantic(16, 19, { startIndex: 25, endIndex: 28 }), insertedFirst,
        );
        expect(verdict.permitted).toBe(true);
    });

    it('blocks a re-resolved semantic target whose new range a change overlaps', () => {
        const rewritten = classifyDocumentChange(project(BASE), project(['Alpha one\n', 'Beta two plus\n', 'Gamma three\n']));
        const verdict = classifyTargetAgainstChange(
            semantic(11, 19, { startIndex: 11, endIndex: 19 }), rewritten,
        );
        expect(verdict.permitted).toBe(false);
        expect(verdict.tier).toBe(REJECTION_TIER.OVERLAP);
    });

    it('gives a semantic target no exemption when it could not be re-resolved', () => {
        // No `resolved`: it falls back to the explicit rule, which blocks a
        // change before the range. Nothing is permitted on a guess.
        expect(classifyTargetAgainstChange(semantic(16, 19, null), insertedFirst).permitted).toBe(false);
    });

    it('blocks every target on a structural or unclassifiable change', () => {
        const structural = classifyDocumentChange(project(BASE), project(BASE, [tableAt]));
        const unknown = classifyDocumentChange(project(BASE), project(BASE), { revisionMoved: true });
        // Even a target that a text diff would have cleared.
        expect(classifyTargetAgainstChange(explicit(7, 10), structural).tier).toBe(REJECTION_TIER.STRUCTURAL);
        expect(classifyTargetAgainstChange(semantic(7, 10, { startIndex: 7, endIndex: 10 }), unknown).tier)
            .toBe(REJECTION_TIER.UNKNOWN);
    });
});

// --- explanations -----------------------------------------------------------

describe('describeRejection', () => {
    const change = classifyDocumentChange(project(BASE), project(['Zero new\n', ...BASE]));

    it('names what changed, where confidence ended, and the recovery workflow', () => {
        const message = describeRejection({
            tier: REJECTION_TIER.SHIFTED,
            change,
            target: explicit(16, 19),
            diff: renderProjectionDiff(project(BASE), project(['Zero new\n', ...BASE]), 'document doc-1'),
            revisionFrom: 'rev-1',
            revisionTo: 'rev-2',
        });
        expect(message).toMatch(/changed BEFORE the indices/);
        expect(message).toMatch(/range 16-19/);
        expect(message).toMatch(/rev-1/);
        expect(message).toMatch(/rev-2/);
        expect(message).toMatch(/"Zero new" was inserted/);
        expect(message).toMatch(/no anchor to re-resolve/);
        expect(message).toMatch(/format='index'/);
        expect(message).toMatch(/diffFromLastRead/);
        expect(message).toMatch(/END DIFF/);
    });

    it('still explains itself when there is no diff to show', () => {
        const unknown = classifyDocumentChange(project(BASE), project(BASE), { revisionMoved: true });
        const message = describeRejection({ tier: REJECTION_TIER.UNKNOWN, change: unknown, target: explicit(7, 10) });
        expect(message).toMatch(/cannot classify/);
        expect(message).toMatch(/formatting, styles, comments or suggestions/);
        expect(message).not.toMatch(/END DIFF/);
    });
});
