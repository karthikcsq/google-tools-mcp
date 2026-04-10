// Tests for dist/types.js — pure utility functions and Zod schemas
import { describe, it, expect } from '@jest/globals';
import {
    hexToRgbColor,
    validateHexColor,
    hexColorRegex,
    DocumentIdParameter,
    RangeParameters,
    TextFindParameter,
    TextStyleParameters,
    ParagraphStyleParameters,
    NotImplementedError,
    MarkdownConversionError,
} from '../dist/types.js';

// ---------------------------------------------------------------------------
// hexToRgbColor
// ---------------------------------------------------------------------------
describe('hexToRgbColor', () => {
    it('converts 6-digit hex with hash', () => {
        const result = hexToRgbColor('#FF0000');
        expect(result).toEqual({ red: 1, green: 0, blue: 0 });
    });

    it('converts 6-digit hex without hash', () => {
        const result = hexToRgbColor('00FF00');
        expect(result).toEqual({ red: 0, green: 1, blue: 0 });
    });

    it('converts 3-digit shorthand hex', () => {
        const result = hexToRgbColor('#F00');
        expect(result).toEqual({ red: 1, green: 0, blue: 0 });
    });

    it('converts 3-digit shorthand without hash', () => {
        const result = hexToRgbColor('0F0');
        expect(result).toEqual({ red: 0, green: 1, blue: 0 });
    });

    it('handles mixed case', () => {
        const result = hexToRgbColor('#aaBBcc');
        expect(result).not.toBeNull();
        expect(result.red).toBeCloseTo(0.667, 2);
        expect(result.green).toBeCloseTo(0.733, 2);
        expect(result.blue).toBeCloseTo(0.8, 2);
    });

    it('returns null for null/undefined input', () => {
        expect(hexToRgbColor(null)).toBeNull();
        expect(hexToRgbColor(undefined)).toBeNull();
    });

    it('returns null for invalid hex strings', () => {
        expect(hexToRgbColor('#GG0000')).toBeNull();
        expect(hexToRgbColor('#12345')).toBeNull();  // wrong length
        expect(hexToRgbColor('')).toBeNull();
    });

    it('produces values in [0, 1] range', () => {
        const result = hexToRgbColor('#7F7F7F');
        expect(result.red).toBeGreaterThanOrEqual(0);
        expect(result.red).toBeLessThanOrEqual(1);
        expect(result.green).toBeGreaterThanOrEqual(0);
        expect(result.green).toBeLessThanOrEqual(1);
        expect(result.blue).toBeGreaterThanOrEqual(0);
        expect(result.blue).toBeLessThanOrEqual(1);
    });

    it('converts black correctly', () => {
        expect(hexToRgbColor('#000000')).toEqual({ red: 0, green: 0, blue: 0 });
    });

    it('converts white correctly', () => {
        expect(hexToRgbColor('#FFFFFF')).toEqual({ red: 1, green: 1, blue: 1 });
    });
});

