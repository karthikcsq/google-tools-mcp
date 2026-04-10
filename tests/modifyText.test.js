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
});
