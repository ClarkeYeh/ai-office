import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bodyHash } from './index.js';

const reference = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

describe('bodyHash (DP1)', () => {
  it('is the SHA-256 of the UTF-8 body', () => {
    expect(bodyHash('')).toBe(reference(''));
    // One-, two-, three- and four-byte UTF-8, and a lone surrogate (U+FFFD).
    for (const text of ['Decision ✅ 決定 🚀', 'café', 'x\ud800y'])
      expect(bodyHash(text)).toBe(reference(text));
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        expect(bodyHash(text)).toBe(reference(text.replace(/\r\n/g, '\n')));
      }),
    );
  });
  it('treats CRLF and LF line endings alike, and nothing else', () => {
    expect(bodyHash('a\r\nb\r\n')).toBe(bodyHash('a\nb\n'));
    expect(bodyHash('a\rb')).not.toBe(bodyHash('a\nb'));
    expect(bodyHash('a \nb')).not.toBe(bodyHash('a\nb'));
  });
});
