// Range-precise conflict classification for guarded Docs mutations (issue #108).
//
// --- What the migration left open ------------------------------------------
//
// The 2026-07-28 migration made the Docs guard *revision-first*: a validated
// read handle carries the revision its read saw, and `WriteControl
// .requiredRevisionId` refuses the write if the document moved. That is correct
// but blunt. Any change anywhere in the document blocks every pending edit, and
// the rejection cannot say whether the change had anything to do with the range
// the caller asked for.
//
// This module is the precision layer. Given the text/structure projection a
// read captured and the projection of the document as it is *now*, it answers
// one question per requested target: "could this change have affected THIS
// range?" Only a target it can prove is unaffected may proceed, and only after
// its indices have been resolved again against the newer snapshot.
//
// --- Why everything here is deliberately conservative -----------------------
//
// The projection is lossy. It is the flat text of every `textRun` in document
// order, plus a census of the structural nodes around them. It cannot see
// formatting, it cannot see suggestions, and a field mask that omits a subtree
// makes that subtree invisible rather than obviously missing. So every
// comparison here is written to answer "definitely unaffected" or "not
// provably unaffected", never "probably fine":
//
//   * A change we cannot map to document indices is UNKNOWN, and UNKNOWN
//     rejects.
//   * A revision that moved with no visible text or structural difference is
//     also UNKNOWN — a formatting-only edit is real, and we cannot locate it.
//   * A hunk touching a table, an image, a section break or a table of
//     contents rejects outright, because the flat text projection does not
//     describe positions inside those faithfully enough to reason about.
//   * An explicit index target gets no anchor-based exemption at all. Only a
//     change that lands strictly AFTER the end of its range leaves its indices
//     provably where the caller read them.
//
// See docs/plans/issue-108-conflict-guard-precision.md.
import { diffLines, createPatch } from 'diff';
import { NODE_KINDS, walkDocument } from './docsStructure.js';

/** How a change between two projections was classified. */
export const CHANGE_STATUS = Object.freeze({
    /** The two projections are identical: nothing to reason about. */
    UNCHANGED: 'unchanged',
    /** Clean text-only edits, every one mapped to a document index range. */
    TEXT: 'text',
    /** Tables, images, section breaks or the element tree itself moved. */
    STRUCTURAL: 'structural',
    /** Not classifiable. Always rejects. */
    UNKNOWN: 'unknown',
});

/** Rejection tiers. Each one names a different recovery path for the caller. */
export const REJECTION_TIER = Object.freeze({
    /** A change lands inside the range this call wants to edit. */
    OVERLAP: 'overlap',
    /** A change lands before an explicit index target, so its indices moved. */
    SHIFTED: 'shifted',
    /** Structure (table/image/section) changed; text positions are not trustworthy. */
    STRUCTURAL: 'structural',
    /** A semantic anchor no longer resolves, or no longer resolves uniquely. */
    AMBIGUOUS: 'ambiguous',
    /** The change could not be classified at all. The conservative default. */
    UNKNOWN: 'unknown',
});

/** Kinds whose presence/geometry is compared directly rather than via the text diff. */
const OPAQUE_KINDS = new Set([
    NODE_KINDS.TABLE,
    NODE_KINDS.TABLE_ROW,
    NODE_KINDS.TABLE_CELL,
    NODE_KINDS.SECTION_BREAK,
    NODE_KINDS.TABLE_OF_CONTENTS,
    NODE_KINDS.PARAGRAPH_ELEMENT,
]);

/** Longest text excerpt echoed back in an explanation. */
const EXCERPT_CHARS = 80;
/** Longest unified diff embedded in a rejection. */
const MAX_DIFF_CHARS = 4000;
/** Most changed regions listed individually before the list is summarized. */
const MAX_LISTED_HUNKS = 5;

const NEXT_STEPS =
    "Next steps: call readDocument with format='index' to get the current element indices and a fresh " +
    "read handle, or readDocument with format='markdown' and diffFromLastRead:true to see exactly what " +
    'changed, then retry against the new indices.';