// ---------------------------------------------------------------------------
// validateHexColor / hexColorRegex
// ---------------------------------------------------------------------------
describe('validateHexColor', () => {
    it('accepts valid 6-digit hex with hash', () => {
        expect(validateHexColor('#FF0000')).toBe(true);
    });

    it('accepts valid 6-digit hex without hash', () => {
        expect(validateHexColor('FF0000')).toBe(true);
    });

    it('accepts valid 3-digit hex', () => {
        expect(validateHexColor('#F00')).toBe(true);
        expect(validateHexColor('F00')).toBe(true);
    });

    it('rejects invalid color strings', () => {
        expect(validateHexColor('#GGGGGG')).toBe(false);
        expect(validateHexColor('#12345')).toBe(false);
        expect(validateHexColor('notacolor')).toBe(false);
        expect(validateHexColor('')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Zod Schemas — DocumentIdParameter
// ---------------------------------------------------------------------------
describe('DocumentIdParameter', () => {
    it('accepts a valid document ID', () => {
        const result = DocumentIdParameter.safeParse({ documentId: 'abc123_def-456' });
        expect(result.success).toBe(true);
    });

    it('rejects missing documentId', () => {
        const result = DocumentIdParameter.safeParse({});
        expect(result.success).toBe(false);
    });

    it('rejects non-string documentId', () => {
        const result = DocumentIdParameter.safeParse({ documentId: 123 });
        expect(result.success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Zod Schemas — RangeParameters
// ---------------------------------------------------------------------------
describe('RangeParameters', () => {
    it('accepts valid range', () => {
        const result = RangeParameters.safeParse({ startIndex: 1, endIndex: 10 });
        expect(result.success).toBe(true);
    });

    it('rejects endIndex <= startIndex', () => {
        const result = RangeParameters.safeParse({ startIndex: 10, endIndex: 5 });
        expect(result.success).toBe(false);
    });

    it('rejects equal start and end', () => {
        const result = RangeParameters.safeParse({ startIndex: 5, endIndex: 5 });
        expect(result.success).toBe(false);
    });

    it('rejects startIndex < 1', () => {
        const result = RangeParameters.safeParse({ startIndex: 0, endIndex: 5 });
        expect(result.success).toBe(false);
    });

    it('rejects non-integer indices', () => {
        const result = RangeParameters.safeParse({ startIndex: 1.5, endIndex: 10 });
        expect(result.success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Zod Schemas — TextFindParameter
// ---------------------------------------------------------------------------
describe('TextFindParameter', () => {
    it('accepts text to find', () => {
        const result = TextFindParameter.safeParse({ textToFind: 'hello' });
        expect(result.success).toBe(true);
    });

    it('accepts text with matchInstance', () => {
        const result = TextFindParameter.safeParse({ textToFind: 'hello', matchInstance: 2 });
        expect(result.success).toBe(true);
    });

    it('rejects empty textToFind', () => {
        const result = TextFindParameter.safeParse({ textToFind: '' });
        expect(result.success).toBe(false);
    });

    it('rejects matchInstance < 1', () => {
        const result = TextFindParameter.safeParse({ textToFind: 'hello', matchInstance: 0 });
        expect(result.success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Zod Schemas — TextStyleParameters
// ---------------------------------------------------------------------------
describe('TextStyleParameters', () => {
    it('accepts bold only', () => {
        const result = TextStyleParameters.safeParse({ bold: true });
        expect(result.success).toBe(true);
    });

    it('accepts multiple styles', () => {
        const result = TextStyleParameters.safeParse({
            bold: true,
            italic: true,
            fontSize: 14,
            fontFamily: 'Arial',
        });
        expect(result.success).toBe(true);
    });

    it('validates foregroundColor as hex', () => {
        const valid = TextStyleParameters.safeParse({ foregroundColor: '#FF0000' });
        expect(valid.success).toBe(true);

        const invalid = TextStyleParameters.safeParse({ foregroundColor: 'not-a-color' });
        expect(invalid.success).toBe(false);
    });

    it('validates linkUrl as URL', () => {
        const valid = TextStyleParameters.safeParse({ linkUrl: 'https://example.com' });
        expect(valid.success).toBe(true);

        const invalid = TextStyleParameters.safeParse({ linkUrl: 'not-a-url' });
        expect(invalid.success).toBe(false);
    });

    it('rejects fontSize < 1', () => {
        const result = TextStyleParameters.safeParse({ fontSize: 0 });
        expect(result.success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Zod Schemas — ParagraphStyleParameters
// ---------------------------------------------------------------------------
describe('ParagraphStyleParameters', () => {
    it('accepts alignment', () => {
        const result = ParagraphStyleParameters.safeParse({ alignment: 'CENTER' });
        expect(result.success).toBe(true);
    });

    it('rejects invalid alignment', () => {
        const result = ParagraphStyleParameters.safeParse({ alignment: 'MIDDLE' });
        expect(result.success).toBe(false);
    });

    it('accepts namedStyleType', () => {
        const result = ParagraphStyleParameters.safeParse({ namedStyleType: 'HEADING_1' });
        expect(result.success).toBe(true);
    });

    it('accepts indentation and spacing', () => {
        const result = ParagraphStyleParameters.safeParse({
            indentStart: 36,
            indentEnd: 18,
            spaceAbove: 12,
            spaceBelow: 6,
        });
        expect(result.success).toBe(true);
    });

    it('rejects negative indentation', () => {
        const result = ParagraphStyleParameters.safeParse({ indentStart: -1 });
        expect(result.success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Custom Error Classes
// ---------------------------------------------------------------------------
describe('NotImplementedError', () => {
    it('has correct name and default message', () => {
        const err = new NotImplementedError();
        expect(err.name).toBe('NotImplementedError');
        expect(err.message).toBe('This feature is not yet implemented.');
        expect(err instanceof Error).toBe(true);
    });

    it('accepts custom message', () => {
        const err = new NotImplementedError('Custom msg');
        expect(err.message).toBe('Custom msg');
    });
});

describe('MarkdownConversionError', () => {
    it('has correct name and properties', () => {
        const err = new MarkdownConversionError('Bad token', 42, 'heading_open');
        expect(err.name).toBe('MarkdownConversionError');
        expect(err.message).toBe('Bad token');
        expect(err.markdownPosition).toBe(42);
        expect(err.tokenType).toBe('heading_open');
        expect(err instanceof Error).toBe(true);
    });
});
