import { describe, expect, it } from 'vitest';
import { scmTitle } from './scm-title.js';

describe('scmTitle', () => {
  it.each([
    ['Short title', 'Short title'],
    [
      '\n \r\n  First\t  non-empty line  \r\nMore details',
      'First non-empty line',
    ],
    ['\u2028\u2029Title\u2028Details', 'Title'],
    [' \t\n', 'Untitled'],
    ['字'.repeat(120), '字'.repeat(120)],
    ['字'.repeat(121), '字'.repeat(119) + '…'],
    ['😀'.repeat(61), '😀'.repeat(59) + '…'],
    ['a'.repeat(118) + '😀more', 'a'.repeat(118) + '…'],
  ])('derives %j deterministically', (source, expected) => {
    expect(scmTitle(source)).toBe(expected);
    expect(scmTitle(source)).toBe(scmTitle(source));
    expect(scmTitle(source).length).toBeLessThanOrEqual(120);
    expect(scmTitle(source)).not.toMatch(/[\uD800-\uDFFF]/u);
  });
  it('uses the adapter cap and preserves exact-boundary input', () => {
    expect(scmTitle('😀'.repeat(128), 256)).toBe('😀'.repeat(128));
    expect(scmTitle('😀'.repeat(129), 256)).toBe('😀'.repeat(127) + '…');
    expect(scmTitle('a'.repeat(254) + '😀more', 256)).toBe(
      'a'.repeat(254) + '…',
    );
    expect(scmTitle('abc def', 5)).toBe('abc…');
  });
  it.each([0, 1, 1.5, NaN, Infinity])('rejects invalid limit %s', (limit) => {
    expect(() => scmTitle('title', limit)).toThrow(RangeError);
  });
});
