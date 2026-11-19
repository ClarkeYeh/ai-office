import { expect, it } from 'vitest';
import { createRedactor } from '@ai-office/redaction';
import { GithubNormalizer } from './recording.js';
import { assertTapeSafe } from './tape-normalization.js';
import { githubRefRedactor } from './ref-redaction.js';

const ref = 'refs/heads/ai-office/t000000000001-encoded/path';
it('preserves only a validated test ref across both normalization passes and the leak scan', () => {
  const normalized = new GithubNormalizer('abcdef123456').value({
    ref: ref.replace('000000000001', 'abcdef123456'),
  });
  expect(normalized).toEqual({ ref });
  expect(() => assertTapeSafe(normalized)).not.toThrow();
  expect(createRedactor().hasLeaks(normalized)).toBe(true);
  expect(new GithubNormalizer().value({ body: ref })).not.toEqual({
    body: ref,
  });
  expect(githubRefRedactor(createRedactor()).hasLeaks({ token: { ref } })).toBe(
    true,
  );
});
it.each([
  ref + '/ghp_SyntheticSecret123456789',
  ref + '/github_pat_SyntheticSecret123456789',
  ref + '/user@example.org',
  ref + '/home/synthetic/private',
  ref + '/Users/synthetic/private',
  ref + '/../private',
  ref + '//private',
])('does not preserve unsafe or foreign refs (%#)', (value) => {
  expect(githubRefRedactor(createRedactor()).hasLeaks({ ref: value })).toBe(
    true,
  );
  expect(() => assertTapeSafe({ ref: value })).toThrow();
});

it('leaves foreign ref handling to production redaction without exceptions', () => {
  const base = createRedactor();
  for (const ref of [
    'refs/heads/main',
    'refs/heads/private/t000000000001-encoded/path',
    'refs/heads/ai-office/other-encoded/path',
  ])
    expect(githubRefRedactor(base).sanitize({ ref })).toEqual(
      base.sanitize({ ref }),
    );
});
