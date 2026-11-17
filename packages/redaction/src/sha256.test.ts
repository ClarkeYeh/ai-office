import { createHash, randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { sha256 } from './sha256.js';
import { summarize } from './index.js';

// NIST SHA-256 examples, including multi-block and million-byte messages.
it.each([
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
  [
    'a'.repeat(1_000_000),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  ],
])('matches standard vector %#', (input, digest) => {
  expect(sha256(new TextEncoder().encode(input))).toBe(digest);
});

it('matches Node crypto for random bytes across block and padding boundaries', () => {
  for (const length of [
    ...Array.from({ length: 130 }, (_, i) => i),
    255,
    512,
    1024,
    4097,
  ]) {
    const bytes = randomBytes(length);
    expect(sha256(bytes)).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    const text = bytes.toString('utf8');
    expect(summarize(text)).toBe(
      `<redacted length=${Buffer.byteLength(text)} sha256=${createHash('sha256').update(text).digest('hex')}>`,
    );
  }
});
it.each([
  '測試🦀',
  '\ud800',
  '\udfff',
  'a\0b',
  { nested: ['測試', true, null] },
])('summarizes UTF-8 and JSON consistently %#', (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  expect(summarize(value)).toBe(
    `<redacted length=${Buffer.byteLength(text)} sha256=${createHash('sha256').update(text).digest('hex')}>`,
  );
});