const excerpt = (value) => {
    const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (flat.length === 0) return '';
    return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS)}…`;
};

/**
 * `walkDocument`'s tab filter only matches documents that actually carry a
 * `tabs` array. A tab read hands its content on as a bare `{ body, lists }`
 * fragment, where passing the tab id would filter the whole body away and
 * silently produce an empty projection. Resolve the filter against the shape
 * we were actually given.
 */
export function walkTabFilter(source, tabId) {
    return Array.isArray(source?.tabs) && source.tabs.length > 0 ? (tabId ?? null) : null;
}

// --- projection -------------------------------------------------------------

/**
 * Flat text + document-index segments + structural census for a document (or a
 * `{ body }` / `{ tabs }` fragment).
 *
 * `available` is false when the source yielded no indexed text at all, which is
 * what a field mask without `startIndex`/`endIndex` produces (`format:'text'`
 * reads fetch exactly such a mask). An unavailable projection can never be
 * compared, so it classifies as UNKNOWN rather than as "empty document".
 *
 * @param {object} source Docs API document or fragment.
 * @param {object} [options]
 * @param {string|null} [options.tabId]
 */
export function captureDocsProjection(source, { tabId = null } = {}) {
    const filter = walkTabFilter(source, tabId);
    const segments = [];
    const kindCounts = Object.create(null);
    const tables = [];
    const inlineTypes = [];
    const opaqueSpans = [];
    let text = '';
    let nodes = 0;

    for (const entry of walkDocument(source, { tabId: filter ?? undefined, includeTabNodes: false })) {
        nodes += 1;
        if (entry.kind === NODE_KINDS.TEXT_RUN) {
            const content = entry.node?.content;
            if (typeof content !== 'string' || content.length === 0) continue;
            if (typeof entry.startIndex !== 'number') continue;
            segments.push({
                textStart: text.length,
                textEnd: text.length + content.length,
                docStart: entry.startIndex,
            });
            text += content;
            continue;
        }
        if (!OPAQUE_KINDS.has(entry.kind)) continue;
        kindCounts[entry.kind] = (kindCounts[entry.kind] ?? 0) + 1;
        if (entry.kind === NODE_KINDS.TABLE) {
            const table = entry.node?.table;
            tables.push({
                rows: table?.rows ?? table?.tableRows?.length ?? 0,
                columns: table?.columns ?? table?.tableRows?.[0]?.tableCells?.length ?? 0,
            });
        }
        if (entry.kind === NODE_KINDS.PARAGRAPH_ELEMENT) {
            inlineTypes.push(entry.elementType ?? 'unknown');
        }
        // Table rows carry no indices of their own; every other opaque kind
        // does, and its span is the region the text projection cannot describe.
        if (typeof entry.startIndex === 'number' && typeof entry.endIndex === 'number') {
            opaqueSpans.push({ kind: entry.kind, start: entry.startIndex, end: entry.endIndex });
        }
    }

    return {
        available: nodes > 0 && segments.length > 0,
        text,
        segments,
        census: { kindCounts, tables, inlineTypes, opaqueSpans },
    };
}

/** Document index of the character at `offset`, or null when it cannot be mapped. */
export function docIndexAtOffset(projection, offset) {
    const segments = projection?.segments ?? [];
    if (segments.length === 0) return null;
    if (offset >= projection.text.length) {
        const last = segments[segments.length - 1];
        return last.docStart + (last.textEnd - last.textStart);
    }
    if (offset < 0) return null;
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        const segment = segments[mid];
        if (offset < segment.textStart) high = mid - 1;
        else if (offset >= segment.textEnd) low = mid + 1;
        else return segment.docStart + (offset - segment.textStart);
    }
    return null;
}

// --- structural census comparison -------------------------------------------

function censusDifference(before, after) {
    const kinds = new Set([...Object.keys(before.kindCounts), ...Object.keys(after.kindCounts)]);
    for (const kind of kinds) {
        const from = before.kindCounts[kind] ?? 0;
        const to = after.kindCounts[kind] ?? 0;
        if (from !== to) {
            return `the number of ${kind} elements changed (${from} → ${to})`;
        }
    }
    if (before.tables.length === after.tables.length) {
        for (let index = 0; index < before.tables.length; index += 1) {
            const from = before.tables[index];
            const to = after.tables[index];
            if (from.rows !== to.rows || from.columns !== to.columns) {
                return `table ${index + 1} was resized (${from.rows}x${from.columns} → ${to.rows}x${to.columns})`;
            }
        }
    }
    // elementType degrades to 'unknown' under a reduced field mask, so it is
    // only compared when BOTH sides actually resolved every inline kind.
    const knownBoth = !before.inlineTypes.includes('unknown') && !after.inlineTypes.includes('unknown');
    if (knownBoth && before.inlineTypes.join(',') !== after.inlineTypes.join(',')) {
        return `the inline elements changed (${before.inlineTypes.join(', ') || 'none'} → ${after.inlineTypes.join(', ') || 'none'})`;
    }
    return null;
}

// --- hunks ------------------------------------------------------------------

/**
 * Contiguous changed regions between two texts, as `{ before, after }` offset
 * pairs. A removed run and the added run that immediately follows it are one
 * hunk (a modification), not two.
 */
export function buildTextHunks(beforeText, afterText) {
    const parts = diffLines(beforeText, afterText);
    const hunks = [];
    let beforeOffset = 0;
    let afterOffset = 0;
    let pending = null;
    const flush = () => { if (pending) { hunks.push(pending); pending = null; } };
    for (const part of parts) {
        const length = part.value.length;
        if (!part.added && !part.removed) {
            flush();
            beforeOffset += length;
            afterOffset += length;
            continue;
        }
        if (!pending) {
            pending = {
                beforeStart: beforeOffset, beforeEnd: beforeOffset,
                afterStart: afterOffset, afterEnd: afterOffset,
                removedText: '', addedText: '',
            };
        }
        if (part.removed) {
            beforeOffset += length;
            pending.beforeEnd = beforeOffset;
            pending.removedText += part.value;
        } else {
            afterOffset += length;
            pending.afterEnd = afterOffset;
            pending.addedText += part.value;
        }
    }
    flush();
    return hunks;
}

function toDocRange(projection, start, end) {
    const docStart = docIndexAtOffset(projection, start);
    if (docStart === null) return null;
    if (end <= start) return { start: docStart, end: docStart };
    const lastCharIndex = docIndexAtOffset(projection, end - 1);
    if (lastCharIndex === null) return null;
    return { start: docStart, end: lastCharIndex + 1 };
}

const spansIntersect = (a, b) => a.start < b.end && b.start < a.end;

/** True when a (possibly zero-width) range touches a span. */
function rangeTouchesSpan(range, span) {
    if (range.end > range.start) return spansIntersect(range, span);
    return range.start > span.start && range.start < span.end;
}

// --- classification ---------------------------------------------------------

/**
 * Classify what changed between the projection a read captured and the
 * projection of the document as it is now.
 *
 * @returns {{status:string, hunks:Array, reason:string|null, detail:string|null}}
 */
export function classifyDocumentChange(before, after, { revisionMoved = true } = {}) {
    if (!before?.available || !after?.available) {
        return {
            status: CHANGE_STATUS.UNKNOWN,
            hunks: [],
            reason: 'projection-unavailable',
            detail: !before?.available
                ? 'the read this handle came from did not capture indexed document text (a text-format read does not), ' +
                  'so there is nothing to compare the current document against'
                : 'the current document snapshot carried no indexed text to compare against',
        };
    }
    const structural = censusDifference(before.census, after.census);
    if (structural) {
        return { status: CHANGE_STATUS.STRUCTURAL, hunks: [], reason: 'census', detail: structural };
    }
    if (before.text === after.text) {
        // Identical text AND an identical census. If the revision did not move
        // either, nothing happened. If it DID move, something real happened
        // that this projection cannot see — a formatting change, a style, a
        // comment, an accepted suggestion — and "invisible" is not "harmless".
        if (!revisionMoved) {
            return { status: CHANGE_STATUS.UNCHANGED, hunks: [], reason: null, detail: null };
        }
        return {
            status: CHANGE_STATUS.UNKNOWN,
            hunks: [],
            reason: 'invisible-change',
            detail: 'the document moved to a new revision but its text and structure look identical, so whatever ' +
                'changed is something this guard cannot locate (formatting, styles, comments or suggestions)',
        };
    }
    const rawHunks = buildTextHunks(before.text, after.text);
    const hunks = [];
    for (const hunk of rawHunks) {
        const beforeRange = toDocRange(before, hunk.beforeStart, hunk.beforeEnd);
        const afterRange = toDocRange(after, hunk.afterStart, hunk.afterEnd);
        if (!beforeRange || !afterRange) {
            return {
                status: CHANGE_STATUS.UNKNOWN,
                hunks: [],
                reason: 'unmappable-hunk',
                detail: 'one of the changed regions could not be mapped back to document character indices',
            };
        }
        const touched = [...before.census.opaqueSpans].find((span) => rangeTouchesSpan(beforeRange, span))
            ?? [...after.census.opaqueSpans].find((span) => rangeTouchesSpan(afterRange, span));
        if (touched) {
            return {
                status: CHANGE_STATUS.STRUCTURAL,
                hunks: [],
                reason: 'opaque-span',
                detail: `a change at ${beforeRange.start}-${beforeRange.end} falls inside a ${touched.kind} ` +
                    `(${touched.start}-${touched.end}), whose contents this guard cannot position precisely`,
            };
        }
        hunks.push({ ...hunk, beforeRange, afterRange });
    }
    return { status: CHANGE_STATUS.TEXT, hunks, reason: null, detail: null };
}

/**
 * Decide whether one target may proceed against a classified change.
 *
 * `target` is `{ startIndex, endIndex?, kind }` where `kind` is `'explicit'`
 * (caller-supplied indices, no semantic anchor) or `'semantic'` (resolved from
 * text/heading, so it can be resolved again). A semantic target must supply
 * `resolved`, the range it re-resolves to in the CURRENT snapshot; without one
 * it is treated as explicit, which is the stricter path.
 *
 * @returns {{permitted:boolean, tier:string|null, blocking:object|null}}
 */
export function classifyTargetAgainstChange(target, change) {
    if (change.status === CHANGE_STATUS.UNCHANGED) {
        return { permitted: true, tier: null, blocking: null };
    }
    if (change.status === CHANGE_STATUS.STRUCTURAL) {
        return { permitted: false, tier: REJECTION_TIER.STRUCTURAL, blocking: null };
    }
    if (change.status === CHANGE_STATUS.UNKNOWN) {
        return { permitted: false, tier: REJECTION_TIER.UNKNOWN, blocking: null };
    }
    if (target.kind === 'semantic' && target.resolved) {
        const range = { start: target.resolved.startIndex, end: target.resolved.endIndex ?? target.resolved.startIndex };
        const blocking = change.hunks.find((hunk) => rangeTouchesSpan(hunk.afterRange, range)
            || rangeTouchesSpan(range, hunk.afterRange)
            || (range.end === range.start && hunk.afterRange.start === range.start && hunk.afterRange.end > range.start));
        if (blocking) return { permitted: false, tier: REJECTION_TIER.OVERLAP, blocking };
        return { permitted: true, tier: null, blocking: null };
    }
    // Explicit indices. There is no anchor to re-resolve, so the ONLY safe case
    // is a change that lands strictly after the end of the range: everything
    // the caller addressed is then still exactly where they read it. A change
    // before the range shifts it; a change inside it collides with it.
    const bound = target.endIndex ?? target.startIndex;
    const isPoint = target.endIndex === undefined || target.endIndex === target.startIndex;
    const blocking = change.hunks.find((hunk) => (isPoint
        ? hunk.beforeRange.start <= bound
        : hunk.beforeRange.start < bound));
    if (blocking) {
        const tier = blocking.beforeRange.start < target.startIndex
            ? REJECTION_TIER.SHIFTED
            : REJECTION_TIER.OVERLAP;
        return { permitted: false, tier, blocking };
    }
    return { permitted: true, tier: null, blocking: null };
}

// --- explanation ------------------------------------------------------------

/** Bounded unified diff of the two text projections, or null when unavailable. */
export function renderProjectionDiff(before, after, label) {
    if (!before?.available || !after?.available) return null;
    if (before.text === after.text) return null;
    const patch = createPatch(label, before.text, after.text, 'when you read it', 'now', { context: 2 });
    return patch.length <= MAX_DIFF_CHARS
        ? patch
        : `${patch.slice(0, MAX_DIFF_CHARS)}\n… diff truncated at ${MAX_DIFF_CHARS} characters …\n`;
}

function describeHunk(hunk) {
    const removed = excerpt(hunk.removedText);
    const added = excerpt(hunk.addedText);
    const where = hunk.beforeRange.end > hunk.beforeRange.start
        ? `${hunk.beforeRange.start}-${hunk.beforeRange.end}`
        : `index ${hunk.beforeRange.start}`;
    if (removed && added) return `  - ${where}: "${removed}" became "${added}"`;
    if (removed) return `  - ${where}: "${removed}" was removed`;
    if (added) return `  - ${where}: "${added}" was inserted`;
    return `  - ${where}: changed`;
}

/** Human-readable list of what moved, bounded in length. */
export function summarizeChange(change) {
    if (change.status === CHANGE_STATUS.STRUCTURAL || change.status === CHANGE_STATUS.UNKNOWN) {
        return change.detail ? `  - ${change.detail}` : '  - (no further detail available)';
    }
    const shown = change.hunks.slice(0, MAX_LISTED_HUNKS).map(describeHunk);
    if (change.hunks.length > MAX_LISTED_HUNKS) {
        shown.push(`  - … and ${change.hunks.length - MAX_LISTED_HUNKS} more changed region(s)`);
    }
    return shown.join('\n');
}

const TIER_HEADLINE = Object.freeze({
    [REJECTION_TIER.OVERLAP]: 'the document changed inside the range you asked to edit',
    [REJECTION_TIER.SHIFTED]: 'the document changed BEFORE the indices you asked to edit, so those indices no longer point at the same content',
    [REJECTION_TIER.STRUCTURAL]: 'the document\'s structure changed (a table, image, section break or table of contents)',
    [REJECTION_TIER.AMBIGUOUS]: 'the text this edit was anchored to can no longer be located unambiguously',
    [REJECTION_TIER.UNKNOWN]: 'the document changed in a way this guard cannot classify',
});

const TIER_CONFIDENCE = Object.freeze({
    [REJECTION_TIER.OVERLAP]: 'Applying the edit anyway would silently overwrite that change.',
    [REJECTION_TIER.SHIFTED]: 'Explicit start/end indices carry no anchor to re-resolve, so an insertion or deletion ' +
        'before them moves the content they addressed. Only a change strictly after the end of the range would have left them valid.',
    [REJECTION_TIER.STRUCTURAL]: 'Character positions inside and around tables, images and section breaks cannot be ' +
        'mapped from the text projection this guard compares, so no range can be proven unaffected.',
    [REJECTION_TIER.AMBIGUOUS]: 'Re-resolving the anchor is what makes a changed document safe to write to; without a ' +
        'single unambiguous match there is nothing to re-target.',
    [REJECTION_TIER.UNKNOWN]: 'Confidence ended before any range could be proven unaffected, and this guard rejects ' +
        'rather than guessing.',
});

/**
 * Build the caller-facing rejection.
 *
 * Every tier says three things, in order: what changed and where, where this
 * guard's confidence ended, and which read workflow recovers.
 */
export function describeRejection({
    tier, change, target, diff = null, revisionFrom = null, revisionTo = null, extra = null,
}) {
    const lines = [];
    const targetLabel = target
        ? (target.describe
            ?? (target.endIndex === undefined
                ? `index ${target.startIndex}`
                : `range ${target.startIndex}-${target.endIndex}`))
        : 'the requested range';
    lines.push(`This edit was refused because ${TIER_HEADLINE[tier] ?? TIER_HEADLINE[REJECTION_TIER.UNKNOWN]}. ` +
        `Your edit targeted ${targetLabel}.`);
    if (revisionFrom && revisionTo) {
        lines.push(`The read handle was issued for revision ${revisionFrom}; the document is now at revision ${revisionTo}.`);
    }
    if (extra) lines.push(extra);
    const summary = change ? summarizeChange(change) : null;
    if (summary) {
        lines.push('What changed:');
        lines.push(summary);
    }
    lines.push(TIER_CONFIDENCE[tier] ?? TIER_CONFIDENCE[REJECTION_TIER.UNKNOWN]);
    if (diff) {
        lines.push('--- WHAT CHANGED (unified diff) ---');
        lines.push(diff.endsWith('\n') ? `${diff}--- END DIFF ---` : `${diff}\n--- END DIFF ---`);
    }
    lines.push(NEXT_STEPS);
    return lines.join('\n');
}
