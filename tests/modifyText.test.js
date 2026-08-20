// Tests for buildModifyTextRequests — the pure/sync request builder in modifyText.js
import { describe, it, expect } from '@jest/globals';
import { buildModifyTextRequests } from '../dist/tools/docs/modifyText.js';

describe('buildModifyTextRequests', () => {
    it('returns empty array when nothing specified', () => {
        const requests = buildModifyTextRequests({
            startIndex: 1,
            endIndex: 10,
        });
        expect(requests).toEqual([]);
    });

    // --- Text replacement ---
    it('generates delete + insert for text replacement', () => {
        const requests = buildModifyTextRequests({
            startIndex: 5,
            endIndex: 10,
            text: 'Hello',
        });
        expect(requests).toHaveLength(2);
        // Delete existing
        expect(requests[0]).toHaveProperty('deleteContentRange');
        expect(requests[0].deleteContentRange.range).toEqual({ startIndex: 5, endIndex: 10 });
        // Insert new
        expect(requests[1]).toHaveProperty('insertText');
        expect(requests[1].insertText.text).toBe('Hello');
        expect(requests[1].insertText.location.index).toBe(5);
    });

    // --- Text insertion (no endIndex) ---
    it('generates insert-only when endIndex is undefined', () => {
        const requests = buildModifyTextRequests({
            startIndex: 5,
            text: 'New text',
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toHaveProperty('insertText');
        expect(requests[0].insertText.text).toBe('New text');
        expect(requests[0].insertText.location.index).toBe(5);
    });

    // --- Formatting only ---
    it('generates text style request for style-only operation', () => {
        const requests = buildModifyTextRequests({
            startIndex: 1,
            endIndex: 10,
            style: { bold: true },
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toHaveProperty('updateTextStyle');
        expect(requests[0].updateTextStyle.range).toEqual({ startIndex: 1, endIndex: 10 });
    });

    // --- Paragraph formatting ---
    it('generates paragraph style request', () => {
        const requests = buildModifyTextRequests({
            startIndex: 1,
            endIndex: 20,
            paragraphStyle: { alignment: 'CENTER' },
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toHaveProperty('updateParagraphStyle');
    });

    // --- Combined: text + style ---
    it('generates delete + insert + style for replacement with formatting', () => {
        const requests = buildModifyTextRequests({
            startIndex: 5,
            endIndex: 10,
            text: 'Bold text',
            style: { bold: true },
        });
        expect(requests).toHaveLength(3);
        expect(requests[0]).toHaveProperty('deleteContentRange');
        expect(requests[1]).toHaveProperty('insertText');
        expect(requests[2]).toHaveProperty('updateTextStyle');
        // Format range should cover the newly inserted text
        expect(requests[2].updateTextStyle.range.startIndex).toBe(5);
        expect(requests[2].updateTextStyle.range.endIndex).toBe(5 + 'Bold text'.length);
    });

    // --- Combined: text + paragraph style ---
    it('generates insert + paragraph style for insertion with paragraph formatting', () => {
        const requests = buildModifyTextRequests({
            startIndex: 1,
            text: 'Heading\n',
            paragraphStyle: { namedStyleType: 'HEADING_1' },
        });
        expect(requests).toHaveLength(2);
        expect(requests[0]).toHaveProperty('insertText');
        expect(requests[1]).toHaveProperty('updateParagraphStyle');
    });

    // --- tabId propagation ---
    it('includes tabId in all requests', () => {
        const requests = buildModifyTextRequests({
            startIndex: 5,
            endIndex: 10,
            text: 'Replaced',
            style: { italic: true },
            tabId: 'my-tab',
        });
        // Delete range should have tabId
        expect(requests[0].deleteContentRange.range.tabId).toBe('my-tab');
        // Insert location should have tabId
        expect(requests[1].insertText.location.tabId).toBe('my-tab');
        // Style range should have tabId
        expect(requests[2].updateTextStyle.range.tabId).toBe('my-tab');
    });

    it('does not include tabId when not provided', () => {
        const requests = buildModifyTextRequests({
            startIndex: 5,
            endIndex: 10,
            text: 'Hello',
        });
        expect(requests[0].deleteContentRange.range.tabId).toBeUndefined();
        expect(requests[1].insertText.location.tabId).toBeUndefined();
    });

    // --- Style-only with zero-length range does nothing ---
    it('skips formatting when formatStart equals formatEnd (insert with no text)', () => {
        // Edge case: style provided but startIndex == endIndex (0-length range)
        const requests = buildModifyTextRequests({
            startIndex: 5,
            style: { bold: true },
        });
        // No text, no endIndex means format range is 5-5 (empty), so no format request
        expect(requests).toEqual([]);
    });

    // --- Issue #13: Empty string replacement = delete ---
    it('generates delete-only when text is empty string (delete operation)', () => {
        const requests = buildModifyTextRequests({
            startIndex: 5,
            endIndex: 10,
            text: '',
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toHaveProperty('deleteContentRange');
        expect(requests[0].deleteContentRange.range).toEqual({ startIndex: 5, endIndex: 10 });
    });

    it('does not insert text when replacement is empty string', () => {
        const requests = buildModifyTextRequests({
            startIndex: 5,
            endIndex: 10,
            text: '',
        });
        // Should NOT have an insertText request
        const hasInsert = requests.some(r => 'insertText' in r);
        expect(hasInsert).toBe(false);
    });

    it('returns empty when text is undefined and no style (unchanged behavior)', () => {
        const requests = buildModifyTextRequests({
            startIndex: 5,
            endIndex: 10,
        });
        expect(requests).toEqual([]);
    });

    it('handles empty string replacement with tabId', () => {
        const requests = buildModifyTextRequests({
            startIndex: 5,
            endIndex: 10,
            text: '',
            tabId: 'my-tab',
        });
        expect(requests).toHaveLength(1);
        expect(requests[0].deleteContentRange.range.tabId).toBe('my-tab');
    });

    it('handles empty string replacement with formatting applied to remaining range', () => {
        // When text is '' but style is provided, we delete the text
        // but there's no new text to format — so style should be skipped (0-length range)
        const requests = buildModifyTextRequests({
            startIndex: 5,
            endIndex: 10,
            text: '',
            style: { bold: true },
        });
        // Delete + no insert + no format (formatEnd = startIndex + 0 = startIndex)
        expect(requests).toHaveLength(1);
        expect(requests[0]).toHaveProperty('deleteContentRange');
    });
});

// --- Issue #14: explicit default text color on freshly inserted text ---
describe('buildModifyTextRequests — default text color (issue #14)', () => {
    const rgb = { red: 0.1, green: 0.2, blue: 0.3 };

    it('paints the newly inserted range with defaultColor right after insertText', () => {
        const requests = buildModifyTextRequests({
            startIndex: 5,
            text: 'hi',
            defaultColor: rgb,
        });
        expect(requests).toHaveLength(2);
        expect(requests[0]).toHaveProperty('insertText');
        expect(requests[1]).toEqual({
            updateTextStyle: {
                range: { startIndex: 5, endIndex: 7 },
                textStyle: { foregroundColor: { color: { rgbColor: rgb } } },
                fields: 'foregroundColor',
            },
        });
    });

    it('emits no color request when defaultColor is absent', () => {
        const requests = buildModifyTextRequests({ startIndex: 5, text: 'hi' });
        expect(requests.every((r) => !r.updateTextStyle || r.updateTextStyle.fields !== 'foregroundColor')).toBe(true);
    });

    it('emits no color request for a style-only call (no new text)', () => {
        const requests = buildModifyTextRequests({
            startIndex: 1,
            endIndex: 10,
            style: { bold: true },
            defaultColor: rgb,
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toHaveProperty('updateTextStyle');
        expect(requests[0].updateTextStyle.fields).not.toBe('foregroundColor');
    });

    it('emits no color request for a delete-only call (empty string text)', () => {
        const requests = buildModifyTextRequests({
            startIndex: 5,
            endIndex: 10,
            text: '',
            defaultColor: rgb,
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toHaveProperty('deleteContentRange');
    });

    it('caller-supplied foregroundColor still wins: its request is emitted after the default-color paint', () => {
        const requests = buildModifyTextRequests({
            startIndex: 5,
            text: 'hi',
            style: { foregroundColor: '#ff0000' },
            defaultColor: rgb,
        });
        // insertText, default-color paint, then caller's style request last.
        expect(requests).toHaveLength(3);
        expect(requests[1].updateTextStyle.textStyle.foregroundColor.color.rgbColor).toEqual(rgb);
        expect(requests[2].updateTextStyle.textStyle.foregroundColor.color.rgbColor).toEqual({ red: 1, green: 0, blue: 0 });
    });

    it('includes tabId on the default-color request when provided', () => {
        const requests = buildModifyTextRequests({
            startIndex: 5,
            text: 'hi',
            tabId: 'tab-1',
            defaultColor: rgb,
        });
        expect(requests[1].updateTextStyle.range.tabId).toBe('tab-1');
    });

    it('paints the replaced range too (delete + insert + default color)', () => {
        const requests = buildModifyTextRequests({
            startIndex: 5,
            endIndex: 8,
            text: 'longer text',
            defaultColor: rgb,
        });
        expect(requests[0]).toHaveProperty('deleteContentRange');
        expect(requests[1]).toHaveProperty('insertText');
        expect(requests[2].updateTextStyle.range).toEqual({ startIndex: 5, endIndex: 5 + 'longer text'.length });
    });
});
