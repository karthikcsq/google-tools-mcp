import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildModifyTextRequests } from './modifyText.js';

describe('buildModifyTextRequests', () => {
  it('generates deleteContentRange + insertText for a replacement', () => {
    const reqs = buildModifyTextRequests({
      startIndex: 5,
      endIndex: 10,
      text: 'hello',
    });
    assert.equal(reqs.length, 2);
    assert.deepEqual(reqs[0], {
      deleteContentRange: { range: { startIndex: 5, endIndex: 10 } },
    });
    assert.deepEqual(reqs[1], {
      insertText: { location: { index: 5 }, text: 'hello' },
    });
  });

  it('generates only insertText for an insertion (no endIndex)', () => {
    const reqs = buildModifyTextRequests({
      startIndex: 3,
      endIndex: undefined,
      text: 'hi',
    });
    assert.equal(reqs.length, 1);
    assert.deepEqual(reqs[0], {
      insertText: { location: { index: 3 }, text: 'hi' },
    });
  });

  it('returns empty array when no text/style/paragraphStyle given', () => {
    const reqs = buildModifyTextRequests({
      startIndex: 1,
      endIndex: 5,
    });
    assert.equal(reqs.length, 0);
  });

  it('includes tabId in range and location when provided', () => {
    const reqs = buildModifyTextRequests({
      startIndex: 1,
      endIndex: 4,
      text: 'x',
      tabId: 'tab1',
    });
    assert.deepEqual(reqs[0].deleteContentRange.range.tabId, 'tab1');
    assert.deepEqual(reqs[1].insertText.location.tabId, 'tab1');
  });
});

describe('escape sequence normalization (issue #9)', () => {
  // Simulate the normalization that happens in the execute handler
  function normalize(text) {
    return text?.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }

  it('converts literal \\n to real newline', () => {
    const input = 'line one\\nline two\\nline three';
    const result = normalize(input);
    assert.equal(result, 'line one\nline two\nline three');
  });

  it('converts literal \\t to real tab', () => {
    const input = 'col1\\tcol2\\tcol3';
    const result = normalize(input);
    assert.equal(result, 'col1\tcol2\tcol3');
  });

  it('handles mixed \\n and \\t', () => {
    const input = 'row1\\tcol2\\nrow2\\tcol2';
    const result = normalize(input);
    assert.equal(result, 'row1\tcol2\nrow2\tcol2');
  });

  it('leaves text without escape sequences unchanged', () => {
    const input = 'no escapes here';
    assert.equal(normalize(input), 'no escapes here');
  });

  it('preserves real newlines that are already in the string', () => {
    const input = 'already\nreal';
    assert.equal(normalize(input), 'already\nreal');
  });

  it('returns undefined for undefined input', () => {
    assert.equal(normalize(undefined), undefined);
  });
});
