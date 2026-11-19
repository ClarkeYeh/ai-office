import { describe, expect, test } from 'vitest';
import { lineDiff } from './diff.js';

describe('lineDiff', () => {
  test('marks GitHub-only lines added and original-only lines removed', () => {
    const diff = lineDiff('a\nb\nc', 'a\nB\nc\nd');
    expect(diff.lines).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ]);
    expect(diff.same).toBe(false);
    expect(diff.truncated).toBe(false);
  });
  test('identical text, CRLF normalised', () => {
    const diff = lineDiff('x\r\ny', 'x\ny');
    expect(diff.same).toBe(true);
    expect(diff.lines.map((l) => l.kind)).toEqual(['same', 'same']);
  });
  test('trailing removals and the line cap', () => {
    expect(lineDiff('a\nb\nc', 'a').lines.map((l) => l.kind)).toEqual([
      'same',
      'removed',
      'removed',
    ]);
    const capped = lineDiff('1\n2\n3\n4', '1\n2\n3\n5', 2);
    expect(capped.truncated).toBe(true);
    expect(capped.lines).toHaveLength(2);
    expect(lineDiff('1', '1\n2\n3', 2).truncated).toBe(true);
  });
  test('stays linear enough for 2000-line bodies', () => {
    const big = Array.from({ length: 1999 }, (_, i) => `line ${i}`).join('\n');
    const diff = lineDiff(big, `${big}\nextra`);
    expect(diff.lines.filter((l) => l.kind === 'added')).toHaveLength(1);
  });
});
