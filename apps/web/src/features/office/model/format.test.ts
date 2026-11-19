import { describe, expect, test } from 'vitest';
import { iso, zhT } from '../../../test-support/office/log.js';
import { formatElapsed, formatTokens, listOf } from './format.js';
import { officeMessagesZhTW } from './messages.js';

describe('format', () => {
  test.each([
    [0, '0'],
    [-3, '0'],
    [999, '999'],
    [1000, '1k'],
    [1250, '1.3k'],
    [148_000, '148k'],
    [999_499, '999k'],
    [1_040_000, '1.04M'],
    [2_000_000, '2M'],
  ])('tokens %d → %s', (n, s) => {
    expect(formatTokens(n)).toBe(s);
  });

  test('elapsed', () => {
    const since = iso(0);
    expect(formatElapsed(zhT, since, 42_000)).toBe('42 秒');
    expect(formatElapsed(zhT, since, -5_000)).toBe('0 秒');
    expect(formatElapsed(zhT, since, 192_000)).toBe('3 分');
    expect(formatElapsed(zhT, since, 192_000, true)).toBe('3 分 12 秒');
    expect(formatElapsed(zhT, since, 720_000, true)).toBe('12 分');
    expect(formatElapsed(zhT, since, 3_900_000)).toBe('1 小時 5 分');
  });

  test('lists and the zh-TW table', () => {
    expect(listOf(zhT, ['a', 'b'])).toBe('a、b');
    for (const value of Object.values(officeMessagesZhTW))
      expect(value.trim()).not.toBe('');
  });
});
