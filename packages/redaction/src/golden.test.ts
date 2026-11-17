import { expect, it } from 'vitest';
import { createRedactor } from './index.js';
// Captured from the pre-extraction sanitizer at 401363f. Synthetic inputs only.
const cases = [
  {
    input: {
      input: {
        command: 'cat private-file',
      },
      output: 'private response',
      hostname: 'laptop',
      headers: {
        Authorization: 'Bearer short',
        cookie: 'session=short',
      },
      issue: {
        body: 'private issue body',
        user: {
          email: 'worker@example.com',
        },
      },
    },
    output:
      '{"input":"<redacted length=30 sha256=edfd60b90d219f689c35a51ad4330ddc836d3c69b7767f599ae0a081879af416>","output":"<redacted length=16 sha256=9cd735e88d7b015a099ee313b2de45bb1a120025e9549719e7efd6e15a465226>","hostname":"<redacted>","headers":{"Authorization":"<redacted>","cookie":"<redacted>"},"issue":{"body":"<redacted length=18 sha256=98e57292cec3d6b5ecfa20ecbaf98956e64da2471cac45a6a673c30fa7b40ad1>","user":{"email":"<redacted>"}}}',
  },
  {
    input: {
      value: 'worker@example.com',
      body: 'worker@example.com',
    },
    output:
      '{"value":"<redacted>","body":"<redacted length=18 sha256=b4b70e0ae1fbfe3284bd8aa1d6846ee9298e9d2418eaedf45a02d47f7e873c05>"}',
  },
  {
    input: {
      value: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      body: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    output:
      '{"value":"<redacted>","body":"<redacted length=40 sha256=ba94fef946060f5e556722d1f1f4e5e6de65a57de8a3f830c8f130b58031e523>"}',
  },
  {
    input: {
      value: 'aio_seat_ffffffffffffffffffffffffffffff',
      body: 'aio_seat_ffffffffffffffffffffffffffffff',
    },
    output:
      '{"value":"<redacted>","body":"<redacted length=39 sha256=ac9c30d0fa27f4dfb9c8d2ea41cb7d61f669f00bd19dfe8a3473647e777b7470>"}',
  },
  {
    input: {
      value: '測試🦀',
      body: '測試🦀',
    },
    output:
      '{"value":"測試🦀","body":"<redacted length=10 sha256=a53f445bd6c97d0b21f04c4989838bd6b8b12b14d3f17296dd9d57d5f37423b6>"}',
  },
  {
    input: {
      value: 'ordinary words',
      body: 'ordinary words',
    },
    output:
      '{"value":"ordinary words","body":"<redacted length=14 sha256=4bf1a3df87acb0f55aac81ba25f3b36b6e5711b1fde18a07d5d73697756de2a0>"}',
  },
  {
    input: {
      value: '-----BEGIN PRIVATE KEY-----\nABCDEF\n-----END PRIVATE KEY-----',
      body: '-----BEGIN PRIVATE KEY-----\nABCDEF\n-----END PRIVATE KEY-----',
    },
    output:
      '{"value":"<redacted>","body":"<redacted length=60 sha256=1ffb80744c1ce48a7b7ec24afbcedfdabd68b856b02c7699100275b700dd8759>"}',
  },
  {
    input: {
      value: '/Users/alice/work/repo',
      body: '/Users/alice/work/repo',
    },
    output:
      '{"value":"/Users/<redacted>/work/repo","body":"<redacted length=22 sha256=8073b814f5b71e88f12167f1953f2c85204949e9f7d94203cf7ab8db4430fdf4>"}',
  },
  {
    input: {
      value: 'C:\\Users\\alice\\work',
      body: 'C:\\Users\\alice\\work',
    },
    output:
      '{"value":"C:\\\\Users\\\\<redacted>\\\\work","body":"<redacted length=19 sha256=419648854e80c2e64a51d054434bc78a6fd17f5d3b125324bd19420f94d82414>"}',
  },
  {
    input: {
      value: 'https://github.com/ClarkeYeh/ai-office-spike/pull/3?token=short',
      body: 'https://github.com/ClarkeYeh/ai-office-spike/pull/3?token=short',
    },
    output:
      '{"value":"https://github.com/ClarkeYeh/ai-office-spike/pull/3?token=%3Credacted%3E","body":"<redacted length=63 sha256=a3cd31efc7a4d41fbe892f36a29fee801cb95d2dcfce569e9a3ebd152310c0ac>"}',
  },
  {
    input: {
      value: 'seat.status',
      body: 'seat.status',
    },
    output:
      '{"value":"seat.status","body":"<redacted length=11 sha256=1f4d0725a722c1b4e56af4077c5e3f2c4671743878920a04c4ec32bce8c08a27>"}',
  },
  {
    input: {
      value: '01JCZ8Q4V7XK3M9N2P5R6S8T0W',
      body: '01JCZ8Q4V7XK3M9N2P5R6S8T0W',
    },
    output:
      '{"value":"01JCZ8Q4V7XK3M9N2P5R6S8T0W","body":"<redacted length=26 sha256=f14115c0baf2dfc142ce3756acb204fea9f8248581b834f0d7da57ec0d0b9d08>"}',
  },
];
it.each(cases)(
  'matches pre-extraction output byte for byte %#',
  ({ input, output }) => {
    expect(
      JSON.stringify(
        createRedactor({
          preservedRepoUrls: ['https://github.com/ClarkeYeh/ai-office-spike'],
        }).sanitize(input),
      ),
    ).toBe(output);
  },
);
