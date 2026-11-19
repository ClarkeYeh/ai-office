import { expect, it } from 'vitest';
import { TapeNormalizer, assertTapeSafe } from './tape-normalization.js';
import { API, ROOT, REPO } from './safety.js';

it('maps each distinct node consistently and keeps normalized URLs valid and scan-safe', () => {
  const normalize = new TapeNormalizer();
  const raw = {
    node_id: 'I_kwDOSynthetic123',
    url: `${API}${ROOT}/issues/42`,
    html_url: `https://github.com/${REPO}/issues/42`,
    user: {
      node_id: 'U_kwDOSynthetic456',
      avatar_url: 'https://avatars.githubusercontent.com/u/123?v=4',
    },
  };
  const first = normalize.value(raw);
  expect(first.node_id).toBe('NODE_000001');
  expect(first.user.node_id).toBe('NODE_000002');
  expect(normalize.value({ node_id: raw.node_id }).node_id).toBe(first.node_id);
  for (const url of [first.url, first.html_url, first.user.avatar_url])
    expect(new URL(url).protocol).toBe('https:');
  expect(first.url).toBe(`https://github.com/${REPO}/__api__/issues/42`);
  expect(new TapeNormalizer().value(first)).toEqual(first);
  expect(() => assertTapeSafe(first)).not.toThrow();
});

it.each([
  'ghp_' + 'SyntheticSecret123456789',
  'private.person@private.invalid',
  '/Users/synthetic/private',
  '/home/synthetic/private',
  'C:\\Users\\synthetic\\private',
])('rejects sensitive normalized metadata without logging it', (secret) => {
  expect(() => assertTapeSafe({ metadata: secret })).toThrow(
    'Tape leak scan failed',
  );
  expect(() => new TapeNormalizer().value({ node_id: secret })).toThrow();
  expect(() =>
    new TapeNormalizer().value({
      url: `${API}${ROOT}/issues?data=${encodeURIComponent(secret)}`,
    }),
  ).toThrow();
});
