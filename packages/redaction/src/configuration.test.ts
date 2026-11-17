import { expect, it } from 'vitest';
import {
  createRedactor,
  maskText,
  sanitize,
  hasLeaks,
  SECRET_PATTERNS,
} from './index.js';

it('preserves no URLs by default and isolates per-caller configuration', () => {
  const url = 'https://github.com/example/public-repo/pull/3';
  const roots = ['https://github.com/example/public-repo/'];
  const configured = createRedactor({ preservedRepoUrls: roots });
  roots.length = 0;
  expect(configured.maskText(url)).toBe(url);
  expect(configured.sanitize({ url })).toEqual({ url });
  expect(configured.hasLeaks({ url })).toBe(false);
  expect(maskText(url)).toBe('<redacted>');
  expect(sanitize({ url })).toEqual({ url: '<redacted>' });
  expect(hasLeaks({ url })).toBe(true);
  for (const unsafe of [
    url.replace('public-repo', 'public-repo-other'),
    url.replace('github.com', 'github.com.evil.net'),
    url.replace('https:', 'http:'),
  ])
    expect(configured.maskText(unsafe)).toBe('<redacted>');
});

it('supports multiple repository roots and still masks credentials', () => {
  const redactor = createRedactor({
    preservedRepoUrls: [
      'https://github.com/example/one',
      'https://github.com/example/two',
    ],
  });
  for (const repo of ['one', 'two']) {
    const result = redactor.maskText(
      `https://user:pass@github.com/example/${repo}/issues/1?token=short`,
    );
    expect(result).not.toMatch(/user|pass|short/);
    expect(result).toContain(`/example/${repo}/issues/1`);
    expect(redactor.maskText(result)).toBe(result);
  }
});

it.each([
  'not a URL',
  'http://github.com/a/b',
  'https://github.com',
  'https://user:pass@github.com/a/b',
  'https://github.com/a/b?token=short',
  'https://github.com/a/b#secret',
])('rejects invalid repository configuration %#', (value) => {
  expect(() => createRedactor({ preservedRepoUrls: [value] })).toThrow();
});

it('exports the shared seat-token pattern', () => {
  expect(
    SECRET_PATTERNS.some((pattern) =>
      new RegExp(pattern).test('aio_seat_synthetic'),
    ),
  ).toBe(true);
});
